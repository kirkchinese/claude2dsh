/**
 * The hook broker's engine: every matching handler of one occurrence run in
 * its own dialect, the combined outcome, notices and environment files.
 * @module @kirkchinese/harness-forge
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import { conditionMatches } from '../condition.js'
import type { CommandHandler, HookHandler } from '../config.js'
import { matcherSelects } from '../matcher.js'
import { appendNotice, terminalNotification, type HookNotice } from '../notice.js'
import { contextsOf, decodeAsyncRun, decodeRun, specific, type Decoded } from '../output.js'
import { HandlerRunner, type HandlerOutcome, type HandlerPlaces } from '../runner.js'
import { TranscriptMirror } from '../transcript.js'
import { foreignResponse, foreignTool, type ForeignTool, type HookDialect } from '../vocabulary.js'
import { dshService, lastTurnOf, planModeActive, presetOfSession } from '../../dsh/host.js'
import { appendRecord, recordHookInvoked, recordHookResult } from '../../dsh/session-records.js'
import { isRecord } from './helpers.js'
import type { AgentLike, HookBrokerHost, HookSource, Occurrence, Ran, SessionLike, SessionState, WorkingDirectoryLike } from './types.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'harness-forge': { kind: 'harness-forge'; readonly event?: string } & ContextFormed
  }
}

export const CONTEXT_SOURCE = { kind: 'harness-forge' } as const
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied'])
const MODEL_HANDLER_EVENTS = new Set(['PermissionDenied', 'PostToolBatch', 'PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'Stop', 'SubagentStop', 'TaskCompleted', 'TaskCreated', 'TeammateIdle', 'UserPromptExpansion', 'UserPromptSubmit'])
const NO_FAILURE_BLOCK = new Set(['Stop', 'SubagentStop', 'TaskCompleted', 'TeammateIdle'])
const ENV_FILE_EVENTS = new Set(['SessionStart', 'Setup', 'CwdChanged', 'FileChanged'])
const CONTEXT_LIMIT = 10_000
const PREVIEW_LIMIT = 2_000
const DEFAULT_TIMEOUT_MS = 600_000
const MAX_PARALLEL_MODEL_HANDLERS = 12

/**
 * The broker's shared engine: the registered sources, per-session state, the
 * handler runs and how their outcomes combine, notices, environment files and
 * the host facts every part of the broker reads.
 */
export class HookEngine {
  readonly sources = new Map<string, HookSource>()
  readonly sessions = new Map<string, SessionState>()
  private readonly runner: HandlerRunner
  readonly transcripts: TranscriptMirror
  readonly detached = new Set<Promise<unknown>>()
  readonly ending = new Set<Promise<unknown>>()
  readonly lifetime = new AbortController()
  private readonly onceDone = new Set<string>()
  readonly notifyTimers = new Map<string, NodeJS.Timeout>()
  readonly idleTimers = new Map<string, NodeJS.Timeout>()

  constructor(readonly ctx: Context, readonly host: HookBrokerHost) {
    this.runner = new HandlerRunner(ctx, host.shell, agent => host.environment?.((agent as AgentLike | undefined)?.session.header) ?? {}, call => host.mcpToolPolicy?.(call))
    this.transcripts = new TranscriptMirror(join(host.dataRoot, 'transcripts'), {
      agentName: id => host.agentName(id),
    })
  }

  /** Register one source; the returned disposer removes it. */
  add(source: HookSource): () => void {
    const key = source.sessionId !== undefined || source.agentSessionId !== undefined
      ? `${source.componentId}@${source.sessionId ?? source.agentSessionId ?? ''}`
      : source.componentId
    this.sources.set(key, source)
    return () => { this.sources.delete(key) }
  }

  // -------------------------------------------------------------------------
  // Running handlers
  // -------------------------------------------------------------------------

  has(event: string): boolean {
    // `disableAllHooks: true` in global settings turns every hook off; a project's is checked per run.
    if (this.host.hooksDisabled?.() === true) return false
    for (const source of this.sources.values()) {
      if (source.table.has(event)) return true
      if (event === 'SubagentStop' && source.agentSessionId !== undefined && source.table.has('Stop')) return true
    }
    return false
  }

  hasAgentStop(agent: AgentLike): boolean {
    for (const source of this.sources.values()) if (source.agentSessionId === agent.session.header.id && source.table.has('Stop')) return true
    return false
  }

