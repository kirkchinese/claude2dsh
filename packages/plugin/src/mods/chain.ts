/**
 * The middleware chain a mods event runs through, as Claude Code's mods
 * engine defines it (claude-code.d.ts `Next`, `TraceEntry`, `HookBudget`,
 * `CatchHandler`; mods docs "Run alongside other mods"):
 *
 * - hooks nest by tier (prepend, user, append, builtin), then load order,
 *   then registration order; core (the host) is innermost;
 * - `next(e)` runs everything beneath again on each call; a hook that returns
 *   without it answers the event;
 * - a hook that throws, misreturns or outruns its budget is absent: its
 *   `.catch` handler answers within its grace, else beneath runs in its
 *   place (it had not called `next`) or its last `next` result stands;
 * - `next.to` (managed tiers only) continues at a later tier, tracing the
 *   links it bypasses; `next.trace` lists what settled beneath, nearest first.
 * @module @kirkchinese/harness-forge/mods
 */
import { errorLine, frozenCopy, isRecord, isRegExp, isThenable, messageOf } from './values.js'

/** The chain's tiers, outermost first. */
export const TIERS = ['prepend', 'user', 'append', 'builtin', 'core'] as const
export type Tier = typeof TIERS[number]
export type PluginTier = Exclude<Tier, 'core'>

/** Who raised a dispatch. */
export interface Origin {
  readonly plugin: string
  readonly tier: Tier
}

export const ENGINE_ORIGIN: Origin = Object.freeze({ plugin: 'engine', tier: 'core' })

/** A hook's own time and a `.catch` handler's grace, in milliseconds. */
export const HOOK_BUDGET_MS = 10_000
export const CATCH_BUDGET_MS = 1_000

/** Why a hook failed, as its `.catch` handler reads `next.error`. */
export interface HookFailure {
  readonly kind: 'throw' | 'timeout' | 're-entry'
  readonly message?: string
  readonly budget: number
  readonly cause?: 'rewritten' | 'lent'
}

/** A loaded mod, as the chain orders and names it. */
export interface ModRef {
  readonly name: string
  readonly tier: PluginTier
  /** Load order within its tier. */
  readonly rank: number
}

export type HookFn = ($: unknown, e: unknown, next: unknown) => unknown

/** One `on(...)` registration. */
export interface HookEntry {
  readonly id: number
  readonly mod: ModRef
  readonly pattern: string
  readonly matcher: unknown
  readonly fn: HookFn
  /** Registration order within the mod. */
  readonly seq: number
  catchFn?: HookFn
}

export type TraceOutcome = 'caught' | 'expired' | 'kept' | 'passed' | 'rejected' | 'returned' | 'skipped'

/** One link of a dispatch, as `next.trace` lists it. */
export interface TraceEntry {
  readonly index: number
  readonly plugin: string
  readonly tier: Tier
  readonly event: string
  readonly outcome: TraceOutcome
  readonly reason?: string
  readonly ms: number
  readonly received: unknown
  readonly returned: unknown
}

/** A hook run's frame: its budget, which `$` calls pause. */
export interface HookFrame {
  readonly hook: HookEntry
  readonly event: string
  readonly origin: Origin
  readonly signal: AbortSignal
  /** True until the hook (or handler) settles; `$` calls after it are the mod's own. */
  readonly active: boolean
  /** Stop the hook's clock while a `$` call is in flight; returns the resume. */
  pause(): () => void
}

/** What a dispatch needs from the engine. */
export interface DispatchRequest {
  readonly event: string
  readonly input: unknown
  readonly origin: Origin
  /** The hooks the pattern selects, in chain order. */
  readonly hooks: readonly HookEntry[]
  /** Core: the host's own behavior, or the test's stubs. */
  readonly bottom: (e: unknown, signal: AbortSignal, above: HookEntry | undefined) => Promise<unknown>
  /** What a hook's `next` resolves to, as that hook sees it (engine.create's table). */
  readonly received?: (hook: HookEntry, value: unknown) => unknown
  /** The event a hook passes to `next`, as the next reader gets it (kept in step with what it received). */
  readonly passing?: (received: unknown, passed: unknown) => unknown
  /** Each link that answered (returned or caught), as it settles: innermost first. */
  readonly observe?: (hook: HookEntry, result: unknown) => void
  /** The `$` a hook receives for this run. */
  readonly api: (frame: HookFrame) => unknown
  /** Whether a hook runs for this input (matcher and per-event rules). */
  readonly applies: (hook: HookEntry, e: unknown) => boolean
  /** Hooks skipped because the event came from their own `$` call. */
  readonly reentry?: (hook: HookEntry) => HookFailure['cause'] | boolean
  /** Why a result is the wrong shape for this event, or undefined. */
  readonly validate?: (result: unknown, called: boolean) => string | undefined
  readonly report: (line: string) => void
  readonly signal?: AbortSignal
  readonly budgetMs?: number
  readonly catchMs?: number
}

