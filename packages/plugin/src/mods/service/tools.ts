/**
 * The tool path: `tool.call` wrapped around DSH's pipeline, a mod's own
 * `$.tool.call`, `agent.spawn` and `tool.check`.
 * @module @kirkchinese/harness-forge/mods
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { appendNotice } from '../../hooks/notice.js'
import { dshInput, foreignResponse, foreignTool, shellFailure } from '../../hooks/vocabulary.js'
import type { CoreContext } from '../engine.js'
import { resolveRoute } from '../../shared/invocation.js'
import { isRecord, messageOf } from '../values.js'
import { dshService } from '../../dsh/host.js'
import { hasHooks, type SessionRegistry } from './sessions.js'
import type { ClaudeVerdict, Deferred, PendingCall, PostDecision, SessionMods, ToolExec, ToolResult } from './types.js'

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

/** Tool calls and permission decisions in the sessions' mods. */
export class ModTools {
  constructor(private readonly registry: SessionRegistry) {}

  // ---------------------------------------------------------------------------
  // Tool calls
  // ---------------------------------------------------------------------------

  private toolContext(cwd?: string): { cwd?: string; agentName: (id: string) => string | undefined; presetOf: (name: string) => string | undefined } {
    return { ...(cwd !== undefined ? { cwd } : {}), agentName: id => this.registry.host.agentName(id), presetOf: name => this.registry.host.presetOf(name) }
  }

  async preExecute(exec: ToolExec, next: () => Promise<unknown>): Promise<unknown> {
    const found = this.registry.sessionOf(exec.agent)
    if (found === undefined || exec.callId === undefined || !hasHooks(found.session.engine, 'tool.call')) return next()
    const { session, agentId } = found
    await session.ready
    const cwd = await this.registry.host.directory(exec.agent, exec.signal).catch(() => undefined)
    const tool = foreignTool('claude-code', exec.name, exec.arguments, this.toolContext(cwd))
    const input = { ...tool.input, tool: tool.name, tool_use_id: exec.callId, ...(agentId !== undefined ? { agentId } : {}) }
    const pending: PendingCall = { input, reached: deferred(), beneath: deferred(), isBeneathSettled: false }
    session.calls.set(exec.callId, pending)
    pending.chain = session.engine.raise('tool.call', input, { signal: exec.signal }) as Promise<Record<string, unknown>>
    const first = await Promise.race([
      pending.reached.promise.then(e => ({ reached: e })),
      pending.chain.then(result => ({ answered: result }), (error: unknown) => ({ failed: error })),
    ])
    if ('failed' in first) {
      appendNotice(exec.agent!.session, { kind: 'hook-error', event: 'tool.call', plugin: 'mods', text: messageOf(first.failed) })
      return next()
    }
    if ('answered' in first) {
      if (typeof first.answered['deny'] === 'string') return { kind: 'deny', reason: first.answered['deny'] }
      pending.answered = first.answered
      return { kind: 'allow' }
    }
    // The hooks passed the call on: what they changed in its arguments is what runs.
    const { tool: _tool, tool_use_id: _id, agentId: _agent, ...passed } = first.reached
    const { tool: _t, tool_use_id: _i, agentId: _a, ...original } = input
    if (JSON.stringify(passed) !== JSON.stringify(original)) this.registry.host.rewrite(exec.callId, dshInput('claude-code', exec.name, exec.arguments, passed, this.toolContext(cwd)))
    return next()
  }

  /** Core of `tool.call`: the rest of DSH's pipeline, which settles in post-execute. */
  toolCore(session: SessionMods, e: Record<string, unknown>, context: CoreContext): Promise<unknown> {
    const pending = typeof e['tool_use_id'] === 'string' ? session.calls.get(e['tool_use_id']) : undefined
    if (pending !== undefined && context.mod === undefined) {
      pending.reached.resolve(e)
      return pending.beneath.promise
    }
    return this.callTool(session, e, context)
  }

  /** A mod's `$.tool.call`: the tool through DSH's registry. */
  private async callTool(session: SessionMods, e: Record<string, unknown>, context: CoreContext): Promise<unknown> {
    const tools = dshService(session.agent.ctx as object | undefined, 'tools') as { execute(call: Record<string, unknown>): Promise<ToolResult> } | undefined
    if (tools === undefined) throw new Error('no tool runtime')
    const { tool, tool_use_id: _id, agentId: _agent, ...args } = e
    const name = dshToolName(String(tool))
    const dshArgs = dshInput('claude-code', name, {}, args, this.toolContext(session.agent.session.header.cwd))
    const result = await tools.execute({ callId: `mod-${crypto.randomUUID()}`, name, arguments: dshArgs, agent: session.agent, signal: context.signal })
    return this.resultOf(name, dshArgs, result)
  }