  /**
   * Run every matching handler of one occurrence in parallel and decode the
   * synchronous ones. Background handlers deliver their output later.
   */
  async run(occurrence: Occurrence & { response?: { value: unknown; text: string } }, extra: { envFile?: string } = {}): Promise<Ran[]> {
    if (this.host.hooksDisabled?.(occurrence.agent?.session.header) === true) return []
    const agent = occurrence.agent
    const cwd = occurrence.cwd ?? (agent !== undefined ? await this.directory(agent, occurrence.signal) : process.cwd())
    const jobs: Array<() => Promise<Ran | undefined>> = []
    const settingsSeen = new Set<string>()
    let modelHandlers = 0
    for (const source of [...this.sources.values()]) {
      if (!this.sourceApplies(source, agent)) continue
      const groups = [
        ...source.table.get(occurrence.event) ?? [],
        ...(occurrence.event === 'SubagentStop' && source.agentSessionId !== undefined ? source.table.get('Stop') ?? [] : []),
      ]
      if (groups.length === 0) continue
      const tool = occurrence.tool === undefined ? undefined : foreignTool(source.dialect, occurrence.tool.dshName, occurrence.tool.args, this.toolContext(agent, cwd))
      for (const [groupIndex, group] of groups.entries()) {
        const subjects = tool?.aliases ?? occurrence.subjects ?? [occurrence.subject ?? '']
        if (!matcherSelects(source.dialect, occurrence.event, group.matcher, subjects)) continue
        // The tool name the hook sees: the alias its matcher selected, else the canonical name.
        const toolName = tool === undefined ? undefined : (group.matcher === undefined || group.matcher === '' || group.matcher === '*'
          ? tool.name
          : tool.aliases.find(alias => matcherSelects(source.dialect, occurrence.event, group.matcher, [alias])) ?? tool.name)
        for (const [handlerIndex, handler] of group.handlers.entries()) {
          if (handler.type === 'invalid') {
            this.host.observe({ componentId: source.componentId, event: occurrence.event, ok: false, detail: handler.reason })
            continue
          }
          if (!handlerSupported(occurrence.event, handler.type, source.dialect)) continue
          if (handler.condition !== undefined) {
            if (!TOOL_EVENTS.has(occurrence.event) || tool === undefined) continue
            if (!conditionMatches(handler.condition, tool, cwd)) continue
          }
          const onceKey = `${source.componentId}\0${occurrence.event}\0${JSON.stringify(handler)}\0${source.sessionId ?? ''}`
          if (handler.once === true && source.origin === 'skill' && this.onceDone.has(onceKey)) continue
          if (source.origin === 'settings') {
            const key = `${occurrence.event}\0${JSON.stringify(handler)}`
            if (settingsSeen.has(key)) continue
            settingsSeen.add(key)
          }
          if (handler.type === 'prompt' || handler.type === 'agent') modelHandlers++
          const view = tool === undefined ? undefined : { ...tool, name: toolName ?? tool.name }
          const slot = { id: `g${String(groupIndex)}h${String(handlerIndex)}`, ...(group.matcher !== undefined ? { matcher: group.matcher } : {}) }
          const job = (): Promise<Ran | undefined> => this.runHandler(source, handler, occurrence, view, cwd, extra.envFile, slot).then((ran) => {
            if (ran !== undefined && handler.once === true && source.origin === 'skill' && ran.decoded.error === undefined && ran.decoded.block === undefined) this.onceDone.add(onceKey)
            return ran
          })
          jobs.push(job)
        }
      }
    }
    const results = modelHandlers > MAX_PARALLEL_MODEL_HANDLERS ? await limited(jobs, MAX_PARALLEL_MODEL_HANDLERS) : await Promise.all(jobs.map(job => job()))
    return results.filter((ran): ran is Ran => ran !== undefined)
  }

