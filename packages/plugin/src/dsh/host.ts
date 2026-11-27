/**
 * The DSH services and events Harness Forge uses, in one place.
 *
 * Every service and event below is declared by a DSH package (its Cordis
 * `Context` or `Events` augmentation), so it is DSH's plugin surface rather
 * than an internal; but DSH is pre-1.0 and changes it between releases, and
 * Harness Forge does not import those packages' types (most are not its
 * dependencies). So the names are listed here with the package that declares
 * them, the only place that reaches them untyped: an upgrade of DSH is checked
 * against this list. Checked against DSH 0.2.2-rc.3 and 0.2.2-rc.5.
 *
 * What is not DSH's surface at all lives beside this module: the command
 * interception (`commands.ts`).
 * @module @kirkchinese/harness-forge
 */

import type { FiberState } from '@deepseek-ai/cordis'

/** Services read with `ctx.get`, by the DSH package that provides them. */
export const DSH_SERVICES = {
  agentDefaultModel: '@deepseek-ai/dsh-agent-default-model',
  agentPresets: '@deepseek-ai/dsh-agent-preset-registry',
  agents: '@deepseek-ai/dsh-agent',
  approval: '@deepseek-ai/dsh-user-approval',
  capabilityCatalog: '@kirkchinese/dsh-capability-catalog',
  capabilityCatalogServers: '@kirkchinese/dsh-capability-catalog',
  commands: '@deepseek-ai/dsh-commands',
  deepseekAccount: '@deepseek-ai/dsh-deepseek-account',
  llm: '@deepseek-ai/dsh-llm',
  permissionPresets: '@deepseek-ai/dsh-permission-presets',
  planMode: '@deepseek-ai/dsh-plan-mode',
  pluginManager: '@deepseek-ai/dsh-plugin-manager',
  profileContext: '@deepseek-ai/dsh-app-boot',
  recollect: '@kirkchinese/dsh-recollect',
  sessionController: '@deepseek-ai/dsh-api-session-controller',
  sessionPersistence: '@deepseek-ai/dsh-session-persistence',
  sessionTitle: '@deepseek-ai/dsh-session-title',
  shell: '@deepseek-ai/dsh-shell',
  skills: '@deepseek-ai/dsh-skill',
  subagents: '@deepseek-ai/dsh-subagent',
  systemPrompt: '@deepseek-ai/dsh-system-prompt',
  tokenMeter: '@deepseek-ai/dsh-token-meter',
  tools: '@deepseek-ai/dsh-tools',
  userQuestions: '@deepseek-ai/dsh-user-questions',
  webServer: '@deepseek-ai/dsh-host-webserver',
  workingDirectory: '@deepseek-ai/dsh-working-directory',
} as const

/** Events listened to with `ctx.on`, by the DSH package that declares them. */
export const DSH_EVENTS = {
  'agent/created': '@deepseek-ai/dsh-agent',
  'agent/disposed': '@deepseek-ai/dsh-agent',
  'agent/pre-step': '@deepseek-ai/dsh-agent',
  'agent/request': '@deepseek-ai/dsh-agent',
  'agent/turn-stopping': '@deepseek-ai/dsh-agent',
  'approval/request': '@deepseek-ai/dsh-user-approval',
  'session/event': '@deepseek-ai/dsh-session',
  'subagent/end': '@deepseek-ai/dsh-subagent',
  'subagent/start': '@deepseek-ai/dsh-subagent',
  'system-prompt/assemble': '@deepseek-ai/dsh-system-prompt',
  'tools/change': '@deepseek-ai/dsh-tools',
  'tools/execute': '@deepseek-ai/dsh-tools',
  'tools/post-execute': '@deepseek-ai/dsh-tools',
  'tools/pre-execute': '@deepseek-ai/dsh-tools',
  'tools/result': '@deepseek-ai/dsh-tools',
  'user-questions/request': '@deepseek-ai/dsh-user-questions',
} as const

export type DshService = keyof typeof DSH_SERVICES
export type DshEvent = keyof typeof DSH_EVENTS

interface Host {
  get(name: string): unknown
  on(name: string, listener: (...args: never[]) => unknown, options?: { prepend?: boolean }): () => void
}

/**
 * A DSH service, or undefined when the profile does not compose it; the caller states the shape it relies on.
 * @param ctx - a Cordis context: the plugin's, or an agent's (`agent.ctx`, where agent-scoped services live).
 */
export function dshService(ctx: object | undefined, name: DshService): unknown {
  return (ctx as Partial<Host> | undefined)?.get?.(name)
}

/** How a listener is added; its failure is logged and handed to the context's fault sink (`reportFaults`). */
export interface ListenOptions {
  readonly prepend?: boolean
  /** Names the part of Harness Forge the listener belongs to, in the log. */
  readonly owner?: string
}

/**
 * Listen to a DSH event; returns the disposer (for `ctx.effect`).
 *
 * The listener is isolated: when it throws, the failure is logged and the event goes on as if the listener had
 * not been there. A waterfall listener's `next` (its last argument) is called then, unless the listener already
 * called it, whose result stands; so one failing part of Harness Forge never fails a tool call, a step or a prompt
 * of DSH or of the other parts. A cancellation (`AbortError`) still propagates.
 */
