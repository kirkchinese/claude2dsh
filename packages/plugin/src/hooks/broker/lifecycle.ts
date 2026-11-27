/**
 * The hook broker's session lifecycle and turn events.
 * @module @kirkchinese/harness-forge
 */
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { contextsOf, specific } from '../output.js'
import { CONTEXT_SOURCE, type HookEngine } from './engine.js'
import { lastAssistantText, textOf } from './helpers.js'
import { messageOf } from '../../shared/util.js'
import type { SessionEvents } from './session-events.js'
import type { AgentLike, PreStepDecision, PreStepPayload } from './types.js'

/**
 * Session lifecycle and turns: SessionStart, SubagentStart and SessionEnd as
 * agents come and go; UserPromptSubmit, UserPromptExpansion, PostToolBatch,
 * PreModelRequest and Stop / SubagentStop around each turn and step.
 */
export class SessionLifecycle {
  constructor(private readonly engine: HookEngine, private readonly events: SessionEvents) {}

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  async agentCreated({ agent, source, signal }: { agent: AgentLike; source: string; signal?: AbortSignal }): Promise<void> {
    const depth = agent.session.header.delegationDepth ?? 0
    if (depth > 0) {
      await this.subagentStart(agent, signal ?? this.engine.lifetime.signal)
      return
    }
    this.live.set(agent.session.header.id, agent)
    if (this.engine.host.prepareSession !== undefined) {
      try {
        await this.engine.host.prepareSession(agent, await this.engine.directory(agent, signal ?? this.engine.lifetime.signal))
      } catch (error: unknown) {
        this.engine.notice(agent, { kind: 'hook-error', event: 'SessionStart', plugin: 'harness-forge', text: `project assets not loaded: ${messageOf(error)}` })
      }
    }
    if (!this.engine.has('SessionStart')) return
    const envFile = this.engine.envFile(agent.session, 'session')
    const results = await this.engine.run({
      event: 'SessionStart',
      agent,
      signal: signal ?? this.engine.lifetime.signal,
      subject: source,
      fields: { source, model: agent.options?.model },
    }, { envFile })
    for (const ran of results) {
      const hso = specific(ran.decoded)
      const title = hso?.['sessionTitle']
      if (typeof title === 'string' && title.length > 0 && source !== 'clear' && source !== 'compact') this.engine.rename(agent, title)
      const watchPaths = hso?.['watchPaths']
      if (Array.isArray(watchPaths)) this.events.setWatchPaths(agent, watchPaths.map(String))
      if (hso?.['reloadSkills'] === true) this.engine.host.reloadSkills?.()
      if (ran.decoded.block !== undefined) this.engine.notice(agent, { kind: 'hook-error', event: 'SessionStart', subject: source, plugin: ran.source.pluginId, text: ran.decoded.block })
    }
    this.engine.noticeAll(agent, 'SessionStart', source, results)
    const contexts = this.engine.contexts('SessionStart', results)
    for (const text of contexts) agent.inject(this.engine.contextMessage(agent, 'SessionStart', text))
    this.events.startWatching(agent)
  }

  private async subagentStart(child: AgentLike, signal: AbortSignal): Promise<void> {
    const preset = this.engine.presetOf(child)
    const scoped = preset === undefined ? undefined : this.engine.host.agentHooks?.(preset)
    if (scoped !== undefined) this.engine.add({ ...scoped, origin: 'agent', agentSessionId: child.session.header.id })
    if (!this.engine.has('SubagentStart')) return
    const agentType = this.engine.agentTypeOf(child)
    const results = await this.engine.run({
      event: 'SubagentStart',
      agent: child,
      signal,
      subject: agentType,
      fields: { agent_id: child.session.header.id, agent_type: agentType },
    })
    this.engine.noticeAll(child, 'SubagentStart', agentType, results)
    for (const ran of results) {
      if (ran.decoded.block !== undefined) this.engine.notice(child, { kind: 'hook-error', event: 'SubagentStart', subject: agentType, plugin: ran.source.pluginId, text: ran.decoded.block })
    }
    for (const text of this.engine.contexts('SubagentStart', results)) child.inject(this.engine.contextMessage(child, 'SubagentStart', text))
  }

