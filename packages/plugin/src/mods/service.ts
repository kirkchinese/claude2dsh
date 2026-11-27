/**
 * Claude Code mods in DSH sessions: one mods engine per root session, every
 * imported mod loaded into it fresh (module state is the session's, as in
 * Claude Code), and the engine's events raised at DSH's call sites:
 *
 * | Event | DSH call site |
 * |---|---|
 * | session.start / session.end | `agent/created` / `agent/disposed` of a root agent |
 * | prompt.submit, turn.start | `agent/pre-step` with the user's messages / a turn's first step |
 * | turn.complete | `session/event` `turn/end` |
 * | tool.call | `tools/pre-execute` → `tools/execute` → `tools/post-execute`: the hooks wrap PreToolUse, the permission decision and the tool |
 * | tool.check | the hooks broker's decision, after PreToolUse hooks and permission rules |
 * | command.run | a command a mod registered (`$.command.register`) |
 * @module @kirkchinese/harness-forge/mods
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SurfaceSnapshot } from './surfaces.js'
import { onDsh, type DshEvent } from '../dsh/host.js'
import { ModCommands } from './service/commands.js'
import { ModDrawings } from './service/drawings.js'
import { SessionRegistry } from './service/sessions.js'
import { ModTools } from './service/tools.js'
import { ModTurns } from './service/turns.js'
import type { ClaudeVerdict, ModSource, ModsServiceHost, PostDecision, PreStep, PreStepDecision, ToolExec, ToolResult } from './service/types.js'

export type { ClaudeVerdict, ModEventRecord, ModSource, ModsServiceHost } from './service/types.js'
export { claudeInstructionFiles } from './service/turns.js'

/** Claude Code mods across the process's DSH sessions. */
export class ModsService {
  private readonly registry: SessionRegistry
  private readonly commands: ModCommands
  private readonly turns: ModTurns
  private readonly tools: ModTools
  private readonly drawings: ModDrawings

  constructor(private readonly ctx: Context, host: ModsServiceHost) {
    this.registry = new SessionRegistry(ctx, host, {
      registerCommand: (session, plugin, spec) => this.commands.registerCommand(session, plugin, spec),
      toolCore: (session, e, context) => this.tools.toolCore(session, e, context),
      checkCore: (session, e) => this.tools.checkCore(session, e),
    })
    this.commands = new ModCommands(this.registry)
    this.turns = new ModTurns(this.registry)
    this.tools = new ModTools(this.registry)
    this.drawings = new ModDrawings(this.registry)
  }

  /** Add a mod: loaded into every live session now and every session after. Returns the removal. */
  add(source: ModSource): Promise<() => Promise<void>> {
    return this.registry.add(source)
  }

  /** The loaded mods of a session, for evidence and the workbench. */
  loaded(sessionId: string): readonly string[] {
    return this.registry.loaded(sessionId)
  }

  /**
   * The process is going away: every live session's mods hear
   * `session.end` (reason `other`), as Claude Code's do at exit.
   */
  shutdown(): Promise<void> {
    return this.registry.shutdown()
  }

  /** Listen on the host. Returns the disposer. */
  install(): () => void {
    const on = (name: DshEvent, listener: unknown, options?: { prepend?: boolean }): (() => void) => onDsh(this.ctx, name, listener as never, { ...options, owner: 'mods' })
    const disposers = [
      on('agent/created', ((payload: { agent: ToolExec['agent']; signal?: AbortSignal }) => this.registry.created(payload.agent!, payload.signal)) as never),
      on('agent/disposed', ((payload: { agent: ToolExec['agent'] }) => { this.registry.disposed(payload.agent!) }) as never),
      on('agent/pre-step', ((payload: PreStep, next: () => Promise<PreStepDecision>) => this.turns.preStep(payload, next)) as never, { prepend: true }),
      on('session/event', ((session: { id: string }, event: { type: string; data: Record<string, unknown> }) => { this.turns.sessionEvent(session, event) }) as never),
      on('tools/pre-execute', ((exec: ToolExec, next: () => Promise<unknown>) => this.tools.preExecute(exec, next)) as never, { prepend: true }),
      on('tools/execute', ((exec: ToolExec, next: () => Promise<ToolResult>) => this.tools.execute(exec, next)) as never, { prepend: true }),
      on('tools/post-execute', ((exec: ToolExec, result: ToolResult, next: () => Promise<PostDecision>) => this.tools.postExecute(exec, result, next)) as never, { prepend: true }),
      on('tools/result', ((exec: ToolExec, result: ToolResult) => { this.tools.toolResult(exec, result) }) as never),
      this.commands.wrapCommands(),
    ]
    return () => {
      for (const dispose of disposers) dispose()
      for (const session of this.registry.sessions.values()) this.registry.close(session)
      this.registry.sessions.clear()
    }
  }

  /**
   * Watch the band and panes of a session, across the agents it is given (a
   * resumed session gets a new agent when the person acts). Undefined when no
   * mod is loaded at all.
   */
  watch(sessionId: string, listener: (snapshot: SurfaceSnapshot) => void): (() => void) | undefined {
    return this.drawings.watch(sessionId, listener)
  }

  /** A session's drawings, drawn afresh; undefined when the session has no mods. */
  drawn(sessionId: string): Promise<SurfaceSnapshot | undefined> {
    return this.drawings.drawn(sessionId)
  }

  /** The person acted on a control of a session's drawing. */
  act(sessionId: string, generation: number, actionId: string, value?: unknown): Promise<SurfaceSnapshot> {
    return this.drawings.act(sessionId, generation, actionId, value)
  }

  /**
   * The person closed a pane: `ui.close` with origin `person`; a hook may
   * keep it open with `{ deny }`.
   * @returns the drawing after, and the refusal when a hook kept the pane.
   */
  closePane(sessionId: string, id: string): Promise<{ snapshot: SurfaceSnapshot; refused?: string }> {
    return this.drawings.closePane(sessionId, id)
  }

  /** The person moved focus or scrolled in a session's drawing. */
  move(sessionId: string, kind: 'focus' | 'scroll', target: Readonly<Record<string, unknown>>): Promise<{ snapshot: SurfaceSnapshot; refused?: string }> {
    return this.drawings.move(sessionId, kind, target)
  }

  /** Whether a call's session has mods hooking `tool.check`. */
  checks(exec: ToolExec): boolean {
    return this.tools.checks(exec)
  }

  /**
   * `tool.check` for one call the hooks broker decided: the mods' answer over
   * Claude Code's own verdict (rules, PreToolUse hooks, the mode).
   */
  check(exec: ToolExec, verdict: ClaudeVerdict): Promise<ClaudeVerdict> {
    return this.tools.check(exec, verdict)
  }
}