/** Whether `pattern` (a name, `ns.*`, `*`, or `!pattern`) selects `event`. */
export function selects(pattern: string, event: string): boolean {
  if (pattern.startsWith('!')) return !selects(pattern.slice(1), event) && !event.startsWith('telemetry.')
  if (pattern === '*') return !event.startsWith('telemetry.')
  if (pattern.endsWith('.*')) return event.startsWith(pattern.slice(0, -1))
  return pattern === event
}

/**
 * Whether a matcher accepts a value: a scalar is `===`, a RegExp tests the
 * value as a string, an array is any-of, an object a partial at any depth;
 * against an array value a pattern holds when some element matches.
 */
export function matches(pattern: unknown, value: unknown): boolean {
  if (Array.isArray(pattern)) return pattern.some(item => matches(item, value))
  if (Array.isArray(value) && !Array.isArray(pattern)) return value.some(item => matches(pattern, item))
  if (isRegExp(pattern)) {
    if (value === undefined || value === null || typeof value === 'object') return false
    pattern.lastIndex = 0
    return pattern.test(String(value))
  }
  if (isRecord(pattern)) {
    if (!isRecord(value)) return false
    return Object.entries(pattern).every(([key, item]) => matches(item, value[key]))
  }
  return pattern === value
}

/** Chain order: tier, then load order, then registration order. */
export function chainOrder(a: HookEntry, b: HookEntry): number {
  return TIERS.indexOf(a.mod.tier) - TIERS.indexOf(b.mod.tier) || a.mod.rank - b.mod.rank || a.seq - b.seq
}

/** A rejection that passes up through the links that let it pass. */
class LinkRejection {
  constructor(readonly error: unknown) {}
}

/** One link's run within a dispatch. */
interface LinkRecord {
  index: number
  event: string
  plugin: string
  tier: Tier
  outcome: TraceOutcome | undefined
  reason?: string
  received: unknown
  returned: unknown
  ms: number
  /** The link's latest `next` call. */
  lastCall: CallRecord | undefined
}

/** One `next` call: the links it bypassed and the nearest one that ran. */
interface CallRecord {
  readonly bypassed: LinkRecord[]
  first: LinkRecord | undefined
}

/** A hook's own-time clock: it stands still while `next` or `$` is in flight. */
class OwnClock {
  private spentMs = 0
  private since: number | undefined
  private paused = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private done = false

  constructor(readonly ms: number, private readonly onExpire: () => void) {}

  start(): void {
    this.since = performance.now()
    this.arm()
  }

  pause(): () => void {
    if (this.done) return () => {}
    if (this.paused++ === 0) this.halt()
    let resumed = false
    return () => {
      if (resumed || this.done) return
      resumed = true
      if (--this.paused === 0) {
        this.since = performance.now()
        this.arm()
      }
    }
  }

  stop(): void {
    if (this.done) return
    this.halt()
    this.done = true
  }

  get spent(): number {
    return this.spentMs + (this.since === undefined ? 0 : performance.now() - this.since)
  }

  get remaining(): number {
    return Math.max(0, this.ms - this.spent)
  }

  private halt(): void {
    if (this.since !== undefined) this.spentMs += performance.now() - this.since
    this.since = undefined
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private arm(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.paused === 0 && !this.done) this.onExpire()
    }, Math.max(0, this.ms - this.spentMs))
    this.timer.unref?.()
  }
}

/** Run one dispatch through its hooks and core. */
export async function dispatch(request: DispatchRequest): Promise<unknown> {
  const signal = request.signal ?? new AbortController().signal
  const root: CallRecord = { bypassed: [], first: undefined }
  try {
    return await runFrom(request, 0, frozenCopy(request.input), root, signal, undefined)
  } catch (error: unknown) {
    throw error instanceof LinkRejection ? error.error : error
  }
}

