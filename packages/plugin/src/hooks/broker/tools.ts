/**
 * The hook broker's tool and permission events.
 * @module @kirkchinese/harness-forge
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { ruleVerdict, type PermissionRuleSet } from '../permissions.js'
import { specific } from '../output.js'
import { dshInput, dshValue, foreignTool, isShellTool, shellFailure } from '../vocabulary.js'
import { dshService } from '../../dsh/host.js'
import type { HookEngine } from './engine.js'
import { isRecord, textOf } from './helpers.js'
import { messageOf } from '../../shared/util.js'
import type { AgentLike, ApprovalRequest, HookBrokerHost, Occurrence, PostDecision, QuestionAnswer, QuestionRequest, Ran, ToolDefinitionLike, ToolExecutionLike, ToolResultLike, ToolVerdict } from './types.js'

/**
 * Tool calls and permission requests: PreToolUse with permission rules and
 * mods' `tool.check`, rewritten input through `tools/execute`,
 * PostToolUse / PostToolUseFailure, and PermissionRequest for approvals and
 * questions.
 */
export class ToolGate {
  /** Tool arguments by call id, for PermissionRequest and PostToolUse. */
  private readonly calls = new Map<string, { args: unknown; started: number; deniedByHook?: boolean; contexts: string[]; agent?: AgentLike }>()
  /** Rewritten DSH arguments by call id. */
  private readonly rewrites = new Map<string, Record<string, unknown>>()

  constructor(private readonly engine: HookEngine) {}

  /**
   * The DSH arguments a pending call runs with after a hook rewrote them.
   * The tool's own `tools/execute` listener reads this.
   */
  rewriteOf(callId: string | undefined): Record<string, unknown> | undefined {
    return callId === undefined ? undefined : this.rewrites.get(callId)
  }

