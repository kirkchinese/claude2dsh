/**
 * Per-session mod loading and the session host.
 * @module @kirkchinese/harness-forge/mods
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { appendRecord } from '../../dsh/session-records.js'
import { appendNotice } from '../../hooks/notice.js'
import { ModsEngine, type CoreContext, type EngineHost } from '../engine.js'
import { SessionHost, type SessionAgent } from '../host.js'
import { evaluateBundle, createEnvironment, realmOf } from '../loader.js'
import { OPS } from '../ops.js'
import { SessionSurfaces, type SurfaceSnapshot } from '../surfaces.js'
import { elementTable } from '../runtime.js'
import { isRecord, messageOf } from '../values.js'
import { dshService } from '../../dsh/host.js'
import { selectRoute } from '../../dsh/model-route.js'
import type { ClaudeVerdict, ModSource, ModsServiceHost, SessionMods, ToolExec } from './types.js'

/** What a session's engine and host reach in the other parts of the mods service. */
export interface SessionWiring {
  registerCommand(session: SessionMods, plugin: string, spec: Record<string, unknown>): () => void
  toolCore(session: SessionMods, e: Record<string, unknown>, context: CoreContext): Promise<unknown>
  checkCore(session: SessionMods, e: Record<string, unknown>): ClaudeVerdict
}

/**
 * The live sessions' mods: each root session's engine and host, the mods
 * loaded into it, and what the engine does beneath the hooks.
 */
export class SessionRegistry {
  readonly sources = new Map<string, ModSource>()
  readonly sessions = new Map<string, SessionMods>()
  /** Who watches a session's drawings, by session id: they follow the session across the agents it is given. */
  readonly watchers = new Map<string, Set<(snapshot: SurfaceSnapshot) => void>>()
  /** The latest drawing generation of each session, so a new agent's drawings number on from it. */
  private readonly generations = new Map<string, number>()
  /** The model a mod chose for a starting subagent (`agent.spawn`), by the child's session. */
  private readonly childRoutes = new Map<string, { provider?: string; model?: string; reasoningEffort?: string }>()
  /** Model choices waiting for the next child a parent session starts. */
  readonly spawnRoutes = new Map<string, Array<{ provider?: string; model?: string; reasoningEffort?: string }>>()

  constructor(readonly ctx: Context, readonly host: ModsServiceHost, private readonly wiring: SessionWiring) {}

  /** Add a mod: loaded into every live session now and every session after. Returns the removal. */
  async add(source: ModSource): Promise<() => Promise<void>> {
    this.sources.set(source.name, source)
    for (const session of this.sessions.values()) await this.loadInto(session, [source])
    return async () => {
      if (this.sources.get(source.name) !== source) return
      this.sources.delete(source.name)
      const removed = { sessions: 0, commands: 0, panes: 0 }
      let error: string | undefined
      for (const session of this.sessions.values()) {
        try {
          const one = await this.unloadFrom(session, source.name)
          removed.sessions += 1
          removed.commands += one.commands
          removed.panes += one.panes
        } catch (cause: unknown) {
          error = messageOf(cause)
        }
      }
      this.recordDisposal(source, removed, error)
    }
  }

  /** Take one mod out of a live session: its hooks and timers, the commands it registered, the panes it opened. */
  private async unloadFrom(session: SessionMods, name: string): Promise<{ commands: number; panes: number }> {
    await session.engine.unload(name)
    let commands = 0
    for (const [command, owner] of [...session.commandOwners]) {
      if (owner !== name) continue
      session.commands.get(command)?.()
      session.commands.delete(command)
      session.commandOwners.delete(command)
      commands += 1
    }
    const panes = session.surfaces.list().filter(pane => pane.plugin === name)
    for (const pane of panes) session.surfaces.close(pane.id)
    return { commands, panes: panes.length }
  }

  private recordDisposal(source: ModSource, removed: { sessions: number; commands: number; panes: number }, error: string | undefined): void {
    if (this.host.disposedLog === undefined) return
    try {
      mkdirSync(dirname(this.host.disposedLog), { recursive: true })
      appendFileSync(this.host.disposedLog, `${JSON.stringify({ componentId: source.componentId, mod: source.name, ok: error === undefined, ...removed, ...(error !== undefined ? { error } : {}), at: new Date().toISOString() })}\n`)
    } catch {
      // Evidence only.
    }
  }