  private async runHandler(
    source: HookSource,
    handler: Exclude<HookHandler, { type: 'invalid' }>,
    occurrence: Occurrence & { response?: { value: unknown; text: string } },
    tool: ForeignTool | undefined,
    cwd: string,
    envFile: string | undefined,
    slot: { readonly id: string; readonly matcher?: string } = { id: 'g0h0' },
  ): Promise<Ran | undefined> {
    const agent = occurrence.agent
    const background = handler.type === 'command' && (handler.async === true || handler.asyncRewake === true) && !(source.dialect === 'codex' && occurrence.event === 'SessionEnd')
    const payload = this.payload(source, occurrence, tool, cwd)
    const places: HandlerPlaces = {
      pluginRoot: source.pluginRoot,
      dataDir: source.dataDir,
      projectDir: (agent?.session.header.cwd ?? cwd),
      cwd: existingDirectory(cwd, agent?.session.header.cwd),
      options: source.options ?? {},
      ...(envFile !== undefined && ENV_FILE_EVENTS.has(occurrence.event) ? { envFile } : {}),
    }
    const timeoutMs = this.timeoutFor(occurrence, handler, source.dialect)
    const label = handlerLabel(handler)
    const turn = agent === undefined ? 0 : this.lastTurn(agent) ?? 0
    // Which group and handler of the event's table ran (`g<group>h<handler>`): evidence per handler, not per event.
    const handlerId = `${source.componentId}:${occurrence.event}:${slot.id}:${randomUUID().slice(0, 8)}`
    if (agent !== undefined) {
      try {
        recordHookInvoked(agent.session, { turn, point: occurrence.event, dialect: source.dialect, handlerId, ...(slot.matcher !== undefined ? { matcher: slot.matcher } : {}) })
      } catch {
        // A closed session still runs the hook.
      }
    }
    const request = {
      event: occurrence.event,
      dialect: source.dialect,
      payload,
      places,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      signal: background ? this.lifetime.signal : occurrence.signal,
      ...(agent !== undefined ? { agent } : {}),
    }
    const execute = (): Promise<HandlerOutcome> => {
      switch (handler.type) {
        case 'command': return this.runner.command(handler, request)
        case 'http': return this.runner.http(handler, request)
        case 'mcp_tool': return this.runner.mcpTool(handler, request, this.host.mcpHookServer?.(source.pluginId, handler.server, agent?.session.header.id))
        case 'prompt': return this.runner.prompt(handler, request)
        case 'agent': return this.runner.agent(handler, request)
      }
    }
    const record = (outcome: HandlerOutcome, decoded: Decoded): void => {
      const ok = decoded.error === undefined
      this.host.observe({ componentId: source.componentId, event: occurrence.event, ok, detail: ok ? `exit ${String(outcome.exitCode ?? 0)}` : decoded.error ?? 'failed' })
      // SessionEnd runs as the session (or DSH) closes, when its log may no longer take records: kept beside it too.
      if (occurrence.event === 'SessionEnd' && agent !== undefined) {
        try {
          mkdirSync(this.host.dataRoot, { recursive: true })
          appendFileSync(join(this.host.dataRoot, 'session-ends.jsonl'), `${JSON.stringify({ sessionId: agent.session.header.id, handlerId, exitCode: outcome.exitCode ?? null, ok, at: new Date().toISOString() })}\n`)
        } catch {
          // Evidence only.
        }
      }
      if (agent === undefined) return
      try {
        recordHookResult(agent.session, {
          turn,
          point: occurrence.event,
          handlerId,
          output: { exitCode: outcome.exitCode, stderr: outcome.stderr || (decoded.error ?? (decoded.cancelled === true ? 'cancelled' : '')), stdout: outcome.stdout, ...(decoded.block !== undefined ? { decision: 'block' as const } : {}) },
          stderrSummaryMaxChars: 2000,
          durationMs: outcome.durationMs,
        })
        // What the handler answered, so its effect can be checked against what the session then did.
        if (decoded.json !== undefined || decoded.block !== undefined || (decoded.plain !== undefined && decoded.plain.trim().length > 0)) {
          appendRecord(agent.session, 'plugin:harness-forge/hook-output', {
            handlerId,
            event: occurrence.event,
            ...(occurrence.tool?.callId !== undefined ? { callId: occurrence.tool.callId } : {}),
            ...(decoded.block !== undefined ? { block: decoded.block.slice(0, 2000) } : {}),
            ...(decoded.json !== undefined ? { json: JSON.parse(JSON.stringify(decoded.json)) as Record<string, unknown> } : {}),
            ...(decoded.plain !== undefined && decoded.plain.trim().length > 0 ? { plain: decoded.plain.slice(0, 2000) } : {}),
          } as never)
        }
      } catch {
        // The session no longer accepts records.
      }
    }
    if (background) {
      this.track(execute().then((outcome) => {
        const decoded = decodeAsyncRun(occurrence.event, source.dialect, outcome)
        record(outcome, decoded)
        if (agent !== undefined) this.deliverAsync(agent, source, handler as CommandHandler, occurrence.event, decoded, outcome)
      }))
      return undefined
    }
    const outcome = await execute()
    const decoded = decodeRun(occurrence.event, source.dialect, outcome)
    record(outcome, decoded)
    if (decoded.cancelled === true) return undefined
    let failureBlock: string | undefined
    if (decoded.failed && !NO_FAILURE_BLOCK.has(occurrence.event) && this.blocksOnFailure(handler, occurrence.event)) {
      const verb = outcome.failure?.kind === 'timeout' ? 'timed out' : 'failed'
      const why = handler.type === 'command' && handler.onFailure === undefined
        ? "blocking because Git Bash wasn't found, so only exit code 0 or 2 counts as this hook's verdict."
        : 'blocking because onFailure is "block"'
      failureBlock = `${occurrence.event}${tool !== undefined ? `:${tool.name}` : ''} hook error: [${label}]: ${verb}; ${why}\n${decoded.error ?? ''}`.trim()
    }
    if (outcome.suspectCapture === true && this.allows(occurrence.event, decoded)) {
      failureBlock = `${occurrence.event} hook error: [${label}]: refusing to honor the suspect capture (a background process kept the hook's output open after it printed an allow)`
    }
    const blocked = failureBlock !== undefined && decoded.block === undefined ? { ...decoded, block: failureBlock } : decoded
    return {
      source,
      handler,
      decoded: blocked,
      ...(outcome.verdict !== undefined ? { verdict: outcome.verdict } : {}),
      ...(failureBlock !== undefined ? { failureBlock } : {}),
      label,
      ...(tool !== undefined ? { toolName: tool.name } : {}),
    }
  }