  /** Root agents whose session has not ended yet. */
  private readonly live = new Map<string, AgentLike>()
  /** Sessions whose SessionEnd ran at shutdown: DSH disposing their agent afterwards does not end them again. */
  private readonly endedAtShutdown = new Set<string>()

  /**
   * DSH is shutting down: every session still open ends, and its SessionEnd hooks run, as Claude Code runs them
   * when it exits. (DSH disposes Harness Forge before its agents, so agent/disposed would come too late.)
   */
  endLive(): void {
    for (const agent of [...this.live.values()]) {
      this.agentDisposed(agent)
      this.endedAtShutdown.add(agent.session.header.id)
    }
  }

  agentDisposed(agent: AgentLike): void {
    const id = agent.session.header.id
    if (this.endedAtShutdown.has(id)) return
    this.live.delete(id)
    const state = this.engine.sessions.get(id)
    for (const watcher of state?.watchers ?? []) watcher.close()
    this.engine.sessions.delete(id)
    clearTimeout(this.engine.idleTimers.get(id))
    this.engine.idleTimers.delete(id)
    for (const [key, source] of this.engine.sources) {
      if (source.agentSessionId === id) this.engine.sources.delete(key)
    }
    // A session's own sources (project hooks, invoked skills) still see its SessionEnd.
    const forget = (): void => {
      // SessionEnd's own run recreated the session's state (its payload reads it): drop it again.
      this.engine.sessions.delete(id)
      for (const [key, source] of this.engine.sources) if (source.sessionId === id) this.engine.sources.delete(key)
      void this.engine.host.releaseSession?.(id)
    }
    if ((agent.session.header.delegationDepth ?? 0) > 0 || !this.engine.has('SessionEnd')) {
      forget()
      return
    }
    const budget = this.engine.sessionEndBudget()
    const ending: Promise<unknown> = this.engine.run({
      event: 'SessionEnd',
      agent,
      signal: AbortSignal.timeout(budget),
      subject: 'other',
      fields: { reason: 'other' },
      cwd: this.engine.committedDirectory(agent) ?? agent.session.header.cwd ?? process.cwd(),
      defaultTimeoutMs: this.engine.sessionEndDefault(),
    }).then((results) => {
      for (const ran of results) {
        if (ran.decoded.block !== undefined) this.engine.notice(agent, { kind: 'hook-error', event: 'SessionEnd', subject: 'other', plugin: ran.source.pluginId, text: ran.decoded.block })
      }
    }).catch(() => undefined).finally(() => {
      this.engine.ending.delete(ending)
      forget()
    })
    this.engine.ending.add(ending)
    this.engine.track(ending)
  }

  // -------------------------------------------------------------------------
  // Turns and steps
  // -------------------------------------------------------------------------

  /**
   * An imported slash command was typed: `UserPromptSubmit` sees the typed
   * line, then `UserPromptExpansion` sees the command. Returns the block
   * message, or the context to send with the expanded prompt.
   */
  async expandCommand(
    agent: AgentLike,
    command: { readonly name: string; readonly foreignName: string; readonly args: string; readonly expanded: string },
    signal: AbortSignal,
  ): Promise<{ blocked?: string; context: string[] }> {
    const typed = `/${command.name}${command.args.length > 0 ? ` ${command.args}` : ''}`
    const context: string[] = []
    if (this.engine.has('UserPromptSubmit')) {
      const submit = await this.promptSubmitHooks(agent, typed, signal)
      if (submit.blocked !== undefined) return { blocked: submit.blocked, context: [] }
      context.push(...submit.context)
    }
    if (this.engine.has('UserPromptExpansion')) {
      const results = await this.engine.run({
        event: 'UserPromptExpansion',
        agent,
        signal,
        subjects: [command.foreignName, command.name],
        fields: { expansion_type: 'slash_command', command_name: command.foreignName, command_args: command.args, command_source: 'plugin', prompt: typed },
      })
      const blocked = this.engine.blockOf('UserPromptExpansion', results)
      if (this.engine.stopOf(results) !== undefined || blocked !== undefined) {
        this.engine.noticeAll(agent, 'UserPromptExpansion', command.foreignName, results)
        return { blocked: blocked ?? this.engine.stopOf(results) ?? 'blocked by a UserPromptExpansion hook', context: [] }
      }
      this.engine.noticeAll(agent, 'UserPromptExpansion', command.foreignName, results)
      context.push(...this.engine.contexts('UserPromptExpansion', results))
    }
    const reminders = context.map(text => this.engine.reminder(agent, 'UserPromptExpansion', text))
    // The submitted message is the expanded prompt followed by these reminders; UserPromptSubmit already saw the typed line.
    this.engine.state(agent.session).expanded.add(command.expanded + reminders.join(''))
    return { context: reminders }
  }

