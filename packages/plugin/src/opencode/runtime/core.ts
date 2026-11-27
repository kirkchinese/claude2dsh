/**
 * The OpenCode runtime's shared state: running plugins, hooks, events and DSH
 * facts.
 * @module @kirkchinese/harness-forge/opencode
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { readOpenCodeConfig } from '@kirkchinese/harness-forge-core'
import { isRecord, type LoggedEvent, type SessionFacts } from '../convert.js'
import { dshService, presetOfSession } from '../../dsh/host.js'
import type { Agent, Agents, Message, OpenCodeRuntimeHost, PluginHost } from './types.js'
import { messageOf } from '../../shared/util.js'

/** Hooks whose throw stops the work they precede (OpenCode's documented way to refuse). */
const STOPPING_HOOKS = new Set(['tool.execute.before', 'command.execute.before'])

/** How long a plugin gets to answer a hook or an event before it counts as failed. */
export const RPC_DEADLINE_MS = 30_000

/** What a call to a plugin host may be given besides its body. */
export interface PostOptions {
  /** The deadline in milliseconds; `null` for none (a tool call runs as long as the tool does). */
  readonly timeoutMs?: number | null
  readonly signal?: AbortSignal
}

/**
 * What every part of the OpenCode runtime shares: the running plugins, how
 * their hooks are raised and events published, and DSH's facts in OpenCode's
 * terms.
 */
export class OpenCodeCore {
  readonly hosts = new Map<string, PluginHost>()
  readonly waiting = new Map<string, { resolve(body: Record<string, unknown>): void; reject(error: Error): void }>()
  readonly streams = new Set<ServerResponse>()
  /** Prompts plugins sent while a `chat.message` of that session ran: they enter before its message. */
  readonly admitting = new Map<string, Message[]>()
  /** Sessions a plugin created, which it may delete. */
  readonly created = new Map<string, { dispose(): Promise<void>; parentId?: string }>()
  private readonly projects = new Map<string, { id: string; worktree: string; created: number }>()

  constructor(readonly ctx: Context, readonly host: OpenCodeRuntimeHost, readonly deadlineMs: number = RPC_DEADLINE_MS) {}

  /** Whether any running plugin has a hook. */
  has(hook: string): boolean {
    for (const plugin of this.hosts.values()) if (plugin.hooks.has(hook)) return true
    return false
  }

  // ---------------------------------------------------------------------------
  // Hooks and events
  // ---------------------------------------------------------------------------

  /**
   * Run one hook of every plugin that has it, in load order, on one output.
   * A plugin refuses by throwing from a `.before` hook (`error`, which ends the
   * chain); a plugin that crashes, does not answer in time or cannot be reached
   * has failed, not refused: the fault is recorded, that plugin is skipped and
   * the chain goes on.
   * @returns the output after them all, the refusal if there was one, and the faults met.
   */
  async trigger(name: string, input: unknown, output: Record<string, unknown>): Promise<{ output: Record<string, unknown>; error?: string; faults: string[] }> {
    let current = output
    const faults: string[] = []
    for (const plugin of [...this.hosts.values()]) {
      if (!plugin.hooks.has(name)) continue
      let answer: Record<string, unknown>
      try {
        answer = await this.post(plugin, '/hook', { name, input, output: current })
      } catch (error: unknown) {
        // The host is unreachable or too slow: a runtime failure, never a refusal.
        const detail = messageOf(error)
        faults.push(detail)
        if (plugin.stopping !== true) {
          this.host.observe(plugin.componentId, `opencode:${name}`, false, detail)
          this.host.observe(plugin.componentId, `opencode:${name}:failed`, false, detail)
        }
        continue
      }
      current = isRecord(answer['output']) ? answer['output'] : current
      const thrown = typeof answer['error'] === 'string' ? answer['error'] : undefined
      // Throwing is how a `.before` hook stops the call or command: the hook did its job.
      const refused = thrown !== undefined && STOPPING_HOOKS.has(name) && answer['errorKind'] !== 'crash'
      if (Number(answer['ran'] ?? 0) > 0) {
        const failed = thrown !== undefined && !refused
        this.host.observe(plugin.componentId, `opencode:${name}`, !failed, refused ? `stopped it: ${String(thrown)}` : failed ? String(thrown) : `${name} ran`)
        // A failure stays on record: a later success under the same signal would replace it.
        if (failed) this.host.observe(plugin.componentId, `opencode:${name}:failed`, false, String(thrown))
      }
      if (thrown === undefined) continue
      if (refused) return { output: current, error: thrown, faults }
      faults.push(thrown)
    }
    return { output: current, faults }
  }

  /** Publish one OpenCode event: to the event stream and every plugin's `event` hook. */
  emit(event: Record<string, unknown>): void {
    const frame = `data: ${JSON.stringify(event)}\n\n`
    for (const stream of this.streams) stream.write(frame)
    for (const plugin of this.hosts.values()) {
      if (!plugin.hooks.has('event')) continue
      plugin.events = plugin.events.then(async () => {
        const answer: Record<string, unknown> = await this.post(plugin, '/event', { event }).catch((error: unknown) => ({ ok: false, error: messageOf(error), unreached: true }))
        const ok = answer['ok'] === true
        // An event the stopping host could no longer take is not something the plugin did wrong (an answer it gave is).
        if (answer['unreached'] === true && plugin.stopping === true) return
        this.host.observe(plugin.componentId, 'opencode:event', ok, ok ? `received ${String(event['type'])}` : `${String(event['type'])}: ${String(answer['error'] ?? 'failed')}`)
        if (!ok) this.host.observe(plugin.componentId, 'opencode:event:failed', false, `${String(event['type'])}: ${String(answer['error'] ?? 'failed')}`)
      })
    }
  }