  /** Whether a failed run of this handler blocks the action. */
  private blocksOnFailure(handler: Exclude<HookHandler, { type: 'invalid' }>, event: string): boolean {
    if (handler.type !== 'command' && handler.type !== 'http') return false
    if (handler.onFailure === 'block') return true
    if (handler.onFailure === 'continue' || handler.type !== 'command') return false
    // Windows without Git Bash: a shell-form PreToolUse/PermissionRequest hook only passes on 0 or 2.
    return process.platform === 'win32' && this.host.shell.bash === undefined && handler.args === undefined && handler.shell === undefined
      && (event === 'PreToolUse' || event === 'PermissionRequest')
  }

  /** Whether a decoded output allows the action outright. */
  private allows(event: string, decoded: Decoded): boolean {
    const hso = specific(decoded)
    if (event === 'PreToolUse') return hso?.['permissionDecision'] === 'allow' || decoded.json?.['decision'] === 'approve'
    if (event === 'PermissionRequest') return isRecord(hso?.['decision']) && hso['decision']['behavior'] === 'allow'
    return false
  }

  /** Deliver a background run: context and system message on the next model request; asyncRewake wakes the agent on exit 2. */
  private deliverAsync(agent: AgentLike, source: HookSource, handler: CommandHandler, event: string, decoded: Decoded, outcome: HandlerOutcome): void {
    if (decoded.error !== undefined) this.notice(agent, { kind: 'hook-error', event, plugin: source.pluginId, text: decoded.error })
    if (handler.asyncRewake === true && outcome.exitCode === 2) {
      const findings = outcome.stderr.trim() || outcome.stdout.trim()
      const text = `${handler.rewakeMessage ?? `${event} hook (background) reported:`}\n${findings}`
      agent.steer(createUserMessage({ content: [{ type: 'text', text: this.reminder(agent, event, text) }], source: { ...CONTEXT_SOURCE, event } }))
      return
    }
    const texts: string[] = []
    const additional = specific(decoded)?.['additionalContext']
    if (typeof additional === 'string' && additional.length > 0) texts.push(additional)
    const system = decoded.json?.['systemMessage']
    if (typeof system === 'string' && system.length > 0) texts.push(system)
    if (texts.length === 0) return
    if (event === 'SessionStart') {
      const state = this.state(agent.session)
      const key = `${source.componentId}\0${handlerLabel(handler)}`
      const joined = texts.join('\n')
      if (state.asyncSessionStart.get(key) === joined) return
      state.asyncSessionStart.set(key, joined)
    }
    for (const text of texts) agent.inject(this.contextMessage(agent, event, text))
  }

