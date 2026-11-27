/**
 * Starting a delegated agent through DSH's `subagents` service: the
 * activation spec takes the task fields at the top level
 * (`SubagentActivationSpec extends SubagentStartRequest`).
 * Checked against DSH 0.2.2-rc.3 and 0.2.2-rc.5.
 * @module @kirkchinese/harness-forge
 */

/** What a delegated agent runs with. */
export interface ActivationTask {
  /** The spawning agent. */
  readonly parent: unknown
  readonly prompt: ReadonlyArray<Record<string, unknown>>
  readonly agentPreset?: string
  readonly outputSchema?: Record<string, unknown>
  /** The child's provider, model and effort, over the parent's. */
  readonly agentOptions?: { readonly provider?: string; readonly model?: string; readonly reasoningEffort?: string }
}

/** How the activation is managed. */
export interface ActivationOptions {
  readonly provider: string
  readonly label: string
  readonly signal: AbortSignal
  readonly delivery: 'parent' | 'caller'
}

/** A started activation, as far as Harness Forge reads it. */
export interface Activation {
  readonly childId?: string
  readonly result: Promise<{
    readonly structured?: unknown
    readonly output?: ReadonlyArray<{ readonly type: string; readonly text?: string }>
    readonly stopReason?: string
  }>
  dispose(): Promise<void>
}

interface SubagentsService {
  startActivation(spec: Record<string, unknown>): Promise<Activation>
}

/**
 * Start a delegated agent.
 * @param subagents - DSH's `subagents` service.
 */
export function startActivation(subagents: unknown, task: ActivationTask, options: ActivationOptions): Promise<Activation> {
  return (subagents as SubagentsService).startActivation({ ...options, ...task })
}