function runFrom(request: DispatchRequest, index: number, e: unknown, call: CallRecord, signal: AbortSignal, above: HookEntry | undefined): Promise<unknown> {
  for (let at = index; at < request.hooks.length; at++) {
    const hook = request.hooks[at]!
    if (!request.applies(hook, e)) continue
    const cause = request.reentry?.(hook)
    if (cause !== undefined && cause !== false) return reentered(request, at, hook, e, call, signal, cause, above)
    return runLink(request, at, hook, e, call, signal, above)
  }
  return runCore(request, e, call, signal, above)
}

async function runCore(request: DispatchRequest, e: unknown, call: CallRecord, signal: AbortSignal, above: HookEntry | undefined): Promise<unknown> {
  const link: LinkRecord = { index: request.hooks.length, event: request.event, plugin: 'engine', tier: 'core', outcome: undefined, received: e, returned: undefined, ms: 0, lastCall: undefined }
  call.first ??= link
  const started = performance.now()
  try {
    const result = frozenCopy(await request.bottom(e, signal, above))
    link.outcome = 'returned'
    link.returned = result
    return result
  } catch (error: unknown) {
    link.outcome = 'rejected'
    throw error instanceof LinkRejection ? error : new LinkRejection(error)
  } finally {
    link.ms = performance.now() - started
  }
}

/** A hook skipped because the event came from its own `$` call: its `.catch` may answer. */
async function reentered(request: DispatchRequest, index: number, hook: HookEntry, e: unknown, call: CallRecord, signal: AbortSignal, cause: NonNullable<HookFailure['cause']> | true, above: HookEntry | undefined): Promise<unknown> {
  if (hook.catchFn !== undefined) {
    const failure: HookFailure = { kind: 're-entry', budget: request.catchMs ?? CATCH_BUDGET_MS, ...(cause === true ? {} : { cause }) }
    const link = newLink(index, request.event, hook, e)
    call.first ??= link
    const answer = await runCatch(request, index, hook, e, link, signal, failure, undefined).catch(() => undefined)
    if (answer !== undefined) return answer
  }
  return runFrom(request, index + 1, e, call, signal, above)
}

function newLink(index: number, event: string, hook: HookEntry, e: unknown): LinkRecord {
  return { index, event, plugin: hook.mod.name, tier: hook.mod.tier, outcome: undefined, received: e, returned: undefined, ms: 0, lastCall: undefined }
}

interface NextState {
  called: boolean
  last: Promise<unknown> | undefined
  lastSettled: { ok: true; value: unknown } | { ok: false; error: unknown } | undefined
}

async function runLink(request: DispatchRequest, index: number, hook: HookEntry, e: unknown, call: CallRecord, parentSignal: AbortSignal, above: HookEntry | undefined): Promise<unknown> {
  const link = newLink(index, request.event, hook, e)
  call.first ??= link
  const controller = new AbortController()
  const abort = (): void => { controller.abort(parentSignal.reason) }
  if (parentSignal.aborted) abort()
  else parentSignal.addEventListener('abort', abort, { once: true })
  let expire: (() => void) | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    expire = () => { reject(new ExpiredError()) }
  })
  expired.catch(() => {})
  const clock = new OwnClock(request.budgetMs ?? HOOK_BUDGET_MS, () => {
    controller.abort(new Error(`${hook.mod.name}: ${request.event} hook ran out of its budget`))
    expire?.()
  })
  const state: NextState = { called: false, last: undefined, lastSettled: undefined }
  const next = makeNext(request, index, hook, link, state, clock, controller.signal)
  let active = true
  const frame: HookFrame = { hook, event: request.event, origin: request.origin, signal: controller.signal, get active() { return active }, pause: () => clock.pause() }
  clock.start()
  try {
    let result: unknown
    try {
      const out = hook.fn(request.api(frame), e, next)
      result = isThenable(out) ? await Promise.race([out, expired]) : out
    } finally {
      active = false
      clock.stop()
      link.ms = clock.spent
    }
    if (result === undefined) throw new Error('returned nothing')
    const wrong = request.validate?.(result, state.called)
    if (wrong !== undefined) throw new Error(wrong)
    const passed = state.lastSettled?.ok === true && (state.lastSettled.value === result || (request.received !== undefined && request.received(hook, state.lastSettled.value) === result))
    const settled = passed ? result : frozenCopy(result)
    link.outcome = passed ? 'passed' : 'returned'
    link.returned = settled
    if (!passed) request.observe?.(hook, settled)
    return settled
  } catch (error: unknown) {
    // A rejection from beneath that the hook let pass: its `.catch` hears it, else it passes on.
    const rejected = error instanceof LinkRejection ? error.error : state.lastSettled?.ok === false && error === state.lastSettled.error ? error : undefined
    if (rejected !== undefined && hook.catchFn === undefined) {
      link.outcome = 'rejected'
      throw error instanceof LinkRejection ? error : new LinkRejection(error)
    }
    const timedOut = error instanceof ExpiredError
    const failure: HookFailure = {
      kind: timedOut ? 'timeout' : 'throw',
      ...(timedOut ? (state.lastSettled?.ok === false ? { message: messageOf(state.lastSettled.error) } : {}) : { message: messageOf(rejected ?? error) }),
      budget: request.catchMs ?? CATCH_BUDGET_MS,
    }
    request.report(`${hook.mod.name}: ${request.event} hook ${hook.catchFn === undefined ? 'skipped' : 'failed'}: ${timedOut ? `timed out after ${String(request.budgetMs ?? HOOK_BUDGET_MS)}ms` : `threw ${errorLine(error)}`}`)
    // The handler runs once a call in flight has settled.
    if (state.last !== undefined) await state.last.catch(() => undefined)
    if (hook.catchFn !== undefined) {
      const answer = await runCatch(request, index, hook, e, link, parentSignal, failure, state).catch((caught: unknown) => {
        request.report(`${hook.mod.name}: ${request.event} hook's .catch skipped: threw ${errorLine(caught)}`)
        return undefined
      })
      if (answer !== undefined) {
        link.outcome = 'caught'
        link.returned = answer
        request.observe?.(hook, answer)
        return answer
      }
    }
    if (!state.called) {
      link.outcome = timedOut ? 'expired' : 'skipped'
      const beneath: CallRecord = { bypassed: [], first: undefined }
      link.lastCall = beneath
      return runFrom(request, index + 1, e, beneath, parentSignal, above)
    }
    link.outcome = timedOut ? 'expired' : 'kept'
    const last = state.lastSettled
    if (last?.ok === false) throw last.error instanceof LinkRejection ? last.error : new LinkRejection(last.error)
    link.returned = last?.value
    return last?.value
  } finally {
    parentSignal.removeEventListener('abort', abort)
  }
}