  /** The stdin payload / POST body of one handler. */
  private payload(source: HookSource, occurrence: Occurrence & { response?: { value: unknown; text: string } }, tool: ForeignTool | undefined, cwd: string): Record<string, unknown> {
    const agent = occurrence.agent
    const child = agent !== undefined && (agent.session.header.delegationDepth ?? 0) > 0
    const parent = child ? this.agentOf(agent.session.header.parentSession ?? '') : undefined
    // Subagent events and tool events inside a subagent name the main session and its transcript.
    const sessionAgent = parent ?? agent
    const state = sessionAgent === undefined ? undefined : this.state(sessionAgent.session)
    const effort = agent?.options?.reasoningEffort
    const out: Record<string, unknown> = {
      session_id: sessionAgent?.session.header.id ?? '',
      transcript_path: sessionAgent === undefined ? null : this.transcripts.path(sessionAgent.session, cwd),
      cwd,
      ...(sessionAgent !== undefined ? { permission_mode: this.permissionMode(sessionAgent, source.dialect) } : {}),
      hook_event_name: occurrence.event,
      ...(state?.promptId !== undefined && source.dialect === 'claude-code' ? { prompt_id: state.promptId } : {}),
      ...(effort !== undefined && ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort) ? { effort: { level: effort } } : {}),
      ...(child && occurrence.event !== 'SubagentStart' && occurrence.event !== 'SubagentStop' ? { agent_id: agent.session.header.id, agent_type: this.agentTypeOf(agent) } : {}),
      ...(source.dialect === 'codex' ? { model: agent?.options?.model ?? null, ...(agent !== undefined ? { turn_id: String(this.lastTurn(agent) ?? 0) } : {}) } : {}),
    }
    if (tool !== undefined) {
      out['tool_name'] = tool.name
      out['tool_input'] = tool.input
      if (tool.dshName.startsWith('mcp__')) out['mcp_server'] = { name: tool.dshName.split('__')[1] ?? '', source: 'plugin' }
      if (occurrence.response !== undefined) {
        out['tool_response'] = foreignResponse(source.dialect, tool.dshName, occurrence.tool?.args, occurrence.response.value, occurrence.response.text)
      }
    }
    for (const [key, value] of Object.entries(occurrence.fields ?? {})) if (value !== undefined) out[key] = value
    if (occurrence.event === 'PermissionRequest') delete out['tool_use_id']
    return out
  }

  private timeoutFor(occurrence: Occurrence, handler: Exclude<HookHandler, { type: 'invalid' }>, dialect: HookDialect): number | undefined {
    if (handler.type === 'command' && handler.async === true && handler.asyncRewake !== true) return undefined
    const codexShort = dialect === 'codex' && (occurrence.event === 'SessionEnd' || occurrence.event === 'Interrupt')
    if (handler.timeoutSec !== undefined) {
      const ms = handler.timeoutSec * 1000
      return codexShort ? Math.min(Math.max(ms, 1000), 3000) : ms
    }
    if (handler.type === 'prompt') return 30_000
    if (handler.type === 'agent') return 60_000
    if (codexShort) return 1000
    return occurrence.defaultTimeoutMs ?? (occurrence.event === 'MessageDisplay' ? 10_000 : DEFAULT_TIMEOUT_MS)
  }

  /** The SessionEnd budget: 1.5 s, raised by settings hooks' own timeouts up to 60 s, or the env override. */
  sessionEndBudget(): number {
    const override = Number(process.env['CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS'])
    if (Number.isFinite(override) && override > 0) return override
    let budget = 1500
    for (const source of this.sources.values()) {
      if (source.origin !== 'settings') continue
      for (const group of source.table.get('SessionEnd') ?? []) {
        for (const handler of group.handlers) if (handler.timeoutSec !== undefined) budget = Math.max(budget, Math.min(handler.timeoutSec * 1000, 60_000))
      }
    }
    return budget
  }

  sessionEndDefault(): number {
    const override = Number(process.env['CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS'])
    return Number.isFinite(override) && override > 0 ? override : 1500
  }

  // -------------------------------------------------------------------------
  // Combining outcomes
  // -------------------------------------------------------------------------

  /** The first `continue: false`, as its stop reason. */
  stopOf(results: readonly Ran[]): string | undefined {
    const ran = results.find(item => item.decoded.json?.['continue'] === false)
    if (ran === undefined) return undefined
    const reason = ran.decoded.json?.['stopReason']
    return typeof reason === 'string' && reason.length > 0 ? reason : `stopped by a ${ran.handler.type} hook`
  }

  /** A top-level `decision: "block"` or a blocking exit, as the block reason. */
  blockOf(event: string, results: readonly Ran[]): string | undefined {
    for (const ran of results) {
      if (ran.decoded.block !== undefined) return ran.decoded.block
      if (ran.decoded.json?.['decision'] === 'block') return String(ran.decoded.json['reason'] ?? `blocked by a ${event} hook`)
    }
    return undefined
  }

  /** A prompt/agent `ok: false`. */
  modelBlock(results: readonly Ran[], continueOnBlock: boolean): string | undefined {
    for (const ran of results) {
      if (ran.verdict === undefined || ran.verdict.ok) continue
      if (continueOnBlock && ran.handler.type !== 'agent' && (ran.handler as { continueOnBlock?: boolean }).continueOnBlock !== true) continue
      return ran.verdict.reason ?? 'blocked by a hook'
    }
    return undefined
  }

  /** Every context string the runs add for the model. */
  contexts(event: string, results: readonly Ran[]): string[] {
    return results.flatMap(ran => contextsOf(event, ran.source.dialect, ran.decoded).map(text => this.bound(ran.source, text)))
  }

  /** Apply the 10,000-character cap (Codex: `additionalContextLimit` tokens): spill to a file with a preview. */
  private bound(source: HookSource, text: string): string {
    const limit = source.dialect === 'codex' ? 2500 * 4 : CONTEXT_LIMIT
    if (text.length <= limit) return text
    const dir = join(this.host.dataRoot, 'hook-output')
    const path = join(dir, `${randomUUID()}.txt`)
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(path, text)
    } catch {
      return text.slice(0, limit)
    }
    return `Output too large (${String(text.length)} characters). Full output saved to: ${path}\n\nPreview (first ${String(PREVIEW_LIMIT)} characters):\n${text.slice(0, PREVIEW_LIMIT)}`
  }

  /** Notices for hook errors, system messages and terminal notifications of every run. */
  noticeAll(agent: AgentLike, event: string, subject: string | undefined, results: readonly Ran[]): void {
    for (const ran of results) {
      const base = { event, ...(subject !== undefined ? { subject } : {}), plugin: ran.source.pluginId }
      if (ran.decoded.error !== undefined) this.notice(agent, { ...base, kind: 'hook-error', text: `${event}${subject !== undefined ? `:${subject}` : ''} hook error: [${ran.label}]: ${ran.decoded.error}` })
      const system = ran.decoded.json?.['systemMessage']
      if (typeof system === 'string' && system.length > 0 && !DISCARDS_SYSTEM_MESSAGE.has(event)) this.notice(agent, { ...base, kind: 'system-message', text: system })
      const sequence = ran.decoded.json?.['terminalSequence']
      if (typeof sequence === 'string') {
        const notification = terminalNotification(sequence)
        if (notification !== undefined) this.notice(agent, { ...base, kind: 'terminal', text: JSON.stringify(notification) })
      }
    }
  }

  notice(agent: AgentLike | undefined, notice: HookNotice): void {
    if (agent !== undefined) appendNotice(agent.session, notice)
  }

  /** `continue: false` or an ending block: stop the agent and tell the user why. */
  halt(agent: AgentLike, event: string, reason: string, results: readonly Ran[]): void {
    this.notice(agent, { kind: 'stopped', event, plugin: results[0]?.source.pluginId ?? '', text: reason })
    queueMicrotask(() => { agent.cancel?.({ kind: 'hook', reason }) })
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  /** Context for the model, as a system reminder naming the hook event. */
  reminder(_agent: AgentLike | undefined, event: string, text: string): string {
    const escaped = text.replace(/<(\/?system-reminder)/gu, '&lt;$1')
    return `<system-reminder>\n${event} hook additional context: ${escaped}\n</system-reminder>`
  }

  contextMessage(agent: AgentLike | undefined, event: string, text: string): unknown {
    return createUserMessage({ content: [{ type: 'text', text: this.reminder(agent, event, text) }], source: { ...CONTEXT_SOURCE, event } })
  }

  // -------------------------------------------------------------------------
  // Environment files (`CLAUDE_ENV_FILE`)
  // -------------------------------------------------------------------------

  /** The env file a session's SessionStart (`session`) or CwdChanged/FileChanged (`cwd`) hooks append to. */
  envFile(session: SessionLike, scope: 'session' | 'cwd'): string {
    const path = join(this.host.dataRoot, 'env', `${session.header.id}.${scope}.sh`)
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, '')
    }
    return path
  }

  clearEnv(session: SessionLike, scope: 'cwd'): void {
    const path = join(this.host.dataRoot, 'env', `${session.header.id}.${scope}.sh`)
    if (existsSync(path)) writeFileSync(path, '')
  }

  /**
   * The prefix that applies imported settings `env`, then the session's env
   * files, to one shell tool command.
   */
  shellEnvPrefix(agent: AgentLike, dshName: string, extra: Readonly<Record<string, string>> = {}): string | undefined {
    const settings = Object.entries({ ...this.host.environment?.(agent.session.header), ...extra }).filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))
    const files = ['session', 'cwd']
      .map(scope => join(this.host.dataRoot, 'env', `${agent.session.header.id}.${scope}.sh`))
      .filter(path => existsSync(path) && readFileSync(path, 'utf8').trim().length > 0)
    if (files.length === 0 && settings.length === 0) return undefined
    if (dshName === 'bash') {
      const quote = (value: string): string => `'${value.replace(/'/gu, "'\\''")}'`
      return [
        ...settings.map(([name, value]) => `export ${name}=${quote(value)}\n`),
        ...files.map(path => `. ${quote(path.replace(/\\/gu, '/'))}\n`),
      ].join('')
    }
    // PowerShell never runs the file; plain assignments are copied into the environment.
    const assignments = settings.map(([name, value]) => `$env:${name} = '${value.replace(/'/gu, "''")}'`)
    const fromFiles: string[] = []
    let readable = true
    for (const path of files) {
      for (const line of readFileSync(path, 'utf8').split(/\r?\n/u)) {
        const trimmed = line.trim()
        if (trimmed.length === 0 || trimmed.startsWith('#')) continue
        const match = /^(?:export\s+|declare\s+-x\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(trimmed)
        const value = match === null ? undefined : plainValue(match[2] ?? '')
        if (match === null || value === undefined) {
          readable = false
          break
        }
        if (process.platform === 'win32' && /[\\/]/u.test(value)) continue
        fromFiles.push(`$env:${match[1] ?? ''} = '${value.replace(/'/gu, "''")}'`)
      }
    }
    if (readable) assignments.push(...fromFiles)
    return assignments.length === 0 ? undefined : `${assignments.join('; ')}\n`
  }

  // -------------------------------------------------------------------------
  // Host facts
  // -------------------------------------------------------------------------

  state(session: SessionLike): SessionState & { cwd?: string; lastSummary?: string } {
    const id = session.header.id
    let state = this.sessions.get(id) as (SessionState & { cwd?: string; lastSummary?: string }) | undefined
    if (state === undefined) {
      state = { stopActive: false, stopContinuations: 0, batch: [], expanded: new Set(), asyncSessionStart: new Map(), watchers: [], watchPaths: [] }
      this.sessions.set(id, state)
    }
    return state
  }

  private sourceApplies(source: HookSource, agent: AgentLike | undefined): boolean {
    if (source.sessionId !== undefined) return agent !== undefined && (agent.session.header.id === source.sessionId || agent.session.header.parentSession === source.sessionId)
    if (source.agentSessionId !== undefined) return agent !== undefined && agent.session.header.id === source.agentSessionId
    return true
  }

  toolContext(agent?: AgentLike, cwd?: string): { cwd?: string; agentName: (id: string) => string | undefined; presetOf: (name: string) => string | undefined } {
    const directory = cwd ?? (agent !== undefined ? this.committedDirectory(agent) ?? agent.session.header.cwd : undefined)
    return {
      ...(directory !== undefined ? { cwd: directory } : {}),
      agentName: id => this.host.agentName(id),
      presetOf: name => this.host.presetOf?.(name),
    }
  }

  agentOf(sessionId: string): AgentLike | undefined {
    return (dshService(this.ctx, 'agents') as { get(id: string): AgentLike | undefined } | undefined)?.get(sessionId)
  }

  async directory(agent: AgentLike, signal: AbortSignal): Promise<string> {
    const service = dshService(this.ctx, 'workingDirectory') as WorkingDirectoryLike | undefined
    if (service === undefined) return agent.session.header.cwd ?? process.cwd()
    try {
      return await service.ensure(agent, signal)
    } catch {
      return service.get(agent.session) ?? agent.session.header.cwd ?? process.cwd()
    }
  }

  committedDirectory(agent: AgentLike): string | undefined {
    const service = dshService(this.ctx, 'workingDirectory') as WorkingDirectoryLike | undefined
    try {
      return service?.get(agent.session)
    } catch {
      return undefined
    }
  }

  private lastTurn(agent: AgentLike): number | undefined {
    return lastTurnOf(this.ctx, agent.session) ?? this.sessions.get(agent.session.header.id)?.lastTurn
  }

  presetOf(agent: AgentLike): string | undefined {
    return presetOfSession(this.ctx, agent.session)
  }

  /** Claude's `agent_type`: the imported agent's own name, else `general-purpose`. */
  agentTypeOf(child: AgentLike): string {
    const preset = this.presetOf(child)
    return preset === undefined ? 'general-purpose' : this.host.agentName(preset) ?? 'general-purpose'
  }

  /** The foreign permission mode for the session's DSH permission preset and plan mode. */
  private permissionMode(agent: AgentLike, dialect: HookDialect): string {
    if (planModeActive(this.ctx, agent)) return 'plan'
    const presets = dshService(this.ctx, 'permissionPresets') as { current(session: unknown): string } | undefined
    let preset: string | undefined
    try {
      preset = presets?.current(agent.session)
    } catch {
      preset = undefined
    }
    if (preset === 'auto') return dialect === 'codex' ? 'default' : 'auto'
    if (preset === 'danger-full-access') return 'bypassPermissions'
    if (preset === 'workspace-write') return 'acceptEdits'
    return 'default'
  }

  rename(agent: AgentLike, title: string): void {
    const titles = dshService(this.ctx, 'sessionTitle') as { rename(session: unknown, title: string): unknown } | undefined
    try {
      titles?.rename(agent.session, title)
    } catch {
      // A session whose title cannot change keeps its title.
    }
  }

  track(promise: Promise<unknown>): void {
    const tracked = promise.catch(() => undefined).finally(() => { this.detached.delete(tracked) })
    this.detached.add(tracked)
  }
}