  /** The loaded mods of a session, for evidence and the workbench. */
  loaded(sessionId: string): readonly string[] {
    return this.sessions.get(sessionId)?.engine.mods.map(mod => mod.ref.name) ?? []
  }

  /**
   * The process is going away: every live session's mods hear
   * `session.end` (reason `other`), as Claude Code's do at exit.
   */
  async shutdown(): Promise<void> {
    const live = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(live.map(session => Promise.race([
      session.engine.raise('session.end', { reason: 'other', sessionId: session.agent.session.header.id, resume: { kind: 'none' } }).catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, 5_000).unref()),
    ]).finally(() => { this.close(session) })))
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  private isRoot(agent: NonNullable<ToolExec['agent']>): boolean {
    return (agent.session.header.delegationDepth ?? 0) === 0 && agent.session.header.parentSession === undefined
  }

  /** The root session a (sub)agent's events belong to, and the subagent's id. */
  sessionOf(agent: ToolExec['agent']): { session: SessionMods; agentId?: string } | undefined {
    if (agent === undefined) return undefined
    const own = this.sessions.get(agent.session.header.id)
    if (own !== undefined) return { session: own }
    let parent = agent.session.header.parentSession
    const agents = dshService(this.ctx, 'agents') as { get(id: string): ToolExec['agent'] } | undefined
    for (let depth = 0; parent !== undefined && depth < 16; depth++) {
      const session = this.sessions.get(parent)
      if (session !== undefined) return { session, agentId: agent.session.header.id }
      parent = agents?.get(parent)?.session.header.parentSession
    }
    return undefined
  }

  async created(agent: NonNullable<ToolExec['agent']>, signal: AbortSignal | undefined): Promise<void> {
    const parent = agent.session.header.parentSession
    const waiting = parent === undefined ? undefined : this.spawnRoutes.get(parent)
    const route = waiting?.shift()
    if (route !== undefined) {
      this.childRoutes.set(agent.session.header.id, route)
      selectRoute(agent, route)
    }
    if (!this.isRoot(agent)) return
    const interactive = dshService(this.ctx, 'userQuestions') !== undefined
    const host = new SessionHost({
      ctx: this.ctx,
      shell: this.host.shell,
      storeRoot: this.host.storeRoot,
      directory: (target, abort) => this.host.directory(target, abort),
      settings: source => this.host.settings(agent.session.header, source),
      show: (kind, plugin, text) => { this.show(agent, kind, plugin, text) },
      pane: (plugin, action, args) => (action === 'open' ? session.surfaces.open(plugin, args) : (session.surfaces.close(String(args['id'] ?? '')), { isPlaced: true })),
      panes: () => session.surfaces.list(),
      registerCommand: (plugin, spec) => this.wiring.registerCommand(session, plugin, spec),
      invalidate: () => { session.surfaces.invalidate() },
    }, agent, interactive)
    const engine = new ModsEngine(this.engineHost(() => session))
    const surfaces = new SessionSurfaces({
      raise: (event, input) => engine.raise(event, input),
      report: (line) => { this.report(line) },
      isWorking: () => session.turns.size > 0,
      detached: (fn) => { engine.outside(fn) },
    }, this.generations.get(agent.session.header.id) ?? 0)
    const sessionId = agent.session.header.id
    surfaces.watch((snapshot) => {
      this.generations.set(sessionId, snapshot.generation)
      for (const listener of [...this.watchers.get(sessionId) ?? []]) listener(snapshot)
    })
    const session: SessionMods = { agent, engine, host, surfaces, calls: new Map(), checks: new Map(), turns: new Map(), commands: new Map(), commandOwners: new Map(), nativeCommands: [], recorded: new Set(), isContextRaised: false, ready: Promise.resolve() }
    // A session given a new agent (a resumed one, when the person acts): the previous agent's mods close now.
    const previous = this.sessions.get(sessionId)
    if (previous !== undefined && previous.agent !== agent) this.close(previous)
    this.sessions.set(sessionId, session)
    session.ready = (async () => {
      await this.loadInto(session, [...this.sources.values()])
      if (session.engine.mods.length === 0) return
      const cwd = await this.host.directory(agent, signal ?? new AbortController().signal).catch(() => agent.session.header.cwd ?? process.cwd())
      await engine.raise('session.start', { cwd, surface: interactive ? 'desktop' : null, isInteractive: interactive }).catch((error: unknown) => {
        this.report(`session.start: ${messageOf(error)}`)
      })
      if (hasHooks(engine, 'ui.render')) session.surfaces.invalidate()
    })()
    await session.ready
  }

  private async loadInto(session: SessionMods, sources: readonly ModSource[]): Promise<void> {
    if (sources.length === 0) return
    const definitions = sources.map((source) => {
      const environment = createEnvironment()
      const exports = evaluateBundle(source.bundle, environment)
      const register = exports['register'] ?? exports['default']
      return {
        name: source.name,
        tier: source.tier,
        root: source.root,
        options: source.options,
        provenance: source.provenance,
        uses: source.uses,
        realm: realmOf(environment),
        ...(source.version !== undefined ? { version: source.version } : {}),
        ...(source.refusal !== undefined ? { refusal: source.refusal } : typeof register !== 'function' ? { refusal: 'the hooks module exports no register(on, options)' } : {}),
        register: (typeof register === 'function' ? register : () => {}) as (on: unknown, options: unknown) => unknown,
      }
    })
    const result = await session.engine.load(definitions)
    for (const refused of result.refused) appendNotice(session.agent.session, { kind: 'hook-error', event: 'plugin.register', plugin: refused.name, text: `${refused.name} was refused by ${refused.by}: ${refused.reason}` })
    for (const failed of result.failed) appendNotice(session.agent.session, { kind: 'hook-error', event: 'plugin.register', plugin: failed.name, text: `${failed.name}: hooks module did not load: ${failed.error}` })
  }

  disposed(agent: NonNullable<ToolExec['agent']>): void {
    const session = this.sessions.get(agent.session.header.id)
    // The session may already have its next agent; only this agent's mods go.
    if (session === undefined || session.agent !== agent) return
    this.sessions.delete(agent.session.header.id)
    void session.engine.raise('session.end', { reason: 'other', sessionId: agent.session.header.id, resume: { kind: 'none' } })
      .catch(() => undefined)
      .finally(() => { this.close(session) })
  }

  close(session: SessionMods): void {
    session.surfaces.dispose()
    session.engine.dispose()
    for (const withdraw of session.host.registrations) withdraw()
    for (const withdraw of session.commands.values()) withdraw()
  }

  private report(line: string): void {
    this.ctx.logger.warn(`harness-forge mods: ${line}`)
  }

  private show(agent: SessionAgent, kind: 'transcript' | 'debug' | 'toast' | 'status', plugin: string, text: string | undefined): void {
    if (kind === 'debug') {
      this.ctx.logger.debug(`${plugin}: ${text ?? ''}`)
      return
    }
    if (text === undefined) return
    appendNotice(agent.session, { kind: kind === 'transcript' ? 'system-message' : 'feedback', event: `ui.${kind === 'transcript' ? 'log' : kind}`, plugin, text: `${plugin}: ${text}` })
  }

  // ---------------------------------------------------------------------------
  // Core: what the engine does beneath the hooks
  // ---------------------------------------------------------------------------

  private engineHost(session: () => SessionMods): EngineHost {
    return {
      core: (event, e, context) => this.core(session(), event, e, context),
      report: (line) => { this.report(line) },
      elements: (surface, _component, plugin) => elementTable(surface, plugin),
      ran: (mod, event) => { this.ran(session(), mod, event) },
      // A drawing that read state is drawn again when the state changes.
      stateWritten: () => { session().surfaces.invalidate() },
    }
  }

  /** Record, once per session, that a mod's hook ran for an event. */
  private ran(session: SessionMods, mod: string, event: string): void {
    const key = `${mod}\u0000${event}`
    if (session.recorded.has(key)) return
    session.recorded.add(key)
    try {
      appendRecord(session.agent.session, 'plugin:harness-forge/mod-event', { mod, event })
    } catch {
      // Evidence only.
    }
    const source = this.sources.get(mod)
    if (source !== undefined) this.host.observe(source.componentId, event)
  }

  private async core(session: SessionMods, event: string, e: unknown, context: CoreContext): Promise<unknown> {
    const input = isRecord(e) ? e : {}
    const op = OPS[event]
    if (op !== undefined && op.kind !== 'event') {
      const answer = await session.host.op(event, input, context)
      // A mod's own `$` call reached the host and was answered: evidence that its code uses the host's API.
      const source = context.mod === undefined ? undefined : this.sources.get(context.mod.ref.name)
      if (source !== undefined && !(isRecord(answer) && typeof answer['deny'] === 'string')) this.host.observe(source.componentId, `call:${event}`)
      return answer
    }
    if (event === 'clock.after' || event === 'clock.every') return session.host.op(event, input, context)
    switch (event) {
      case 'plugin.register': return { allow: true }
      case 'session.start': return { cwd: input['cwd'] }
      case 'session.end': return { sessionId: input['sessionId'] }
      case 'turn.start': return { turnId: input['turnId'] }
      case 'turn.complete': return { text: '' }
      case 'prompt.submit': {
        if (context.mod !== undefined) {
          // A mod's own submission: the text arrives as the next prompt, its sender named unless asUser.
          const text = String(input['text'] ?? '')
          const framed = input['asUser'] === true ? text : `Message from the "${context.mod.ref.name}" mod:\n${text}`
          session.agent.followup(createUserMessage({ content: [{ type: 'text', text: framed }], source: { kind: 'user' } }))
          return { text: framed }
        }
        return { text: input['text'], ...(Array.isArray(input['context']) ? { context: input['context'] } : {}) }
      }
      case 'prompt.context': return { blocks: input['blocks'] ?? [], ...(input['instructionFiles'] !== undefined ? { instructionFiles: input['instructionFiles'] } : {}) }
      case 'command.run': {
        const name = String(input['command'] ?? '')
        if (session.commands.has(name)) return { text: `no command.run hook answered /${name}` }
        const native = context.mod === undefined ? session.nativeCommands.at(-1) : undefined
        if (native !== undefined) return native(name, String(input['args'] ?? ''))
        return session.host.runCommand(name, String(input['args'] ?? ''), context.signal)
      }
      case 'agent.spawn': {
        // The run starts in DSH's own delegation; a changed model applies to the child it creates.
        const model = typeof input['model'] === 'string' ? input['model'] : undefined
        return { model: model ?? String(input['parentModel'] ?? '') }
      }
      case 'tool.call': return this.wiring.toolCore(session, input, context)
      case 'tool.check': return this.wiring.checkCore(session, input)
      case 'session.append': return session.host.appendNote(context.mod?.ref.name ?? 'engine', input)
      case 'ui.render': return { type: 'engine', ref: 0 }
      case 'ui.press':
      case 'ui.input':
      case 'ui.select': return session.surfaces.runCallback(event, input)
      case 'ui.focus':
      case 'ui.scroll': return {}
      case 'agent.offer': return { isOffered: true }
      case 'tool.describe': return { description: input['description'] ?? '' }
      case 'command.describe': return { description: input['description'] ?? '', isHidden: input['isHidden'] === true }
      case 'skill.prompt':
      case 'attribution.text':
      case 'prompt.section':
      case 'prompt.attachment': return { text: input['text'] ?? null }
      case 'prompt.compose': return { sections: [] }
      case 'session.compact': return { skip: 'this session compacts on DSH\'s own schedule' }
      default:
        if (event.startsWith('classic.')) return {}
        throw new Error(`${event} is not served by this host`)
    }
  }
}

export function hasHooks(engine: ModsEngine, event: string): boolean {
  return engine.registered.some(hook => hook.pattern === event || hook.pattern === '*' || (hook.pattern.endsWith('.*') && event.startsWith(hook.pattern.slice(0, -1))) || (hook.pattern.startsWith('!') && hook.pattern.slice(1) !== event))
}