class ExpiredError extends Error {}

/**
 * A hook's `.catch` handler: its `next` is replay-safe. When the hook had
 * called `next`, `next(e)` resolves to that call's settled result; otherwise
 * it runs beneath once and later calls replay it.
 */
async function runCatch(request: DispatchRequest, index: number, hook: HookEntry, e: unknown, link: LinkRecord, signal: AbortSignal, failure: HookFailure, state: NextState | undefined): Promise<unknown> {
  const handler = hook.catchFn!
  let replay: Promise<unknown> | undefined = state?.lastSettled === undefined
    ? undefined
    : state.lastSettled.ok ? Promise.resolve(state.lastSettled.value) : Promise.reject(state.lastSettled.error)
  replay?.catch(() => {})
  const controller = new AbortController()
  let expire: (() => void) | undefined
  const expired = new Promise<never>((_resolve, reject) => { expire = () => { reject(new ExpiredError()) } })
  expired.catch(() => {})
  const clock = new OwnClock(request.catchMs ?? CATCH_BUDGET_MS, () => {
    controller.abort(new Error(`${hook.mod.name}: ${request.event} .catch ran out of its grace`))
    expire?.()
  })
  const next = Object.assign((argument?: unknown) => {
    if (replay === undefined) {
      const beneath: CallRecord = { bypassed: [], first: undefined }
      link.lastCall = beneath
      const resume = clock.pause()
      replay = runFrom(request, index + 1, argument === undefined ? e : frozenCopy(argument), beneath, signal, hook).finally(resume)
    }
    return replay.catch((error: unknown) => { throw error instanceof LinkRejection ? error.error : error })
  }, {
    error: Object.freeze({ ...failure }),
    called: state?.called ?? false,
    to: () => Promise.reject(new Error(`${hook.mod.name}: next.to is not available in a .catch handler`)),
    signal: controller.signal,
    event: request.event,
    origin: request.origin,
    is: (pattern: string, _e: unknown) => selects(pattern, request.event),
  })
  live(next, () => traceOf(link.lastCall), () => Object.freeze({ ms: clock.ms, remainingMs: clock.remaining }))
  let active = true
  const frame: HookFrame = { hook, event: request.event, origin: request.origin, signal: controller.signal, get active() { return active }, pause: () => clock.pause() }
  clock.start()
  try {
    const out = handler(request.api(frame), e, Object.freeze(next))
    const result = isThenable(out) ? await Promise.race([out, expired]) : out
    if (result === undefined) return undefined
    const wrong = request.validate?.(result, true)
    if (wrong !== undefined) throw new Error(wrong)
    return frozenCopy(result)
  } finally {
    active = false
    clock.stop()
  }
}