export function onDsh(ctx: object, name: DshEvent, listener: (...args: never[]) => unknown, options: ListenOptions = {}): () => void {
  const report = (error: unknown): void => {
    try {
      const logger = (ctx as { logger?: { warn?(...args: unknown[]): void } }).logger
      logger?.warn?.(`harness-forge${options.owner !== undefined ? `/${options.owner}` : ''}: ${name} listener failed: ${error instanceof Error ? error.message : String(error)}`)
      faultSinks.get(ctx)?.(error, name)
    } catch {
      // Reporting never fails the event.
    }
  }
  const guarded = (...args: unknown[]): unknown => {
    const last = args.at(-1)
    let forwarded: { result: unknown } | undefined
    // What the rest of the chain threw is not this listener's failure: it propagates as it would have.
    let downstream: { error: unknown } | undefined
    const next = typeof last === 'function'
      ? (...nextArgs: unknown[]): unknown => {
          if (forwarded === undefined) {
            try {
              forwarded = { result: (last as (...a: unknown[]) => unknown)(...nextArgs) }
            } catch (error: unknown) {
              downstream = { error }
              throw error
            }
            if (forwarded.result instanceof Promise) forwarded.result.then(undefined, (error: unknown) => { downstream = { error } })
          }
          return forwarded.result
        }
      : undefined
    const recover = (error: unknown): unknown => {
      if (isAbort(error) || (downstream !== undefined && downstream.error === error)) throw error
      report(error)
      if (next === undefined) return undefined
      return forwarded !== undefined ? forwarded.result : next()
    }
    try {
      const result = (listener as (...a: unknown[]) => unknown)(...(next === undefined ? args : [...args.slice(0, -1), next]))
      return result instanceof Promise ? result.catch(recover) : result
    } catch (error: unknown) {
      return recover(error)
    }
  }
  return (ctx as Host).on(name, guarded as never, options.prepend === undefined ? undefined : { prepend: options.prepend })
}

/** Where the listeners of one context report their failures, besides the log: the row's fault record. */
const faultSinks = new WeakMap<object, (error: unknown, event: DshEvent) => void>()

/** Report the failures of every listener `onDsh` adds on `ctx` to `fault`. Returns the disposer. */
export function reportFaults(ctx: object, fault: (error: unknown, event: DshEvent) => void): () => void {
  faultSinks.set(ctx, fault)
  return () => { if (faultSinks.get(ctx) === fault) faultSinks.delete(ctx) }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

interface FiberLike {
  readonly state?: number
  readonly parent?: { readonly fiber?: FiberLike }
}

/** Cordis fiber states that mean a fiber is going away; the types check the numbers against Cordis's own enum. */
const DISPOSED: FiberState.DISPOSED = 4
const UNLOADING: FiberState.UNLOADING = 5
const LEAVING = new Set<number>([DISPOSED, UNLOADING])

/**
 * Whether DSH is tearing down the tree this plugin runs in (exiting), as opposed to this plugin alone being
 * unloaded or reloaded (an upgrade, a config change) while DSH and its sessions go on: a fiber above the plugin's
 * own is unloading. DSH has no public "exiting" signal (0.2.2-rc.3: `app-boot` emits only `config-reload`), so the
 * fiber states of Cordis 4 tell.
 */
export function hostShuttingDown(ctx: object): boolean {
  const own = (ctx as { fiber?: FiberLike }).fiber
  let fiber = own?.parent?.fiber
  for (let depth = 0; fiber !== undefined && fiber !== own && depth < 64; depth++) {
    if (fiber.state !== undefined && LEAVING.has(fiber.state)) return true
    const parent: FiberLike | undefined = fiber.parent?.fiber
    if (parent === fiber) break
    fiber = parent
  }
  return false
}

interface WorkingDirectoryLike {
  ensure(agent: unknown, signal: AbortSignal): Promise<string>
  get(session: unknown): string | undefined
}

/** A session's working directory, as hooks and commands see it (`workingDirectory`, else the process's). */
export async function sessionDirectory(ctx: object, agent: unknown, signal: AbortSignal): Promise<string> {
  const service = dshService(ctx, 'workingDirectory') as WorkingDirectoryLike | undefined
  if (service === undefined || agent === undefined) return process.cwd()
  try {
    return await service.ensure(agent, signal)
  } catch {
    return service.get((agent as { session?: unknown }).session) ?? process.cwd()
  }
}

/** The agent preset a session runs under (`agentPresets.presetForSession`). */
export function presetOfSession(ctx: object, session: unknown): string | undefined {
  const presets = dshService(ctx, 'agentPresets') as { presetForSession?(session: unknown): string | null } | undefined
  try {
    return presets?.presetForSession?.(session) ?? undefined
  } catch {
    return undefined
  }
}

/** The last turn of a session (`agents.turnBoundaryOf`), or undefined. */
export function lastTurnOf(ctx: object, session: unknown): number | undefined {
  const agents = dshService(ctx, 'agents') as { turnBoundaryOf?(session: unknown): { lastTurn?: number } } | undefined
  try {
    return agents?.turnBoundaryOf?.(session).lastTurn
  } catch {
    return undefined
  }
}

/** A session's context pressure (`tokenMeter.contextPressure`), or undefined. */
export function contextPressureOf(ctx: object, session: unknown): { readonly pressureTokens?: number; readonly contextWindow?: number } | undefined {
  const meter = dshService(ctx, 'tokenMeter') as { contextPressure?(session: unknown): { pressureTokens?: number; contextWindow?: number } } | undefined
  try {
    return meter?.contextPressure?.(session)
  } catch {
    return undefined
  }
}

/** Whether an agent's session is in plan mode (`planMode.get`). */
export function planModeActive(ctx: object, agent: unknown): boolean {
  const planMode = dshService(ctx, 'planMode') as { get?(agent: unknown): { active?: boolean } } | undefined
  try {
    return planMode?.get?.(agent).active === true
  } catch {
    return false
  }
}