  private resultOf(name: string, args: unknown, result: ToolResult): Record<string, unknown> {
    const text = (result.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('')
    const failure = result.isError ? result.error?.message ?? text : shellFailure(name, result.value)
    return {
      ref: 0,
      result: result.isError ? text : foreignResponse('claude-code', name, args, result.value, text),
      text,
      ...(failure !== undefined ? { isError: true } : {}),
    }
  }

  async execute(exec: ToolExec, next: () => Promise<ToolResult>): Promise<ToolResult> {
    const found = this.registry.sessionOf(exec.agent)
    const pending = exec.callId === undefined ? undefined : found?.session.calls.get(exec.callId)
    if (pending?.answered === undefined) {
      if (found !== undefined && DELEGATION_TOOLS.has(exec.name) && hasHooks(found.session.engine, 'agent.spawn')) {
        const refusal = await this.spawn(found.session, found.agentId, exec)
        if (refusal !== undefined) return { isError: true, error: { message: refusal }, content: [{ type: 'text', text: refusal }] }
      }
      return next()
    }
    // A hook answered the call itself: its result is the tool's, and no tool runs.
    const answer = pending.answered
    const text = typeof answer['result'] === 'string' ? answer['result'] : JSON.stringify(answer['result'] ?? '')
    return answer['isError'] === true
      ? { isError: true, error: { message: text }, content: [{ type: 'text', text }] }
      : { isError: false, value: text, content: [{ type: 'text', text }] }
  }

  /**
   * `agent.spawn` as a delegated agent is about to start: a deny keeps it
   * from starting; a model the hooks chose runs the child.
   * @returns the refusal the model reads, when the spawn was denied.
   */
  private async spawn(session: SessionMods, agentId: string | undefined, exec: ToolExec): Promise<string | undefined> {
    const args = isRecord(exec.arguments) ? exec.arguments : {}
    const preset = typeof args['agent_preset'] === 'string' ? args['agent_preset'] : undefined
    const parentModel = exec.agent?.options?.model ?? ''
    const input = {
      tool_use_id: exec.callId ?? '',
      prompt: String(args['prompt'] ?? ''),
      description: String(args['description'] ?? ''),
      subagentType: preset === undefined ? 'general-purpose' : this.registry.host.agentName(preset) ?? preset,
      provider: { plugin: 'engine', tier: 'core' },
      parentModel,
      background: true,
      fork: exec.name === 'subagent_fork',
      permissionMode: 'default',
      ...(agentId !== undefined ? { parentAgentId: agentId } : {}),
      ...(typeof args['cwd'] === 'string' ? { cwd: args['cwd'] } : {}),
    }
    const result = await session.engine.raise('agent.spawn', input, { signal: exec.signal }).catch(() => undefined) as Record<string, unknown> | undefined
    if (result === undefined) return undefined
    if (typeof result['deny'] === 'string') return `a plugin declined the spawn: ${result['deny']}`
    const model = typeof result['model'] === 'string' ? result['model'] : undefined
    if (model !== undefined && model !== parentModel && model.length > 0 && exec.agent !== undefined) {
      const resolved = await resolveRoute(this.registry.ctx, exec.agent.options ?? {}, model, undefined, exec.signal)
      if (resolved.route !== undefined) {
        const queue = this.registry.spawnRoutes.get(exec.agent.session.header.id) ?? []
        queue.push(resolved.route)
        this.registry.spawnRoutes.set(exec.agent.session.header.id, queue)
      }
    }
    return undefined
  }

  async postExecute(exec: ToolExec, result: ToolResult, next: () => Promise<PostDecision>): Promise<PostDecision> {
    const found = this.registry.sessionOf(exec.agent)
    const pending = exec.callId === undefined ? undefined : found?.session.calls.get(exec.callId)
    if (found === undefined || pending === undefined || pending.answered !== undefined || pending.chain === undefined) return next()
    const downstream = await next()
    const content = downstream.kind === 'accept' && downstream.content !== undefined ? downstream.content : result.content
    const effective: ToolResult = { ...result, ...(content !== undefined ? { content } : {}) }
    const beneath = downstream.kind === 'block'
      ? { deny: downstream.reason ?? 'blocked by a PostToolUse hook' }
      : this.resultOf(exec.name, exec.arguments, effective)
    pending.isBeneathSettled = true
    pending.beneath.resolve(beneath)
    const final = await pending.chain.catch(() => beneath)
    found.session.calls.delete(exec.callId!)
    const contexts = Array.isArray(final['context']) ? final['context'].map(text => createUserMessage({ content: [{ type: 'text', text: String(text) }], source: { kind: 'user' } })) : []
    const additional = [...(downstream.additionalContexts ?? []), ...contexts]
    if (typeof final['deny'] === 'string' && typeof beneath['deny'] !== 'string') {
      const tool = String(pending.input['tool'])
      const note = result.isError ? final['deny'] : `${tool} ran, and a plugin withheld its result: ${final['deny']}`
      return { kind: 'accept', content: [{ type: 'text', text: note }], ...(additional.length > 0 ? { additionalContexts: additional } : {}) }
    }
    const changed = final['result'] !== beneath['result'] && final['result'] !== undefined
    if (changed) {
      const text = typeof final['result'] === 'string' ? final['result'] : JSON.stringify(final['result'])
      return { kind: 'accept', content: [{ type: 'text', text }], ...(additional.length > 0 ? { additionalContexts: additional } : {}) }
    }
    if (contexts.length > 0) return { ...downstream, additionalContexts: additional } as PostDecision
    return downstream
  }

  toolResult(exec: ToolExec, result: ToolResult): void {
    const found = this.registry.sessionOf(exec.agent)
    found?.session.surfaces.invalidate()
    const pending = exec.callId === undefined ? undefined : found?.session.calls.get(exec.callId)
    if (found === undefined || pending === undefined) return
    // A call refused before it ran settles here: beneath the hooks, the refusal.
    if (!pending.isBeneathSettled) {
      pending.isBeneathSettled = true
      pending.beneath.resolve({ deny: result.error?.message ?? 'the call did not run' })
    }
    found.session.calls.delete(exec.callId!)
  }

  // ---------------------------------------------------------------------------
  // Permission decisions
  // ---------------------------------------------------------------------------

  /** Whether a call's session has mods hooking `tool.check`. */
  checks(exec: ToolExec): boolean {
    const found = this.registry.sessionOf(exec.agent)
    return found !== undefined && hasHooks(found.session.engine, 'tool.check')
  }

  /**
   * `tool.check` for one call the hooks broker decided: the mods' answer over
   * Claude Code's own verdict (rules, PreToolUse hooks, the mode).
   */
  async check(exec: ToolExec, verdict: ClaudeVerdict): Promise<ClaudeVerdict> {
    const found = this.registry.sessionOf(exec.agent)
    if (found === undefined || exec.callId === undefined || !hasHooks(found.session.engine, 'tool.check')) return verdict
    const { session, agentId } = found
    await session.ready
    const cwd = await this.registry.host.directory(exec.agent, exec.signal).catch(() => undefined)
    const tool = foreignTool('claude-code', exec.name, exec.arguments, this.toolContext(cwd))
    session.checks.set(exec.callId, verdict)
    try {
      const answer = await session.engine.raise('tool.check', {
        tool: tool.name,
        input: tool.input,
        tool_use_id: exec.callId,
        ...(agentId !== undefined ? { agentId } : {}),
        ...(READ_ONLY_TOOLS.has(exec.name) ? { isReadOnly: true } : {}),
      }, { signal: exec.signal })
      if (isRecord(answer) && ['allow', 'ask', 'deny'].includes(String(answer['decision']))) return answer as unknown as ClaudeVerdict
      return verdict
    } finally {
      session.checks.delete(exec.callId)
    }
  }

  checkCore(session: SessionMods, e: Record<string, unknown>): ClaudeVerdict {
    const verdict = typeof e['tool_use_id'] === 'string' ? session.checks.get(e['tool_use_id']) : undefined
    return verdict ?? { decision: 'allow' }
  }
}

const READ_ONLY_TOOLS = new Set(['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch'])
const DELEGATION_TOOLS = new Set(['agent', 'subagent', 'subagent_fork'])

/** The DSH tool a Claude tool name runs on. */
function dshToolName(name: string): string {
  const table: Record<string, string> = {
    Bash: process.platform === 'win32' ? 'pwsh' : 'bash',
    PowerShell: 'pwsh',
    Read: 'read',
    Write: 'write',
    Edit: 'edit',
    Glob: 'glob',
    Grep: 'grep',
    WebFetch: 'web_fetch',
    WebSearch: 'web_search',
    TodoWrite: 'todo_write',
    AskUserQuestion: 'ask_user_question',
  }
  return table[name] ?? name
}