  /**
   * The user typed `/skill args`: `UserPromptExpansion` sees the skill (the
   * typed line already went through `UserPromptSubmit`). Returns the block
   * message, or the reminders to send with the skill content.
   */
  async expandSkill(
    agent: AgentLike,
    skill: { readonly name: string; readonly foreignName: string; readonly args: string; readonly source: string },
    signal: AbortSignal,
  ): Promise<{ blocked?: string; context: string[] }> {
    if (!this.engine.has('UserPromptExpansion')) return { context: [] }
    const typed = `/${skill.name}${skill.args.length > 0 ? ` ${skill.args}` : ''}`
    const results = await this.engine.run({
      event: 'UserPromptExpansion',
      agent,
      signal,
      subjects: [skill.foreignName, skill.name],
      fields: { expansion_type: 'slash_command', command_name: skill.foreignName, command_args: skill.args, command_source: skill.source, prompt: typed },
    })
    this.engine.noticeAll(agent, 'UserPromptExpansion', skill.foreignName, results)
    const blocked = this.engine.blockOf('UserPromptExpansion', results) ?? this.engine.stopOf(results)
    if (blocked !== undefined) return { blocked, context: [] }
    return { context: this.engine.contexts('UserPromptExpansion', results).map(text => this.engine.reminder(agent, 'UserPromptExpansion', text)) }
  }

  async preStep(payload: PreStepPayload, next: () => Promise<PreStepDecision>): Promise<PreStepDecision> {
    const { agent } = payload
    const state = this.engine.state(agent.session)
    const firstStep = state.lastTurn !== payload.turn
    const root = (agent.session.header.delegationDepth ?? 0) === 0
    if (firstStep) {
      state.lastTurn = payload.turn
      state.promptId = randomUUID()
      state.stopActive = false
      state.stopContinuations = 0
      state.batch = []
      clearTimeout(this.engine.idleTimers.get(agent.session.header.id))
      this.engine.idleTimers.delete(agent.session.header.id)
    }
    let contexts: unknown[] = []
    if (firstStep && root && this.engine.has('UserPromptSubmit')) {
      const prompt = textOf(payload.messages.filter(message => message.source?.kind !== 'harness-forge').flatMap(message => message.content))
      if (prompt.length > 0 && !state.expanded.delete(prompt)) {
        const submit = await this.promptSubmitHooks(agent, prompt, payload.signal)
        if (submit.blocked !== undefined) return { kind: 'reject' }
        contexts = submit.context.map(text => this.engine.contextMessage(agent, 'UserPromptSubmit', text))
      }
    }
    if (!firstStep && state.batch.length > 0 && this.engine.has('PostToolBatch')) {
      const toolCalls = state.batch
      state.batch = []
      const results = await this.engine.run({ event: 'PostToolBatch', agent, signal: payload.signal, fields: { tool_calls: toolCalls } })
      this.engine.noticeAll(agent, 'PostToolBatch', undefined, results)
      const stop = this.engine.stopOf(results) ?? this.engine.blockOf('PostToolBatch', results) ?? this.engine.modelBlock(results, false)
      if (stop !== undefined) {
        this.engine.notice(agent, { kind: 'stopped', event: 'PostToolBatch', plugin: results[0]?.source.pluginId ?? '', text: stop })
        return { kind: 'reject' }
      }
      contexts.push(...this.engine.contexts('PostToolBatch', results).map(text => this.engine.contextMessage(agent, 'PostToolBatch', text)))
    }
    if (this.engine.has('PreModelRequest')) {
      this.engine.track(this.engine.run({ event: 'PreModelRequest', agent, signal: this.engine.lifetime.signal, fields: { model: agent.options?.model } }))
    }
    const downstream = await next()
    if (contexts.length === 0 || downstream.kind !== 'enter') return downstream
    return { ...downstream, messages: [...downstream.messages ?? [], ...contexts] }
  }