  /** A mod rewrote a call's arguments (Claude vocabulary already mapped to DSH's): the hooks and the tool see them. */
  rewrite(callId: string, args: Record<string, unknown>): void {
    this.rewrites.set(callId, args)
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  async preTool(exec: ToolExecutionLike, next: () => Promise<unknown>): Promise<unknown> {
    const callId = exec.callId
    if (callId !== undefined) this.calls.set(callId, { args: exec.arguments, started: Date.now(), contexts: [], ...(exec.agent !== undefined ? { agent: exec.agent } : {}) })
    if (exec.agent !== undefined) this.engine.state(exec.agent.session).stopContinuations = 0
    const rules = this.engine.host.permissionRules?.(exec.agent?.session.header)
    const hasRules = rules !== undefined && rules.allow.length + rules.deny.length + rules.ask.length > 0
    const checked = this.engine.host.checks?.(exec) === true
    if (!this.engine.has('PreToolUse') && !hasRules && !checked) return next()
    if (checked) return this.checkedDecision(exec, await this.decide(exec, rules, hasRules, next))
    return this.decide(exec, rules, hasRules, next)
  }

  /**
   * The decision Claude Code reaches, as a verdict mods' `tool.check` hooks
   * may answer over; mapped back to DSH's pre-execute decision.
   */
  private async checkedDecision(exec: ToolExecutionLike, decided: unknown): Promise<unknown> {
    const kind = isRecord(decided) ? decided['kind'] : undefined
    const reason = isRecord(decided) && typeof decided['reason'] === 'string' ? decided['reason'] : undefined
    const why = exec.callId === undefined ? undefined : this.behindDecision.get(exec.callId)
    if (exec.callId !== undefined) this.behindDecision.delete(exec.callId)
    const verdict: ToolVerdict = {
      decision: kind === 'deny' || kind === 'cancel' ? 'deny' : kind === 'allow' ? 'allow' : 'ask',
      ...(reason !== undefined ? { reason } : {}),
      ...(why?.rule !== undefined ? { rule: why.rule } : {}),
      ...(why?.hook !== undefined ? { hook: why.hook } : {}),
    }
    const answer = await this.engine.host.check!(exec, verdict)
    if (answer.decision === verdict.decision && answer.reason === verdict.reason) return decided
    if (answer.decision === 'deny') {
      this.markDenied(exec.callId)
      return { kind: 'deny', reason: answer.reason ?? `Permission to use ${exec.name} has been denied.` }
    }
    return answer.decision === 'allow' ? { kind: 'allow' } : { kind: 'ask', ...(answer.reason !== undefined ? { reason: answer.reason } : {}) }
  }

  private async decide(exec: ToolExecutionLike, rules: ReturnType<NonNullable<HookBrokerHost['permissionRules']>> | undefined, hasRules: boolean, next: () => Promise<unknown>): Promise<unknown> {
    const callId = exec.callId
    if (!this.engine.has('PreToolUse') && !hasRules) return next()
    const results = this.engine.has('PreToolUse')
      ? await this.engine.run({
        event: 'PreToolUse',
        ...(exec.agent !== undefined ? { agent: exec.agent } : {}),
        signal: exec.signal,
        tool: { dshName: exec.name, args: (callId !== undefined ? this.rewrites.get(callId) : undefined) ?? exec.arguments, ...(callId !== undefined ? { callId } : {}) },
        fields: callId !== undefined ? { tool_use_id: callId } : {},
      })
      : []
    const subject = results[0]?.toolName ?? exec.name
    if (exec.agent !== undefined) this.engine.noticeAll(exec.agent, 'PreToolUse', subject, results)
    const stop = this.engine.stopOf(results)
    const contexts = this.engine.contexts('PreToolUse', results)
    if (stop !== undefined) {
      this.markDenied(callId)
      if (exec.agent !== undefined) this.engine.halt(exec.agent, 'PreToolUse', stop, results)
      return { kind: 'deny', reason: stop }
    }
    // deny > defer > ask > allow.
    const decisions = results.map(ran => ({ ran, decision: this.permissionDecision(ran) }))
    const deny = decisions.find(item => item.decision?.kind === 'deny')
    if (deny !== undefined) {
      this.markDenied(callId)
      const reason = deny.decision?.reason ?? 'blocked by a PreToolUse hook'
      if (deny.decision?.endTurn === true && exec.agent !== undefined) this.engine.halt(exec.agent, 'PreToolUse', reason, results)
      if (contexts.length > 0 && exec.agent !== undefined) for (const text of contexts) exec.agent.inject(this.engine.contextMessage(exec.agent, 'PreToolUse', text))
      this.behind(callId, { hook: 'PreToolUse' })
      return { kind: 'deny', reason }
    }
    // `defer` only applies to non-interactive runs; DSH sessions are interactive, as in Claude Code's terminal.
    const rewritten = [...decisions].reverse().find(item => item.decision?.updatedInput !== undefined)
    if (rewritten !== undefined && callId !== undefined) {
      try {
        const tool = rewritten.decision!.updatedInput!
        this.rewrites.set(callId, dshInput(rewritten.ran.source.dialect, exec.name, exec.arguments, tool, this.engine.toolContext()))
      } catch (error: unknown) {
        if (exec.agent !== undefined) this.engine.notice(exec.agent, { kind: 'hook-error', event: 'PreToolUse', subject, plugin: rewritten.ran.source.pluginId, text: `updatedInput ignored: ${messageOf(error)}` })
      }
    }
    // Permission rules hold whatever a hook returned, and see the input the hooks rewrote.
    const verdict = hasRules && rules !== undefined ? await this.ruleVerdictOf(exec, (callId !== undefined ? this.rewrites.get(callId) : undefined) ?? exec.arguments, rules) : undefined
    if (verdict?.kind === 'deny') {
      this.markDenied(callId)
      this.behind(callId, { rule: verdict.rule })
      return { kind: 'deny', reason: `Permission to use ${verdict.tool} has been denied by the rule ${verdict.rule}.` }
    }
    if (callId !== undefined) this.calls.get(callId)?.contexts.push(...contexts)
    const ask = decisions.find(item => item.decision?.kind === 'ask')
    if (ask !== undefined) {
      this.behind(callId, { hook: 'PreToolUse' })
      return { kind: 'ask', ...(ask.decision?.reason !== undefined ? { reason: ask.decision.reason } : {}) }
    }
    if (verdict?.kind === 'ask') {
      this.behind(callId, { rule: verdict.rule })
      return { kind: 'ask', reason: `${verdict.tool} matches the ask rule ${verdict.rule}` }
    }
    // `allow` skips the permission prompt.
    if (verdict?.kind === 'allow') this.behind(callId, { rule: verdict.rule })
    else if (decisions.some(item => item.decision?.kind === 'allow')) this.behind(callId, { hook: 'PreToolUse' })
    if (decisions.some(item => item.decision?.kind === 'allow') || verdict?.kind === 'allow') {
      if (callId !== undefined) this.allowedCalls.add(callId)
      return { kind: 'allow' }
    }
    return next()
  }

  /** Calls an allow rule or hook let through: DSH asks nobody about them (a sandbox escalation included). */
  private readonly allowedCalls = new Set<string>()

  /** What stands behind a call's decision (a rule, a PreToolUse hook), for tool.check. */
  private readonly behindDecision = new Map<string, { rule?: string; hook?: string }>()

  private behind(callId: string | undefined, why: { rule?: string; hook?: string }): void {
    if (callId !== undefined && this.engine.host.checks !== undefined) this.behindDecision.set(callId, why)
  }

  private async ruleVerdictOf(exec: ToolExecutionLike, args: unknown, rules: PermissionRuleSet): Promise<{ kind: 'deny' | 'ask' | 'allow'; rule: string; tool: string } | undefined> {
    const cwd = exec.agent !== undefined ? await this.engine.directory(exec.agent, exec.signal) : process.cwd()
    const tool = foreignTool('claude-code', exec.name, args, this.engine.toolContext(exec.agent, cwd))
    const verdict = ruleVerdict(rules, tool, cwd)
    return verdict === undefined ? undefined : { ...verdict, tool: tool.name }
  }

  async executeTool(exec: ToolExecutionLike, next: () => Promise<unknown>): Promise<unknown> {
    const rewrite = exec.callId === undefined ? undefined : this.rewrites.get(exec.callId)
    const extra = isShellTool(exec.name) && this.engine.host.shellEnv !== undefined ? await this.engine.host.shellEnv(exec).catch(() => ({})) : {}
    const envPrefix = isShellTool(exec.name) && exec.agent !== undefined ? this.engine.shellEnvPrefix(exec.agent, exec.name, extra) : undefined
    if (rewrite === undefined && envPrefix === undefined) return next()
    const args = { ...(rewrite ?? (exec.arguments as Record<string, unknown>)) }
    if (envPrefix !== undefined && typeof args['command'] === 'string') args['command'] = `${envPrefix}${args['command']}`
    const tools = dshService(this.engine.ctx, 'tools') as { get(name: string, scope?: unknown): ToolDefinitionLike | undefined } | undefined
    const definition = tools?.get(exec.name, exec.agent)
    if (definition === undefined) return next()
    try {
      const value = await definition.execute(args, exec)
      return { isError: false, value, content: definition.output.render(args, value) }
    } catch (error: unknown) {
      const message = messageOf(error)
      return { isError: true, error: { message }, content: [{ type: 'text', text: `Error: ${message}` }] }
    }
  }

  async postTool(exec: ToolExecutionLike, result: ToolResultLike, next: () => Promise<PostDecision>): Promise<PostDecision> {
    const callId = exec.callId
    const call = callId === undefined ? undefined : this.calls.get(callId)
    const args = (callId !== undefined ? this.rewrites.get(callId) : undefined) ?? exec.arguments
    if (callId !== undefined) {
      this.calls.delete(callId)
      this.rewrites.delete(callId)
    }
    const pending = call?.contexts ?? []
    const text = textOf(result.content)
    // A shell command that exits non-zero failed, as in Claude Code.
    const failure = result.isError ? result.error?.message ?? text : shellFailure(exec.name, result.value)
    const event = failure !== undefined ? 'PostToolUseFailure' : 'PostToolUse'
    const agent = exec.agent
    if (agent !== undefined && this.engine.has('PostToolBatch')) {
      const tool = foreignTool('claude-code', exec.name, args, this.engine.toolContext(agent))
      this.engine.state(agent.session).batch.push({ tool_name: tool.name, tool_input: tool.input, ...(callId !== undefined ? { tool_use_id: callId } : {}), tool_response: text })
    }
    if (call?.deniedByHook === true || (!this.engine.has(event) && pending.length === 0)) return next()
    const results = this.engine.has(event)
      ? await this.engine.run({
          event,
          ...(agent !== undefined ? { agent } : {}),
          signal: exec.signal,
          tool: { dshName: exec.name, args, ...(callId !== undefined ? { callId } : {}) },
          fields: {
            ...(callId !== undefined ? { tool_use_id: callId } : {}),
            ...(call !== undefined ? { duration_ms: Date.now() - call.started } : {}),
            ...(failure !== undefined
              ? { error: failure, is_interrupt: exec.signal.aborted }
              : {}),
          },
          // The structured response depends on the dialect; see `payload`.
          ...(failure !== undefined ? {} : { response: { value: result.value, text } }),
        } as Occurrence & { response?: { value: unknown; text: string } })
      : []
    const subject = results[0]?.toolName ?? exec.name
    if (agent !== undefined) this.engine.noticeAll(agent, event, subject, results)
    const contexts = [...pending, ...this.engine.contexts(event, results)]
    const blocks: string[] = []
    for (const ran of results) {
      if (ran.decoded.block !== undefined) blocks.push(ran.decoded.block)
      else if (ran.decoded.json?.['decision'] === 'block') blocks.push(String(ran.decoded.json['reason'] ?? `blocked by a ${event} hook`))
      if (ran.verdict !== undefined && !ran.verdict.ok) {
        const endTurn = event === 'PostToolUse' && ran.handler.type === 'prompt' && (ran.handler as { continueOnBlock?: boolean }).continueOnBlock !== true
        if (endTurn && agent !== undefined) this.engine.halt(agent, event, ran.verdict.reason ?? `${event} hook condition not met`, results)
        else blocks.push(ran.verdict.reason ?? `${event} hook condition not met`)
      }
    }
    const stop = this.engine.stopOf(results)
    if (stop !== undefined && agent !== undefined) this.engine.halt(agent, event, stop, results)
    const codex = results.some(ran => ran.source.dialect === 'codex')
    const reminders = [
      ...contexts.map(item => this.engine.contextMessage(agent, event, item)),
      ...(codex ? [] : blocks.map(reason => this.engine.contextMessage(agent, event, `${event} hook blocking error: ${reason}`))),
    ].filter(item => item !== undefined)
    if (codex && blocks.length > 0) {
      return { kind: 'block', feedback: [{ type: 'text', text: blocks.join('\n') }], ...(reminders.length > 0 ? { additionalContexts: reminders } : {}) }
    }
    const replacement = this.outputReplacement(exec.name, result, results)
    const downstream = await next()
    if (downstream.kind !== 'accept') return downstream
    return {
      ...downstream,
      ...replacement,
      ...(reminders.length > 0 ? { additionalContexts: [...reminders, ...downstream.additionalContexts ?? []] } : {}),
    }
  }

  /** `updatedToolOutput` / `updatedMCPToolOutput`: a DSH value when the shape maps, else the model-facing text. */
  private outputReplacement(dshName: string, result: ToolResultLike, results: readonly Ran[]): { value?: unknown; content?: ContentBlock[] } {
    for (const ran of [...results].reverse()) {
      const hso = specific(ran.decoded)
      const updated = hso?.['updatedToolOutput'] ?? (dshName.startsWith('mcp__') ? hso?.['updatedMCPToolOutput'] : undefined)
      if (updated === undefined) continue
      const value = dshValue(dshName, result.value, updated)
      if (value !== undefined) return { value }
      return { content: [{ type: 'text', text: typeof updated === 'string' ? updated : JSON.stringify(updated) }] }
    }
    return {}
  }

  async permission(request: ApprovalRequest, next: () => Promise<string>): Promise<string> {
    // An allowed call skips the permission prompt, whatever DSH would ask about it.
    if (request.callId !== undefined && this.allowedCalls.has(request.callId)) return 'allowed-once'
    if (!this.engine.has('PermissionRequest')) return next()
    const call = request.callId === undefined ? undefined : this.calls.get(request.callId)
    const results = await this.engine.run({
      event: 'PermissionRequest',
      agent: request.agent,
      signal: request.signal ?? this.engine.lifetime.signal,
      tool: { dshName: request.toolName, args: call?.args ?? {}, ...(request.callId !== undefined ? { callId: request.callId } : {}) },
    })
    const subject = results[0]?.toolName ?? request.toolName
    this.engine.noticeAll(request.agent, 'PermissionRequest', subject, results)
    const stop = this.engine.stopOf(results)
    if (stop !== undefined) {
      this.engine.halt(request.agent, 'PermissionRequest', stop, results)
      return 'rejected'
    }
    let allow: { updatedInput?: Record<string, unknown>; ran: Ran } | undefined
    for (const ran of results) {
      // Exit 2 is not honored on PermissionRequest; only the decision object and onFailure decide.
      if (ran.failureBlock !== undefined) return this.permissionDenied(request, ran.failureBlock, false, results)
      const decision = specific(ran.decoded)?.['decision']
      if (typeof decision !== 'object' || decision === null) continue
      const value = decision as Record<string, unknown>
      if (value['behavior'] === 'deny') return this.permissionDenied(request, typeof value['message'] === 'string' ? value['message'] : 'denied by a PermissionRequest hook', value['interrupt'] === true, results)
      if (value['behavior'] === 'allow') allow = { ran, ...(isRecord(value['updatedInput']) ? { updatedInput: value['updatedInput'] } : {}) }
    }
    if (allow !== undefined) {
      if (allow.updatedInput !== undefined && request.callId !== undefined) {
        try {
          this.rewrites.set(request.callId, dshInput(allow.ran.source.dialect, request.toolName, call?.args, allow.updatedInput, this.engine.toolContext(request.agent)))
        } catch (error: unknown) {
          this.engine.notice(request.agent, { kind: 'hook-error', event: 'PermissionRequest', subject, plugin: allow.ran.source.pluginId, text: `updatedInput ignored: ${messageOf(error)}` })
        }
      }
      return 'allowed-once'
    }
    return next()
  }

  /**
   * `PermissionRequest` for a question the model asks (Claude's
   * `AskUserQuestion` dialog): the hooks run while the person sees the
   * question. A hook's `allow` with `updatedInput.answers` answers it; a
   * `deny` closes it unanswered; otherwise the person's answer stands.
   */
  async question(request: QuestionRequest, next: () => Promise<QuestionAnswer>): Promise<QuestionAnswer> {
    if (!this.engine.has('PermissionRequest') || request.agent === undefined) return next()
    const agent = request.agent
    const controller = new AbortController()
    const outer = request.signal
    if (outer !== undefined) {
      if (outer.aborted) controller.abort(outer.reason)
      else outer.addEventListener('abort', () => { controller.abort(outer.reason) }, { once: true })
    }
    // The person's dialog closes when a hook decides first.
    request.signal = controller.signal
    const person = next()
    const args = { questions: request.questions.map(item => ({ question: item.question, ...(item.header !== undefined ? { header: item.header } : {}), options: item.options ?? [], multi_select: item.multiSelect === true })) }
    const decided = this.engine.run({
      event: 'PermissionRequest',
      agent,
      signal: controller.signal,
      tool: { dshName: 'ask_user_question', args, ...(request.wait?.callId !== undefined ? { callId: request.wait.callId } : {}) },
    }).then((results): QuestionAnswer | undefined => {
      this.engine.noticeAll(agent, 'PermissionRequest', 'AskUserQuestion', results)
      for (const ran of results) {
        const decision = specific(ran.decoded)?.['decision']
        if (!isRecord(decision)) continue
        if (decision['behavior'] === 'deny') return { answers: request.questions.map(item => ({ id: item.id, selected: [] })) }
        if (decision['behavior'] === 'allow') {
          const given = isRecord(decision['updatedInput']) && isRecord(decision['updatedInput']['answers']) ? decision['updatedInput']['answers'] : undefined
          if (given === undefined) continue
          return {
            answers: request.questions.map((item) => {
              const value = given[item.question]
              const text = typeof value === 'string' ? value : Array.isArray(value) ? value.map(String).join(', ') : ''
              const labels = (item.options ?? []).map(option => option.label)
              const chosen = text.split(/,\s*/u).filter(label => labels.includes(label))
              return chosen.length > 0 ? { id: item.id, selected: chosen } : text.length > 0 ? { id: item.id, selected: [], custom: text } : { id: item.id, selected: [] }
            }),
          }
        }
      }
      return undefined
    }, () => undefined)
    const first = await Promise.race([person.then(answer => ({ answer })), decided.then(answer => ({ hook: answer }))])
    if ('answer' in first) return first.answer
    if (first.hook === undefined) return person
    controller.abort(new Error('answered by a PermissionRequest hook'))
    person.catch(() => undefined)
    return first.hook
  }

  private permissionDenied(request: ApprovalRequest, message: string, interrupt: boolean, results: readonly Ran[]): string {
    if (interrupt) this.engine.halt(request.agent, 'PermissionRequest', message, results)
    else request.agent.inject(this.engine.contextMessage(request.agent, 'PermissionRequest', `Permission to use ${request.toolName} was denied: ${message}`))
    return 'rejected'
  }

  /** The PreToolUse decision one run expresses; `none` carries an `updatedInput` without a decision. */
  private permissionDecision(ran: Ran): { kind: 'allow' | 'deny' | 'ask' | 'defer' | 'none'; reason?: string; updatedInput?: Record<string, unknown>; endTurn?: boolean } | undefined {
    if (ran.decoded.block !== undefined) {
      const reason = ran.failureBlock ?? (ran.decoded.json !== undefined && specific(ran.decoded)?.['permissionDecisionReason'] !== undefined
        ? String(specific(ran.decoded)?.['permissionDecisionReason'])
        : `PreToolUse:${ran.toolName ?? ''} hook error: [${ran.label}]: ${ran.decoded.block}`)
      return { kind: 'deny', reason }
    }
    if (ran.verdict !== undefined && !ran.verdict.ok) {
      const continueOnBlock = ran.handler.type === 'agent' || (ran.handler as { continueOnBlock?: boolean }).continueOnBlock === true
      return { kind: 'deny', reason: ran.verdict.reason ?? 'blocked by a PreToolUse hook', endTurn: !continueOnBlock }
    }
    const hso = specific(ran.decoded)
    const reason = typeof hso?.['permissionDecisionReason'] === 'string' ? hso['permissionDecisionReason'] : typeof ran.decoded.json?.['reason'] === 'string' ? ran.decoded.json['reason'] : undefined
    const updated = isRecord(hso?.['updatedInput']) ? hso['updatedInput'] : undefined
    const legacy = ran.decoded.json?.['decision']
    const raw = hso?.['permissionDecision'] ?? (legacy === 'approve' ? 'allow' : legacy === 'block' ? 'deny' : undefined)
    if (raw === 'allow' || raw === 'deny' || raw === 'ask' || raw === 'defer') {
      return { kind: raw, ...(reason !== undefined ? { reason } : {}), ...(updated !== undefined && raw !== 'defer' ? { updatedInput: updated } : {}) }
    }
    return updated !== undefined ? { kind: 'none', updatedInput: updated } : undefined
  }

  private markDenied(callId: string | undefined): void {
    const call = callId === undefined ? undefined : this.calls.get(callId)
    if (call !== undefined) call.deniedByHook = true
  }
}