  /** One call to a plugin's Bun host; it fails when the host does not answer within the deadline. */
  async post(plugin: PluginHost, path: string, body: unknown, options: PostOptions = {}): Promise<Record<string, unknown>> {
    const timeoutMs = options.timeoutMs === undefined ? this.deadlineMs : options.timeoutMs
    const signals = [...(timeoutMs === null ? [] : [AbortSignal.timeout(timeoutMs)]), ...(options.signal === undefined ? [] : [options.signal])]
    try {
      const response = await fetch(`${plugin.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(signals.length > 0 ? { signal: AbortSignal.any(signals) } : {}) })
      const parsed = await response.json() as unknown
      return isRecord(parsed) ? parsed : {}
    } catch (error: unknown) {
      if (timeoutMs !== null && signals[0]?.aborted === true && options.signal?.aborted !== true) throw new Error(`the plugin did not answer ${path} in ${String(Math.round(timeoutMs / 1000))}s`)
      throw error
    }
  }

  // ---------------------------------------------------------------------------
  // DSH facts
  // ---------------------------------------------------------------------------

  agents(): Agents | undefined {
    return dshService(this.ctx, 'agents') as Agents | undefined
  }

  agentOf(agent: Agent): string {
    const id = presetOfSession(this.ctx, agent.session)
    if (id !== undefined) return this.host.agentName(id) ?? id
    return (agent.session.header.delegationDepth ?? 0) > 0 ? 'general' : 'build'
  }

  facts(agent: Agent): SessionFacts {
    const header = agent.session.header
    const cwd = header.cwd ?? process.cwd()
    const project = this.projectOf(cwd)
    const created = typeof header.createdAt === 'number' ? header.createdAt : typeof header.createdAt === 'string' ? Date.parse(header.createdAt) : Date.now()
    const titles = dshService(this.ctx, 'sessionTitle') as { get(session: unknown): { title?: string } | undefined } | undefined
    let title = ''
    try {
      title = titles?.get(agent.session)?.title ?? ''
    } catch {
      title = ''
    }
    const parentId = header.parentSession ?? this.created.get(header.id)?.parentId
    return {
      id: header.id,
      cwd,
      projectId: project.id,
      worktree: project.worktree,
      ...(parentId !== undefined ? { parentId } : {}),
      title,
      created,
      updated: Date.now(),
      provider: agent.options?.provider ?? '',
      model: agent.options?.model ?? '',
      agent: this.agentOf(agent),
    }
  }

  events(agent: Agent): LoggedEvent[] {
    const events: LoggedEvent[] = []
    for (let seq = 0; seq < agent.session.seq; seq++) {
      const event = agent.session.eventAt(seq)
      if (event !== undefined) events.push(event)
    }
    return events
  }

  /** OpenCode's project of a directory: the git worktree and its first commit, else `global`. */
  projectOf(directory: string): { id: string; worktree: string; created: number } {
    const cached = this.projects.get(directory)
    if (cached !== undefined) return cached
    const git = (...args: string[]): string | undefined => {
      const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 10_000 })
      return result.status === 0 ? result.stdout.trim() : undefined
    }
    const worktree = git('rev-parse', '--show-toplevel')
    const first = worktree === undefined ? undefined : git('rev-list', '--max-parents=0', '--all')?.split(/\r?\n/u).filter(Boolean).sort()[0]
    const project = { id: first ?? 'global', worktree: worktree === undefined ? directory : resolve(worktree), created: Date.now() }
    this.projects.set(directory, project)
    return project
  }

  /** The OpenCode configuration in effect for a directory: global, then project files, later winning. */
  configFor(directory: string): Record<string, unknown> {
    const configHome = process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config')
    const merged: Record<string, unknown> = {}
    for (const root of [join(configHome, 'opencode'), this.projectOf(directory).worktree, join(this.projectOf(directory).worktree, '.opencode'), directory, join(directory, '.opencode')]) {
      const config = readOpenCodeConfig(root)
      if (config !== undefined) mergeConfig(merged, config)
    }
    const selection = this.defaultModel()
    if (merged['model'] === undefined && selection !== undefined) merged['model'] = `${selection.provider}/${selection.model}`
    return merged
  }

  /** OpenCode's stored provider credentials (`auth.json`). */
  storedAuth(): Record<string, unknown> {
    const dataHome = process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share')
    const path = join(dataHome, 'opencode', 'auth.json')
    if (!existsSync(path)) return {}
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
      return isRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  defaultModel(): { provider: string; model: string } | undefined {
    const service = dshService(this.ctx, 'agentDefaultModel') as { currentSelection(): { provider: string; model: string } } | undefined
    try {
      const selected = service?.currentSelection()
      if (selected !== undefined) return selected
    } catch {
      // No default model yet.
    }
    const root = this.agents()?.roots()[0]
    return root?.options?.provider !== undefined && root.options.model !== undefined ? { provider: root.options.provider, model: root.options.model } : undefined
  }
}

/** Deep-merge OpenCode configuration: objects merge, `plugin`/`plugins`/`instructions` concatenate, the rest is replaced. */
function mergeConfig(into: Record<string, unknown>, from: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(from)) {
    const current = into[key]
    if ((key === 'plugin' || key === 'plugins' || key === 'instructions') && Array.isArray(value)) into[key] = [...(Array.isArray(current) ? current : []), ...value]
    else if (isRecord(value) && isRecord(current)) mergeConfig(current, value)
    else into[key] = isRecord(value) ? structuredClone(value) : value
  }
}