/** Events whose `systemMessage` Claude Code discards. */
const DISCARDS_SYSTEM_MESSAGE = new Set(['Notification', 'SessionEnd', 'PostCompact', 'PreCompact', 'Setup', 'InstructionsLoaded', 'StopFailure'])

/** Which handler types run on which event (hook reference, "Prompt-based hooks"). */
function handlerSupported(event: string, type: string, dialect: HookDialect): boolean {
  if (dialect === 'codex') return type === 'command' || type === 'mcp_tool'
  if (type === 'command' || type === 'mcp_tool') return true
  if (event === 'SessionStart' || event === 'Setup') return false
  if (type === 'http') return true
  if (event === 'PermissionRequest') return type === 'prompt'
  return MODEL_HANDLER_EVENTS.has(event)
}

/** A short description of what a handler runs, for messages. */
function handlerLabel(handler: Exclude<HookHandler, { type: 'invalid' }>): string {
  switch (handler.type) {
    case 'command': return handler.args === undefined ? handler.command : [handler.command, ...handler.args].join(' ')
    case 'http': return handler.url
    case 'mcp_tool': return `${handler.server}/${handler.tool}`
    case 'prompt':
    case 'agent': return `${handler.type}: ${handler.prompt.slice(0, 60)}`
  }
}