function makeNext(request: DispatchRequest, index: number, hook: HookEntry, link: LinkRecord, state: NextState, clock: OwnClock, signal: AbortSignal): unknown {
  const call = (argument: unknown, start: number, bypassed: LinkRecord[]): Promise<unknown> => {
    // A rewrite of a pinned field is refused before anything beneath runs: the hook has not called next.
    let passed: unknown
    try {
      passed = frozenCopy(argument)
      if (request.passing !== undefined) passed = frozenCopy(request.passing(link.received, passed))
    } catch (error: unknown) {
      return Promise.reject(error)
    }
    const record: CallRecord = { bypassed, first: undefined }
    link.lastCall = record
    state.called = true
    const resume = clock.pause()
    const run = (async () => {
      try {
        return await runFrom(request, start, passed, record, signal, hook)
      } finally {
        resume()
      }
    })()
    state.last = run
    run.then(
      (value) => { if (state.last === run) state.lastSettled = { ok: true, value } },
      (error: unknown) => { if (state.last === run) state.lastSettled = { ok: false, error: error instanceof LinkRejection ? error.error : error } },
    )
    return run.then(value => (request.received === undefined ? value : request.received(hook, value)), (error: unknown) => { throw error instanceof LinkRejection ? error.error : error })
  }
  const next = function next(this: unknown, ...args: unknown[]): Promise<unknown> {
    if (args.length === 0) return Promise.reject(new Error(`${hook.mod.name}: ${request.event} hook called next() without its event`))
    return call(args[0], index + 1, [])
  }
  const to = (argument: unknown, tier: Tier): Promise<unknown> => {
    const own = TIERS.indexOf(hook.mod.tier)
    const target = TIERS.indexOf(tier)
    if (hook.mod.tier !== 'prepend' && hook.mod.tier !== 'append') return Promise.reject(new Error(`${hook.mod.name}: next.to is for managed plugins (prepend, append); this plugin is ${hook.mod.tier}`))
    if (target <= own || tier === 'user' || tier === 'prepend') return Promise.reject(new Error(`${hook.mod.name}: next.to cannot continue at ${tier} from ${hook.mod.tier}`))
    let start = index + 1
    const bypassed: LinkRecord[] = []
    while (start < request.hooks.length && TIERS.indexOf(request.hooks[start]!.mod.tier) < target) {
      const skipped = request.hooks[start]!
      if (request.applies(skipped, argument)) {
        bypassed.push({ ...newLink(start, request.event, skipped, argument), outcome: 'skipped', reason: `bypassed by ${hook.mod.name}` })
      }
      start++
    }
    return call(argument, start, bypassed)
  }
  Object.assign(next, {
    to,
    signal,
    event: request.event,
    origin: request.origin,
    is: (pattern: string, _e: unknown) => selects(pattern, request.event),
  })
  live(next, () => traceOf(link.lastCall), () => Object.freeze({ ms: clock.ms, remainingMs: clock.remaining }))
  return Object.freeze(next)
}

/** `next.trace` and `next.budget` are read fresh on each access. */
function live(next: object, trace: () => readonly TraceEntry[], budget: () => unknown): void {
  Object.defineProperty(next, 'trace', { get: trace, enumerable: true })
  Object.defineProperty(next, 'budget', { get: budget, enumerable: true })
}

/** What settled beneath a link's latest call, nearest first. */
function traceOf(call: CallRecord | undefined): readonly TraceEntry[] {
  const entries: TraceEntry[] = []
  const seen = new Set<CallRecord>()
  let current = call
  while (current !== undefined && !seen.has(current)) {
    seen.add(current)
    for (const link of current.bypassed) entries.push(entryOf(link))
    const link = current.first
    if (link === undefined) break
    if (link.outcome !== undefined) entries.push(entryOf(link))
    current = link.lastCall
  }
  return Object.freeze(entries)
}

function entryOf(link: LinkRecord): TraceEntry {
  return Object.freeze({
    index: link.index,
    plugin: link.plugin,
    tier: link.tier,
    event: link.event,
    outcome: link.outcome ?? 'returned',
    ...(link.reason !== undefined ? { reason: link.reason } : {}),
    ms: link.ms,
    received: link.received,
    returned: link.outcome === 'rejected' || link.outcome === 'skipped' ? undefined : link.returned,
  })
}
