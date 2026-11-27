/**
 * Running an agent's steps on another model route (a Claude `model:` or
 * `effort:` in an agent's or a skill's frontmatter): DSH fixes a request's
 * provider, model and reasoning effort before `agent/request`, so the route is
 * selected on the agent (`agent.model.select`) for its next steps.
 * Checked against DSH 0.2.2-rc.3 and 0.2.2-rc.5.
 * @module @kirkchinese/harness-forge
 */

/** A route override: what differs from the agent's current route. */
export interface RouteOverride {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
}

interface Selection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

interface ModelAccess {
  current(): Selection | undefined
  select(selection: Selection): void
}

function modelOf(agent: unknown): ModelAccess | undefined {
  const model = (agent as { model?: Partial<ModelAccess> } | undefined)?.model
  return typeof model?.select === 'function' && typeof model.current === 'function' ? model as ModelAccess : undefined
}

/** The route with an override applied: a model of its own does not inherit the old effort. */
function overridden<T extends { provider?: string; model?: string; reasoningEffort?: string }>(base: T, route: RouteOverride): T {
  const { reasoningEffort: _inherited, ...rest } = base
  return {
    ...(route.reasoningEffort !== undefined || route.model !== undefined ? rest : base),
    ...(route.provider !== undefined ? { provider: route.provider } : {}),
    ...(route.model !== undefined ? { model: route.model } : {}),
    ...(route.reasoningEffort !== undefined ? { reasoningEffort: route.reasoningEffort } : {}),
  } as T
}

/**
 * Select the route for the agent's next steps. Returns how to put the previous selection back, or undefined where
 * the agent has no current route.
 */
export function selectRoute(agent: unknown, route: RouteOverride): { restore(): void } | undefined {
  const model = modelOf(agent)
  const current = model?.current()
  if (model === undefined || current === undefined) return undefined
  const next = overridden({ ...current }, route)
  if (next.provider === current.provider && next.model === current.model && next.reasoningEffort === current.reasoningEffort) return { restore: () => {} }
  model.select(next)
  return { restore: () => { model.select(current) } }
}