/** The first existing directory: the working directory, the session's start directory, home, temp. */
function existingDirectory(cwd: string, start: string | undefined): string {
  for (const candidate of [cwd, start, process.env['HOME'] ?? process.env['USERPROFILE'], process.env['TEMP'] ?? process.env['TMPDIR'] ?? '/tmp']) {
    if (candidate !== undefined && candidate.length > 0 && existsSync(candidate)) return candidate
  }
  return cwd
}

/** A Bash value used exactly as written, or undefined when Bash would expand something. */
function plainValue(raw: string): string | undefined {
  let out = ''
  let index = 0
  while (index < raw.length) {
    const char = raw[index] ?? ''
    if (char === "'") {
      const end = raw.indexOf("'", index + 1)
      if (end === -1) return undefined
      out += raw.slice(index + 1, end)
      index = end + 1
    } else if (char === '"') {
      let end = index + 1
      while (end < raw.length && raw[end] !== '"') {
        if (raw[end] === '\\' && ['$', '`', '"', '\\'].includes(raw[end + 1] ?? '')) {
          out += raw[end + 1]
          end += 2
          continue
        }
        if (raw[end] === '$' || raw[end] === '`') return undefined
        out += raw[end]
        end++
      }
      if (end >= raw.length) return undefined
      index = end + 1
    } else if (/[A-Za-z0-9_@%+=:,./-]/u.test(char)) {
      out += char
      index++
    } else {
      return undefined
    }
  }
  return out
}

async function limited<T>(jobs: ReadonlyArray<() => Promise<T>>, size: number): Promise<T[]> {
  const results = new Array<T>(jobs.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(size, jobs.length) }, async () => {
    while (cursor < jobs.length) {
      const index = cursor++
      results[index] = await jobs[index]!()
    }
  }))
  return results
}
