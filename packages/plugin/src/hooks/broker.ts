/**
 * One hook broker for every imported plugin. Each foreign hooks configuration
 * becomes a source; the broker listens once on DSH's interception points,
 * presents each occurrence to the matching handlers in their own dialect
 * (event names, matchers, tool names and shapes, payload fields, transcript),
 * runs the handlers in parallel, and applies their combined outcome the way
 * Claude Code or Codex does: blocking, rewriting input or output, adding
 * context, continuing or stopping the turn, notifying the user.
 *
 * | Foreign event | DSH seam |
 * | SessionStart / SubagentStart | `agent/created` of a root / delegated agent |
 * | UserPromptSubmit, PostToolBatch, PreModelRequest | `agent/pre-step` |
 * | UserPromptExpansion | an imported command's handler |
 * | PreToolUse | `tools/pre-execute`; `updatedInput` runs through `tools/execute` |
 * | PermissionRequest | `approval/request` |
 * | PostToolUse / PostToolUseFailure | `tools/post-execute` |
 * | Stop / SubagentStop | `agent/turn-stopping` of a root / delegated agent |
 * | SessionEnd | `agent/disposed` |
 * | PreCompact, PostCompact, StopFailure, Notification, CwdChanged, Interrupt, PostModelRequest | committed session events |
 * | FileChanged | a file watcher |
 * @module @kirkchinese/harness-forge
 */
import type { Context } from '@deepseek-ai/cordis'
import { hostShuttingDown, onDsh, type DshEvent } from '../dsh/host.js'
import { HookEngine } from './broker/engine.js'
import { SessionEvents } from './broker/session-events.js'
import { SessionLifecycle } from './broker/lifecycle.js'
import { ToolGate } from './broker/tools.js'
import type { AgentLike, ApprovalRequest, HookBrokerHost, HookSource, PostDecision, PreStepDecision, PreStepPayload, QuestionAnswer, QuestionRequest, SessionLike, ToolExecutionLike, ToolResultLike } from './broker/types.js'

export type { HookBrokerHost, HookObservation, HookSource, ToolVerdict } from './broker/types.js'

/** Coordinates every imported hooks configuration. */
export class HookBroker {
  private readonly engine: HookEngine
  private readonly events: SessionEvents
  private readonly lifecycle: SessionLifecycle
  private readonly tools: ToolGate

  constructor(private readonly ctx: Context, host: HookBrokerHost) {
    this.engine = new HookEngine(ctx, host)
    this.events = new SessionEvents(this.engine)
    this.lifecycle = new SessionLifecycle(this.engine, this.events)
    this.tools = new ToolGate(this.engine)
  }

  /** Register one source; the returned disposer removes it. */
  add(source: HookSource): () => void {
    return this.engine.add(source)
  }

  /** Listen on every interception point. Returns the disposer for all of them. */
  install(): () => void {
    const ctx = { on: (name: DshEvent, listener: (...args: never[]) => unknown, options?: { prepend?: boolean }): (() => void) => onDsh(this.ctx, name, listener, { ...options, owner: 'hooks' }) }
    const disposers = [
      ctx.on('agent/created', ((payload: { agent: AgentLike; source: string; signal?: AbortSignal }) => this.lifecycle.agentCreated(payload)) as never),
      ctx.on('agent/pre-step', ((payload: PreStepPayload, next: () => Promise<PreStepDecision>) => this.lifecycle.preStep(payload, next)) as never),
      ctx.on('tools/pre-execute', ((exec: ToolExecutionLike, next: () => Promise<unknown>) => this.tools.preTool(exec, next)) as never),
      ctx.on('tools/execute', ((exec: ToolExecutionLike, next: () => Promise<unknown>) => this.tools.executeTool(exec, next)) as never),
      ctx.on('tools/post-execute', ((exec: ToolExecutionLike, result: ToolResultLike, next: () => Promise<PostDecision>) => this.tools.postTool(exec, result, next)) as never),
      ctx.on('agent/turn-stopping', ((payload: { agent: AgentLike; turn: number; signal: AbortSignal }) => this.lifecycle.turnStopping(payload)) as never),
      ctx.on('agent/disposed', ((payload: { agent: AgentLike }) => this.lifecycle.agentDisposed(payload.agent)) as never),
      // Ahead of DSH's own answerer (the person), as PermissionRequest hooks and allow rules run before Claude Code shows its dialog.
      ctx.on('approval/request', ((request: ApprovalRequest, next: () => Promise<string>) => this.tools.permission(request, next)) as never, { prepend: true }),
      // Claude Code's question dialog is a permission dialog too: PermissionRequest[AskUserQuestion] may answer or close it.
      ctx.on('user-questions/request', ((request: QuestionRequest, next: () => Promise<QuestionAnswer>) => this.tools.question(request, next)) as never, { prepend: true }),
      ctx.on('session/event', ((session: SessionLike, event: { type: string; data?: Record<string, unknown> }) => this.events.sessionEvent(session, event)) as never),
    ]
    return async () => {
      for (const dispose of disposers) dispose()
      this.beginShutdown()
      // SessionEnd hooks of sessions closed during shutdown keep their own budget.
      await Promise.allSettled([...this.engine.ending])
      this.engine.lifetime.abort()
      for (const timer of [...this.engine.notifyTimers.values(), ...this.engine.idleTimers.values()]) clearTimeout(timer)
      for (const state of this.engine.sessions.values()) for (const watcher of state.watchers) watcher.close()
    }
  }

  /**
   * DSH is exiting: the sessions still open end now, and their SessionEnd hooks start (within DSH's shutdown grace,
   * so first). Harness Forge being reloaded or removed while DSH goes on ends no session.
   */
  beginShutdown(): void {
    if (hostShuttingDown(this.ctx)) this.lifecycle.endLive()
  }

  /** Settle background hook runs (tests and shutdown). */
  async drain(): Promise<void> {
    while (this.engine.detached.size > 0) await Promise.allSettled([...this.engine.detached])
  }

  /**
   * An imported slash command was typed: `UserPromptSubmit` sees the typed
   * line, then `UserPromptExpansion` sees the command. Returns the block
   * message, or the context to send with the expanded prompt.
   */
  expandCommand(
    agent: AgentLike,
    command: { readonly name: string; readonly foreignName: string; readonly args: string; readonly expanded: string },
    signal: AbortSignal,
  ): Promise<{ blocked?: string; context: string[] }> {
    return this.lifecycle.expandCommand(agent, command, signal)
  }

  /**
   * The user typed `/skill args`: `UserPromptExpansion` sees the skill (the
   * typed line already went through `UserPromptSubmit`). Returns the block
   * message, or the reminders to send with the skill content.
   */
  expandSkill(
    agent: AgentLike,
    skill: { readonly name: string; readonly foreignName: string; readonly args: string; readonly source: string },
    signal: AbortSignal,
  ): Promise<{ blocked?: string; context: string[] }> {
    return this.lifecycle.expandSkill(agent, skill, signal)
  }

  /**
   * The DSH arguments a pending call runs with after a hook rewrote them.
   * The tool's own `tools/execute` listener reads this.
   */
  rewriteOf(callId: string | undefined): Record<string, unknown> | undefined {
    return this.tools.rewriteOf(callId)
  }

  /** A mod rewrote a call's arguments (Claude vocabulary already mapped to DSH's): the hooks and the tool see them. */
  rewrite(callId: string, args: Record<string, unknown>): void {
    this.tools.rewrite(callId, args)
  }
}