  /** Run UserPromptSubmit for one prompt; block messages become notices. */
  private async promptSubmitHooks(agent: AgentLike, prompt: string, signal: AbortSignal): Promise<{ blocked?: string; context: string[] }> {
    const results = await this.engine.run({ event: 'UserPromptSubmit', agent, signal, fields: { prompt }, defaultTimeoutMs: 30_000 })
    for (const ran of results) {
      const title = specific(ran.decoded)?.['sessionTitle']
      if (typeof title === 'string' && title.length > 0) this.engine.rename(agent, title)
    }
    this.engine.noticeAll(agent, 'UserPromptSubmit', undefined, results)
    const stop = this.engine.stopOf(results)
    const blocked = stop ?? this.engine.blockOf('UserPromptSubmit', results) ?? this.engine.modelBlock(results, false)
    if (blocked !== undefined) {
      const suppress = results.some(ran => specific(ran.decoded)?.['suppressOriginalPrompt'] === true)
      const text = suppress ? blocked : `${blocked}\n\nOriginal prompt: ${prompt}`
      this.engine.notice(agent, { kind: stop !== undefined ? 'stopped' : 'blocked', event: 'UserPromptSubmit', plugin: results[0]?.source.pluginId ?? '', text })
      return { blocked: text, context: [] }
    }
    return { context: this.engine.contexts('UserPromptSubmit', results) }
  }

  async turnStopping({ agent, signal }: { agent: AgentLike; turn: number; signal: AbortSignal }): Promise<void> {
    const child = (agent.session.header.delegationDepth ?? 0) > 0
    const event = child ? 'SubagentStop' : 'Stop'
    if (!child) this.events.armIdle(agent)
    if (!this.engine.has(event) && !(child && this.engine.hasAgentStop(agent))) return
    const state = this.engine.state(agent.session)
    const agentType = child ? this.engine.agentTypeOf(agent) : undefined
    const results = await this.engine.run({
      event,
      agent,
      signal,
      ...(agentType !== undefined ? { subject: agentType } : {}),
      fields: {
        stop_hook_active: state.stopActive,
        last_assistant_message: lastAssistantText(agent.session),
        background_tasks: [],
        session_crons: [],
        ...(child ? {
          agent_id: agent.session.header.id,
          agent_type: agentType,
          agent_transcript_path: this.engine.transcripts.path(agent.session, this.engine.committedDirectory(agent) ?? agent.session.header.cwd ?? process.cwd()),
        } : {}),
      },
    })
    this.engine.noticeAll(agent, event, agentType, results)
    if (this.engine.stopOf(results) !== undefined) {
      state.stopActive = false
      return
    }
    const reasons: string[] = []
    for (const ran of results) {
      const verdict = ran.verdict
      if (verdict !== undefined && !verdict.ok && verdict.impossible !== true) reasons.push(verdict.reason ?? `${event} hook condition not met`)
      if (ran.decoded.block !== undefined) reasons.push(ran.decoded.block)
      else if (ran.decoded.json?.['decision'] === 'block') reasons.push(String(ran.decoded.json['reason'] ?? `${event} hook asked to continue`))
    }
    const feedback = results.flatMap(ran => contextsOf(event, ran.source.dialect, ran.decoded))
    if (reasons.length === 0 && feedback.length === 0) {
      state.stopActive = false
      state.stopContinuations = 0
      return
    }
    const cap = Number(process.env['CLAUDE_CODE_STOP_HOOK_BLOCK_CAP'] ?? 8)
    if (state.stopContinuations >= (Number.isFinite(cap) && cap > 0 ? cap : 8)) {
      // The count resets on the next tool call or the next turn, not here.
      this.engine.notice(agent, { kind: 'hook-error', event, plugin: results[0]?.source.pluginId ?? '', text: `${event} hooks continued the turn ${String(state.stopContinuations)} times in a row; ending the turn` })
      state.stopActive = false
      return
    }
    state.stopActive = true
    state.stopContinuations += 1
    const dialect = results[0]?.source.dialect ?? 'claude-code'
    const text = [
      ...reasons.map(reason => dialect === 'codex' ? reason : `${event} hook feedback:\n${reason}`),
      ...feedback.map(item => `${event} hook feedback:\n${item}`),
    ].join('\n\n')
    agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: { ...CONTEXT_SOURCE, event } }))
  }
}
