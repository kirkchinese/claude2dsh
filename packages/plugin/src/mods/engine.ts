/**
 * The mods engine of one session: the loaded mods, their hooks, and the `$`
 * each hook receives, as Claude Code defines them (claude-code.d.ts; mods
 * docs). The host supplies core: what the engine does at each event and how
 * each `$` call is served. A session in DSH is one engine, so a mod's module
 * state, `$.state` and timers are the session's own, as in Claude Code.
 * @module @kirkchinese/harness-forge/mods
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  CATCH_BUDGET_MS, chainOrder, dispatch, ENGINE_ORIGIN, HOOK_BUDGET_MS, matches, selects,
  type HookEntry, type HookFn, type HookFrame, type ModRef, type Origin, type PluginTier,
} from './chain.js'
import { OPS, type OpSpec } from './ops.js'
import { deepFreeze, errorLine, frozenCopy, isRecord, isThenable, messageOf } from './values.js'

/** A mod as the host hands it to the engine. */
export interface ModDefinition {
  readonly name: string
  readonly tier?: PluginTier
  readonly root?: string
  readonly version?: string
  /** Where the plugin came from, as `plugin.register` reports it. */
  readonly provenance?: string
  /** What the module hooks and calls, read off its source. */
  readonly uses?: Readonly<Record<string, unknown>>
  readonly options?: Readonly<Record<string, unknown>>
  readonly register: (on: unknown, options: unknown) => unknown
  /** Why the engine's scan of the module's source refuses it, when it does. */
  readonly refusal?: string
  /** The module's environment, whose `Error` the rejections it receives are made of. */
  readonly realm?: { readonly Error: ErrorConstructor }
}

/** One loaded mod. */
export interface LoadedMod {
  readonly ref: ModRef
  readonly definition: ModDefinition
  readonly hooks: HookEntry[]
  readonly timers: Set<{ cancel(): void }>
}

/** What core knows about the call it serves. */
export interface CoreContext {
  /** Who raised the event. */
  readonly origin: Origin
  /** The mod whose `$` call this is, for an op. */
  readonly mod?: LoadedMod
  readonly signal: AbortSignal
}

/** What the host supplies. */
export interface EngineHost {
  /**
   * Core at an event: the engine's own behavior, innermost. An op (a `$` call)
   * answers `{ value }` or `{ deny }`; an engine event answers its result.
   * Throwing rejects the dispatch.
   */
  core(event: string, e: unknown, context: CoreContext): unknown
  /** A line for the debug log, naming the mod, the event and why. */
  report(line: string): void
  /** The element table `$.ui.resolve(e)` reads when no hook changes it, its controls stamped with the plugin. */
  elements?(surface: string, component: string, plugin: string): Readonly<Record<string, unknown>>
  /** A `$.state` value was read inside a `ui.render` run, or written. */
  /** A mod's hook (or its `.catch`) is about to run for an event. */
  ran?(mod: string, event: string): void
  stateRead?(key: string, render: RenderFrame): void
  stateWritten?(key: string): void
}

/** The `ui.render` run a state read belongs to. */
export interface RenderFrame {
  readonly mod: string
  readonly requestId?: unknown
  readonly component?: unknown
}

/** The engine's limits; Claude Code's when absent. */
export interface EngineOptions {
  readonly budgetMs?: number
  readonly catchMs?: number
}

/** The async context of a `$` call: whose calls an event came from. */
interface CallContext {
  /** Hooks whose `$` call this is, at any depth: they are skipped (re-entry). */
  readonly callers: ReadonlySet<number>
  /** Mods whose code outside its hooks made the call. */
  readonly outside: ReadonlySet<string>
  /** The `ui.render` run reading state, if any. */
  readonly render?: RenderFrame
}

/** Events whose hooks see another mod's controls, panes and band only under `plugin`. */
const OWNED_UI_EVENTS = new Set(['ui.press', 'ui.input', 'ui.select', 'ui.focus', 'ui.render', 'ui.message', 'ui.fault', 'ui.scroll'])

/** Engine events a mod's `$` raises with the event's own result. */
const EVENT_RESULTS = new Set(Object.values(OPS).filter(op => op.kind === 'event').map(op => op.event))

/** Plugin noun methods raise `<noun>.<method>` with `{ value } | { deny }` results. */
function valueOrDeny(result: unknown): string | undefined {
  if (!isRecord(result)) return 'returned neither { value } nor { deny }'
  if (typeof result['deny'] === 'string') return undefined
  if ('value' in result) return undefined
  return 'returned neither { value } nor { deny }'
}

/** Why an engine event's result is the wrong shape, per event. */
function validateEvent(event: string, result: unknown, called: boolean): string | undefined {
  if (event === 'engine.create' || event === 'turn.step') return undefined
  if (event === 'ui.render') return undefined
  if (!isRecord(result)) return `returned ${result === null ? 'null' : typeof result}, not the ${event} result`
  if (event === 'prompt.submit' && typeof result['drop'] === 'string' && called) return 'returned a drop after its next() was answered'
  if (event === 'tool.check' && !['allow', 'ask', 'deny'].includes(String(result['decision']))) return 'returned no decision of allow, ask or deny'
  if (event === 'plugin.register' && result['allow'] !== true && typeof result['refuse'] !== 'string') return 'returned neither { allow: true } nor { refuse }'
  return undefined
}

let hookIds = 0

/** A `$` call the chain refused or could not serve, as the calling plugin receives it. */
export class HooksError extends Error {
  override readonly name = 'HooksError'
}

/** A `HooksError` of the mod's own environment, so its `instanceof Error` holds. */
function hooksError(mod: LoadedMod, message: string): Error {
  const realm = mod.definition.realm
  if (realm === undefined) return new HooksError(message)
  let Realmed = realmErrors.get(realm.Error)
  if (Realmed === undefined) {
    const Base = realm.Error
    Realmed = class extends Base {
      constructor(text: string) {
        super(text)
        this.name = 'HooksError'
      }
    }
    realmErrors.set(realm.Error, Realmed)
  }
  return new Realmed(message)
}

const realmErrors = new WeakMap<ErrorConstructor, new (message: string) => Error>()

function opError(mod: LoadedMod, event: string, error: unknown): Error {
  if (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'HooksError') return error as Error
  return hooksError(mod, `${mod.ref.name}: $.${event}: ${messageOf(error)}`)
}

/** The mods engine of one session. */
export class ModsEngine {
  readonly mods: LoadedMod[] = []
  /** `$.state`, keyed `<plugin>\u0000<key>`. */
  readonly state = new Map<string, unknown>()
  private hooks: HookEntry[] = []
  /** Nouns the plugins' `engine.create` steps added: noun → method → its owner's function. */
  private nouns: Record<string, Readonly<Record<string, unknown>>> = {}
  private readonly context = new AsyncLocalStorage<CallContext>()
  private rank = 0
  private disposed = false

  constructor(private readonly host: EngineHost, private readonly options: EngineOptions = {}) {}

  /** The hooks of every loaded mod, in chain order. */
  get registered(): readonly HookEntry[] {
    return this.hooks
  }

  /**
   * Load mods: each passes `plugin.register` (the loaded mods may refuse it),
   * runs `register(on, options)`, and the batch's `engine.create` fold adds
   * the nouns they provide.
   * @returns the names refused, with who refused and why, and the ones whose
   *   `register` threw.
   */
  async load(definitions: readonly ModDefinition[]): Promise<{ refused: Array<{ name: string; by: string; reason: string }>; failed: Array<{ name: string; error: string }> }> {
    const refused: Array<{ name: string; by: string; reason: string }> = []
    const failed: Array<{ name: string; error: string }> = []
    // Every module registers first; then each joins only if the others' plugin.register hooks let it.
    const candidates: LoadedMod[] = []
    for (const definition of definitions) {
      if (this.mods.some(mod => mod.ref.name === definition.name) || candidates.some(mod => mod.ref.name === definition.name)) {
        failed.push({ name: definition.name, error: `${definition.name} is already loaded` })
        continue
      }
      if (definition.refusal !== undefined) {
        failed.push({ name: definition.name, error: definition.refusal })
        this.host.report(`${definition.name}: hooks module did not load: ${definition.refusal}`)
        continue
      }
      const mod: LoadedMod = { ref: Object.freeze({ name: definition.name, tier: definition.tier ?? 'user', rank: this.rank++ }), definition, hooks: [], timers: new Set() }
      this.pending.add(mod)
      try {
        await this.register(mod)
        candidates.push(mod)
      } catch (error: unknown) {
        this.pending.delete(mod)
        failed.push({ name: definition.name, error: messageOf(error) })
        this.host.report(`${definition.name}: hooks module did not load: ${errorLine(error)}`)
      }
    }
    const admitted = new Set(candidates)
    for (const mod of candidates) {
      const others = [...this.hooks, ...[...admitted].filter(other => other !== mod).flatMap(other => other.hooks)].sort(chainOrder)
      let refuser = ''
      const definition = mod.definition
      const verdict = await this.dispatchEngine('plugin.register', {
        name: definition.name,
        tier: mod.ref.tier,
        root: definition.root ?? '',
        provenance: definition.provenance ?? `${definition.name}@inline`,
        uses: definition.uses ?? { events: [], calls: [] },
        ...(definition.version !== undefined ? { version: definition.version } : {}),
      }, ENGINE_ORIGIN, {
        hooks: others,
        observe: (hook, result) => { if (refuser === '' && isRecord(result) && typeof result['refuse'] === 'string') refuser = hook.mod.name },
      }).catch((error: unknown) => ({ refuse: messageOf(error) }))
      if (isRecord(verdict) && typeof verdict['refuse'] === 'string') {
        admitted.delete(mod)
        refused.push({ name: definition.name, by: refuser || 'engine', reason: verdict['refuse'] })
        this.host.report(`${definition.name}: refused by ${refuser || 'engine'}: ${verdict['refuse']}`)
      }
    }
    const batch = candidates.filter(mod => admitted.has(mod))
    for (const mod of candidates) this.pending.delete(mod)
    for (const mod of batch) this.mods.push(mod)
    this.hooks = [...this.hooks, ...batch.flatMap(mod => mod.hooks)].sort(chainOrder)
    if (batch.length > 0) await this.create(batch)
    return { refused, failed }
  }

  /** Mods registering in a load, before they join the chain. */
  private readonly pending = new Set<LoadedMod>()

  /** Unload one mod: its hooks leave the chain and its timers stop. */
  async unload(name: string): Promise<void> {
    const mod = this.mods.find(item => item.ref.name === name)
    if (mod === undefined) return
    for (const timer of mod.timers) timer.cancel()
    this.mods.splice(this.mods.indexOf(mod), 1)
    this.hooks = this.hooks.filter(hook => hook.mod !== mod.ref)
    for (const [noun, owner] of Object.entries(this.nounOwners)) if (owner === name) delete this.nouns[noun]
  }

  /** Stop every mod's timers; the engine raises nothing more. */
  dispose(): void {
    this.disposed = true
    for (const mod of this.mods) for (const timer of mod.timers) timer.cancel()
  }

  /**
   * Raise one of the engine's events through every hook on it, core last.
   * @param origin who raised it: the engine unless a client or test says so.
   */
  raise(event: string, input: unknown, options: { origin?: Origin; signal?: AbortSignal } = {}): Promise<unknown> {
    return this.dispatchEngine(event, input, options.origin ?? ENGINE_ORIGIN, options.signal === undefined ? {} : { signal: options.signal })
  }

  /** The `$` a mod's code holds outside any hook (its `register`, timers, buttons). */
  apiOf(name: string): unknown {
    const mod = this.mods.find(item => item.ref.name === name)
    if (mod === undefined) throw new Error(`no mod named ${name} is loaded`)
    return this.api(mod, undefined)
  }

  /** Run `fn` outside any hook's call context: what it schedules is the engine's own, not a re-entry of a hook. */
  outside(fn: () => void): void {
    this.context.exit(fn)
  }

  /** The current `ui.render` run of a state read, if any. */
  currentRender(): RenderFrame | undefined {
    return this.context.getStore()?.render
  }

  // ---------------------------------------------------------------------------

  private nounOwners: Record<string, string> = {}

  private async register(mod: LoadedMod): Promise<void> {
    let open = true
    let seq = 0
    const unmatched = new Set<string>()
    const on = (pattern: unknown, second: unknown, third?: unknown) => {
      if (!open) throw new Error(`${mod.ref.name}: on("${String(pattern)}") after register() returned`)
      if (typeof pattern !== 'string' || pattern.length === 0) throw new Error(`${mod.ref.name}: on() takes an event name or pattern`)
      const hasMatcher = third !== undefined
      const fn = (hasMatcher ? third : second) as HookFn
      if (typeof fn !== 'function') throw new Error(`${mod.ref.name}: on("${pattern}") takes a hook function`)
      if (hasMatcher && !isRecord(second)) throw new Error(`${mod.ref.name}: on("${pattern}") takes a matcher object`)
      if (!hasMatcher) {
        if (unmatched.has(pattern)) throw new Error(`on("${pattern}") is registered twice without a matcher`)
        unmatched.add(pattern)
      }
      const hook: HookEntry = { id: ++hookIds, mod: mod.ref, pattern, matcher: hasMatcher ? deepFreeze(second) : undefined, fn, seq: seq++ }
      mod.hooks.push(hook)
      let caught = false
      return Object.freeze({
        catch: (handler: unknown) => {
          if (!open) throw new Error(`${mod.ref.name}: .catch on on("${pattern}") after register() returned`)
          if (caught) throw new Error(`${mod.ref.name}: on("${pattern}") takes one .catch`)
          if (pattern === 'engine.create') throw new Error(`${mod.ref.name}: an engine.create hook takes no .catch`)
          if (typeof handler !== 'function') throw new Error(`${mod.ref.name}: .catch takes a handler function`)
          caught = true
          hook.catchFn = handler as HookFn
        },
      })
    }
    try {
      const out = this.context.run({ callers: new Set(), outside: new Set([mod.ref.name]) }, () => mod.definition.register(on, deepFreeze({ ...(mod.definition.options ?? {}) })))
      if (isThenable(out)) await out
    } finally {
      open = false
    }
  }

  /**
   * The `engine.create` fold over a batch: the nouns its steps add. Between
   * steps the table crosses as descriptors: each step sees objects whose
   * methods raise their events as that step's plugin, so a step calling a
   * noun off its table is gated as any caller is.
   */
  private async create(batch: readonly LoadedMod[]): Promise<void> {
    const core = this.coreNouns()
    const owners = new Map<string, string>()
    const seen = new WeakMap<object, unknown>()
    const raw = (table: unknown): Record<string, unknown> => {
      const out: Record<string, unknown> = {}
      if (!isRecord(table)) return out
      for (const [noun, value] of Object.entries(table)) {
        if (noun in core || noun === 'plugin' || noun === 'state' || !isRecord(value)) continue
        out[noun] = Object.freeze(Object.fromEntries(Object.entries(value).map(([method, fn]) => [method, typeof fn === 'function' ? this.ownerOf.get(fn as never) ?? fn : fn])))
      }
      return out
    }
    const built = await this.dispatchEngine('engine.create', { plugins: batch.map(mod => mod.ref.name) }, ENGINE_ORIGIN, {
      bottom: () => ({ ...this.nouns }),
      received: (hook, value) => {
        if (!isRecord(value)) return value
        const cached = seen.get(value)
        if (cached !== undefined) return cached
        const mod = this.modOf(hook)
        const table: Record<string, unknown> = { ...(this.api(mod, undefined) as Record<string, unknown>) }
        for (const [noun, methods] of Object.entries(raw(value))) {
          table[noun] = Object.freeze(Object.fromEntries(Object.entries(methods as Record<string, unknown>).map(([method, fn]): [string, unknown] => {
            if (typeof fn !== 'function') return [method, fn]
            const wrapped = (...args: unknown[]) => this.callNoun(mod, undefined, noun, method, fn as (...args: unknown[]) => unknown, args)
            this.ownerOf.set(wrapped, fn as (...args: unknown[]) => unknown)
            return [method, wrapped]
          })))
        }
        const frozen = Object.freeze(table)
        seen.set(value, frozen)
        return frozen
      },
      observe: (hook, result) => {
        for (const noun of Object.keys(raw(result))) if (!owners.has(noun) && this.nouns[noun] === undefined) owners.set(noun, hook.mod.name)
      },
      emptyApi: true,
    })
    for (const [noun, methods] of Object.entries(raw(built))) {
      this.nouns[noun] = methods as Readonly<Record<string, unknown>>
      this.nounOwners[noun] ??= owners.get(noun) ?? ''
    }
  }

  /** The owner's function behind a noun method handed to a step. */
  private readonly ownerOf = new WeakMap<(...args: unknown[]) => unknown, (...args: unknown[]) => unknown>()

  private coreNouns(): Record<string, true> {
    const nouns: Record<string, true> = {}
    for (const name of Object.keys(OPS)) nouns[name.split('.')[0]!] = true
    return nouns
  }

  /** Hooks selected by an event, in chain order. */
  private selected(event: string): HookEntry[] {
    return this.hooks.filter(hook => selects(hook.pattern, event))
  }

  private applies(event: string) {
    return (hook: HookEntry, e: unknown): boolean => {
      if (hook.matcher !== undefined && !matches(hook.matcher, e)) return false
      // Another mod's controls, panes and band reach a hook only under `plugin`.
      if (OWNED_UI_EVENTS.has(event) && isRecord(e) && typeof e['plugin'] === 'string' && e['plugin'] !== hook.mod.name) {
        const wildcard = hook.pattern === '*' || hook.pattern.endsWith('.*')
        const named = isRecord(hook.matcher) && 'plugin' in hook.matcher
        if (!named && !(wildcard && hook.matcher === undefined)) return false
        if (named && (hook.matcher as Record<string, unknown>)['plugin'] === '*') return true
      }
      return true
    }
  }

  private reentry(): ((hook: HookEntry) => false | true) | undefined {
    const context = this.context.getStore()
    if (context === undefined || (context.callers.size === 0 && context.outside.size === 0)) return undefined
    return hook => (context.callers.has(hook.id) || context.outside.has(hook.mod.name) ? true : false)
  }

  private dispatchEngine(event: string, input: unknown, origin: Origin, extra: {
    signal?: AbortSignal
    observe?: (hook: HookEntry, result: unknown) => void
    bottom?: (e: unknown, signal: AbortSignal, above: HookEntry | undefined) => unknown
    received?: (hook: HookEntry, value: unknown) => unknown
    hooks?: readonly HookEntry[]
    emptyApi?: boolean
  } = {}): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error(`the mods engine is closed; ${event} was not raised`))
    const signal = extra.signal ?? new AbortController().signal
    const reentry = this.reentry()
    return dispatch({
      event,
      input,
      origin,
      hooks: extra.hooks === undefined ? this.selected(event) : extra.hooks.filter(hook => selects(hook.pattern, event)),
      bottom: async (e, bottomSignal, above) => (extra.bottom !== undefined
        ? extra.bottom(e, bottomSignal, above)
        : this.host.core(event, e, { origin, signal: bottomSignal })),
      api: (frame) => {
        if (extra.emptyApi !== true) return this.api(this.modOf(frame.hook), frame)
        this.host.ran?.(frame.hook.mod.name, frame.event)
        return EMPTY_API
      },
      applies: this.applies(event),
      ...(reentry !== undefined ? { reentry } : {}),
      validate: (result, called) => validateEvent(event, result, called),
      report: line => { this.host.report(line) },
      signal,
      budgetMs: this.options.budgetMs ?? HOOK_BUDGET_MS,
      catchMs: this.options.catchMs ?? CATCH_BUDGET_MS,
      ...(extra.observe !== undefined ? { observe: extra.observe } : {}),
      ...(extra.received !== undefined ? { received: extra.received } : {}),
      passing: passingFor(event),
    })
  }

  private modOf(hook: HookEntry): LoadedMod {
    return this.mods.find(mod => mod.ref === hook.mod) ?? [...this.pending].find(mod => mod.ref === hook.mod)!
  }

  /**
   * A mod's `$` call: the event of its name, raised by that mod; the calling
   * hook (or, outside hooks, the mod) is skipped by everything it raises.
   */
  private callOp(mod: LoadedMod, frame: LiveFrame | undefined, spec: OpSpec, args: readonly unknown[], signal?: AbortSignal): Promise<unknown> {
    const parent = this.context.getStore()
    const callers = new Set(parent?.callers ?? [])
    const outside = new Set(parent?.outside ?? [])
    if (frame !== undefined && frame.active) callers.add(frame.hook.id)
    else outside.add(mod.ref.name)
    const render = frame?.render ?? parent?.render
    const context: CallContext = { callers, outside, ...(render !== undefined ? { render } : {}) }
    const input = filled(spec.event, spec.input(args), mod)
    const origin: Origin = { plugin: mod.ref.name, tier: mod.ref.tier }
    const resume = frame?.active === true ? frame.pause() : () => {}
    const run = this.context.run(context, async () => {
      const result = await dispatch({
        event: spec.event,
        input,
        origin,
        hooks: this.selected(spec.event),
        bottom: async (e, bottomSignal) => this.host.core(spec.event, e, { origin, mod, signal: bottomSignal }),
        api: hookFrame => this.api(this.modOf(hookFrame.hook), hookFrame),
        applies: this.applies(spec.event),
        reentry: hook => (callers.has(hook.id) || outside.has(hook.mod.name)),
        passing: passingFor(spec.event),
        validate: (value, called) => (spec.kind === 'event' ? validateEvent(spec.event, value, called) : valueOrDeny(value)),
        report: line => { this.host.report(line) },
        signal: signal ?? frame?.signal ?? new AbortController().signal,
        budgetMs: this.options.budgetMs ?? HOOK_BUDGET_MS,
        catchMs: this.options.catchMs ?? CATCH_BUDGET_MS,
      })
      if (spec.kind === 'event') return result
      if (isRecord(result) && typeof result['deny'] === 'string') throw hooksError(mod, `${mod.ref.name}: $.${spec.event}: ${result['deny']}`)
      if (!isRecord(result) || !('value' in result)) throw hooksError(mod, `${mod.ref.name}: $.${spec.event}: returned neither { value } nor { deny }`)
      return result['value']
    })
    return run.catch((error: unknown) => { throw spec.kind === 'event' ? error : opError(mod, spec.event, error) }).finally(resume)
  }

  /** A plugin noun's method: its event through the hooks, the owner's function as core. */
  private callNoun(mod: LoadedMod, frame: LiveFrame | undefined, noun: string, method: string, fn: (...args: unknown[]) => unknown, args: readonly unknown[]): Promise<unknown> {
    const spec: OpSpec = { event: `${noun}.${method}`, kind: 'value', input: () => ({}) }
    const parent = this.context.getStore()
    const callers = new Set(parent?.callers ?? [])
    const outside = new Set(parent?.outside ?? [])
    if (frame !== undefined && frame.active) callers.add(frame.hook.id)
    else outside.add(mod.ref.name)
    const origin: Origin = { plugin: mod.ref.name, tier: mod.ref.tier }
    const resume = frame?.active === true ? frame.pause() : () => {}
    const input = args.length === 0 ? {} : args[0]
    return this.context.run({ callers, outside }, async () => {
      const result = await dispatch({
        event: spec.event,
        input,
        origin,
        hooks: this.selected(spec.event),
        bottom: async (e) => ({ value: await fn(...(args.length === 0 ? [] : [e, ...args.slice(1)])) }),
        api: hookFrame => this.api(this.modOf(hookFrame.hook), hookFrame),
        applies: this.applies(spec.event),
        reentry: hook => (callers.has(hook.id) || outside.has(hook.mod.name)),
        validate: value => valueOrDeny(value),
        report: line => { this.host.report(line) },
        budgetMs: this.options.budgetMs ?? HOOK_BUDGET_MS,
        catchMs: this.options.catchMs ?? CATCH_BUDGET_MS,
      })
      if (isRecord(result) && typeof result['deny'] === 'string') throw hooksError(mod, `${mod.ref.name}: $.${spec.event}: ${result['deny']}`)
      return isRecord(result) ? result['value'] : undefined
    }).catch((error: unknown) => { throw opError(mod, spec.event, error) }).finally(resume)
  }

  /** Build the `$` a hook run (or the mod's code outside hooks) receives. */
  private api(mod: LoadedMod, hookFrame: HookFrame | undefined): unknown {
    if (hookFrame !== undefined) this.host.ran?.(mod.ref.name, hookFrame.event)
    const frame: LiveFrame | undefined = hookFrame === undefined ? undefined : liveFrame(hookFrame, this.context.getStore()?.render ?? renderFrameOf(mod, hookFrame))
    const engine = this
    const nouns: Record<string, Record<string, unknown>> = {}
    for (const [name, spec] of Object.entries(OPS)) {
      const [noun, method] = name.split('.') as [string, string]
      nouns[noun] ??= {}
      nouns[noun]![method] = spec.kind === 'fire'
        ? (...args: unknown[]) => { void engine.callOp(mod, frame, spec, args).catch((error: unknown) => { engine.host.report(`${mod.ref.name}: $.${name}: ${messageOf(error)}`) }) }
        : (...args: unknown[]) => engine.callOp(mod, frame, spec, args, signalOption(name, args))
    }
    nouns['clock']!['after'] = (ms: number, fn: () => void) => engine.timer(mod, frame, 'clock.after', ms, fn, false)
    nouns['clock']!['every'] = (ms: number, fn: () => void) => engine.timer(mod, frame, 'clock.every', ms, fn, true)
    nouns['ui']!['resolve'] = (e: unknown) => engine.resolveElements(e, mod.ref.name)
    nouns['ui']!['ask'] = (question: string, options?: unknown) => engine.ask(mod, frame, question, options)
    nouns['state'] = {
      get: (atom: unknown) => engine.stateGet(atom, frame),
      set: (atom: unknown, value: unknown) => engine.stateSet(atom, value),
    }
    // The engine's own events a plugin raises with their own results.
    for (const event of EVENT_RESULTS) {
      const [noun, method] = event.split('.') as [string, string]
      nouns[noun] ??= {}
      nouns[noun]![method] ??= (input: unknown) => engine.callOp(mod, frame, { event, kind: 'event', input: () => (isRecord(input) ? { ...input } : {}) }, [input])
    }
    for (const [noun, methods] of Object.entries(this.nouns)) {
      const table: Record<string, unknown> = {}
      for (const [method, fn] of Object.entries(methods)) {
        table[method] = typeof fn === 'function'
          ? (...args: unknown[]) => engine.callNoun(mod, frame, noun, method, fn as (...args: unknown[]) => unknown, args)
          : fn
      }
      nouns[noun] = table
    }
    const $: Record<string, unknown> = { plugin: Object.freeze({ name: mod.ref.name, root: mod.definition.root ?? '' }) }
    for (const [noun, table] of Object.entries(nouns)) $[noun] = Object.freeze(table)
    return Object.freeze($)
  }

  private resolveElements(e: unknown, plugin: string): Readonly<Record<string, unknown>> {
    const surface = isRecord(e) && typeof e['surface'] === 'string' ? e['surface'] : 'terminal'
    const component = isRecord(e) && typeof e['component'] === 'string' ? e['component'] : 'Pane'
    return this.host.elements?.(surface, component, plugin) ?? Object.freeze({})
  }

  /** `$.ui.ask`: a `tool.call` of AskUserQuestion; resolves to the label chosen. */
  private async ask(mod: LoadedMod, frame: LiveFrame | undefined, question: string, options: unknown): Promise<string> {
    const labels = Array.isArray(options) ? options : isRecord(options) && Array.isArray(options['options']) ? options['options'] : []
    const header = isRecord(options) && typeof options['header'] === 'string' ? options['header'] : undefined
    const multiSelect = isRecord(options) && options['multiSelect'] === true
    const input = {
      tool: 'AskUserQuestion',
      questions: [{ question, ...(header !== undefined ? { header } : {}), options: labels.map(label => ({ label: String(label), description: '' })), multiSelect }],
    }
    const result = await this.callOp(mod, frame, { event: 'tool.call', kind: 'event', input: () => input }, [input])
    if (!isRecord(result)) throw new Error(`${mod.ref.name}: $.ui.ask: no answer`)
    if (typeof result['deny'] === 'string') throw new Error(`${mod.ref.name}: $.ui.ask: ${result['deny']}`)
    const answers = isRecord(result['result']) && isRecord(result['result']['answers']) ? result['result']['answers'] : undefined
    const answer = answers?.[question]
    if (typeof answer !== 'string') throw new Error(`${mod.ref.name}: $.ui.ask: the question was dismissed`)
    return answer
  }

  private timer(mod: LoadedMod, frame: LiveFrame | undefined, event: 'clock.after' | 'clock.every', ms: number, fn: () => void, repeat: boolean): { cancel(): void } {
    const controller = new AbortController()
    const timer = Object.freeze({ cancel: () => { controller.abort(); mod.timers.delete(timer) } })
    mod.timers.add(timer)
    const outside: CallContext = { callers: new Set(), outside: new Set([mod.ref.name]) }
    const spec: OpSpec = { event, kind: 'value', input: () => ({ ms: Math.max(repeat ? 1 : 0, Number(ms) || 0) }) }
    void (async () => {
      do {
        try {
          await this.callOp(mod, frame?.active === true ? undefined : frame, spec, [ms], controller.signal)
        } catch (error: unknown) {
          if (!controller.signal.aborted) this.host.report(`${mod.ref.name}: $.${event}: ${messageOf(error)}`)
          break
        }
        if (controller.signal.aborted) break
        try {
          const out = this.context.run(outside, fn)
          if (isThenable(out)) await out
        } catch (error: unknown) {
          this.host.report(`${mod.ref.name}: a ${event} callback threw ${errorLine(error)}`)
        }
      } while (repeat && !controller.signal.aborted)
      mod.timers.delete(timer)
    })()
    return timer
  }

  private stateGet(atom: unknown, frame: LiveFrame | undefined): Promise<unknown> {
    const key = stateKey(atom)
    const render = frame?.render ?? this.context.getStore()?.render
    if (render !== undefined) this.host.stateRead?.(key, render)
    return Promise.resolve(this.state.get(key))
  }

  private stateSet(atom: unknown, value: unknown): Promise<void> {
    const key = stateKey(atom)
    this.state.set(key, frozenCopy(value))
    this.host.stateWritten?.(key)
    return Promise.resolve()
  }
}

const EMPTY_API = Object.freeze({})

/** A hook frame with the `ui.render` run it draws for, if any. */
interface LiveFrame extends HookFrame {
  readonly render?: RenderFrame
}

function liveFrame(frame: HookFrame, render: RenderFrame | undefined): LiveFrame {
  return Object.create(frame, render === undefined ? {} : { render: { value: render } }) as LiveFrame
}

function renderFrameOf(mod: LoadedMod, frame: HookFrame): RenderFrame | undefined {
  if (frame.event !== 'ui.render') return undefined
  return { mod: mod.ref.name }
}

function stateKey(atom: unknown): string {
  if (isRecord(atom) && typeof atom['plugin'] === 'string' && typeof atom['key'] === 'string') return `${atom['plugin']}\u0000${atom['key']}`
  throw new Error('$.state takes an atom ({ plugin, key })')
}

function signalOption(name: string, args: readonly unknown[]): AbortSignal | undefined {
  if (name !== 'clock.sleep') return undefined
  const options = args[1]
  return isRecord(options) && typeof options['signal'] === 'object' ? options['signal'] as AbortSignal : undefined
}

/** How the engine frames each instruction file's kind in the `claudeMd` block. */
const KIND_NOTES: Readonly<Record<string, string>> = {
  managed: ' (managed policy instructions, set by your organization)',
  user: " (user's private global instructions for all projects)",
  project: ' (project instructions, checked into the codebase)',
  local: " (user's private project instructions, not checked in)",
  memory: " (user's auto-memory, persists across conversations)",
}

const CLAUDE_MD_PREAMBLE = 'Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.'

/** The `claudeMd` block text for a list of instruction files, framed as the engine frames them. */
export function claudeMdText(files: readonly unknown[]): string {
  const frames = files.filter(isRecord).map(file => `Contents of ${String(file['path'])}${KIND_NOTES[String(file['kind'])] ?? ''}:\n\n${String(file['content'] ?? '')}`)
  return frames.length === 0 ? '' : `${CLAUDE_MD_PREAMBLE}\n\n${frames.join('\n\n')}`
}

/**
 * `prompt.context` keeps the `claudeMd` text and its files in step at every
 * link: a changed list renders the text the next reader gets; a rewritten
 * text makes the files unknown from there on.
 */
function keepContextInStep(received: unknown, passed: unknown): unknown {
  if (!isRecord(received) || !isRecord(passed) || !Array.isArray(passed['blocks'])) return passed
  const textOf = (e: Record<string, unknown>): unknown => (Array.isArray(e['blocks']) ? e['blocks'].find(block => isRecord(block) && block['name'] === 'claudeMd') : undefined) as unknown
  const before = received['instructionFiles']
  const after = passed['instructionFiles']
  if (Array.isArray(after) && JSON.stringify(after) !== JSON.stringify(before)) {
    const text = claudeMdText(after)
    const blocks = passed['blocks'] as unknown[]
    const at = blocks.findIndex(block => isRecord(block) && block['name'] === 'claudeMd')
    const next = at === -1 ? (text.length > 0 ? [{ name: 'claudeMd', text }, ...blocks] : blocks) : blocks.map((block, index) => (index === at ? { ...(block as object), text } : block))
    return { ...passed, blocks: next }
  }
  const oldBlock = textOf(received)
  const newBlock = textOf(passed)
  if (JSON.stringify(oldBlock) !== JSON.stringify(newBlock) && JSON.stringify(after) === JSON.stringify(before)) {
    const { instructionFiles: _unknown, ...rest } = passed
    return rest
  }
  return passed
}

/**
 * Fields an event pins (claude-code.d.ts "Pinned"): a hook passing a
 * different value to `next` is refused; one left out is put back.
 * `except` pins every field but those.
 */
const PINNED: Readonly<Record<string, readonly string[] | { readonly except: readonly string[] }>> = {
  'tool.call': ['tool', 'tool_use_id', 'agentId'],
  'tool.check': ['tool', 'input', 'tool_use_id', 'agentId'],
  'tool.describe': ['provider'],
  'agent.offer': ['provider'],
  'agent.spawn': ['tool_use_id', 'provider', 'parentModel', 'parentAgentId', 'permissionMode', 'fork', 'name'],
  'command.describe': ['provider'],
  'command.run': ['presentation'],
  'config.describe': ['key', 'provider'],
  'config.set': ['key', 'previous', 'provider', 'origin'],
  'env.get': ['name'],
  'env.set': ['name'],
  'ui.open': ['id'],
  'ui.close': ['id', 'origin'],
  'plugin.register': { except: [] },
  'prompt.attachment': ['type', 'origin', 'agentId', 'kind'],
  'prompt.compose': ['model'],
  'prompt.edit': ['origin', 'key'],
  'prompt.fill': ['origin'],
  'prompt.suggest': ['origin'],
  'session.append': ['door', 'origin', 'uuid', 'agentId'],
  'session.compact': ['trigger', 'agentId'],
  'turn.complete': ['agentId'],
  'turn.step': ['turnId', 'index', 'messageCount', 'agentId'],
  'ui.focus': { except: ['element'] },
  'ui.scroll': { except: ['offset'] },
  'skill.prompt': { except: ['text', 'frontmatter'] },
}

/** What a hook's `next(e)` passes on: pinned fields held, `prompt.context` kept in step. */
function passingFor(event: string): ((received: unknown, passed: unknown) => unknown) | undefined {
  const pinned = PINNED[event]
  const context = event === 'prompt.context'
  if (pinned === undefined && !context) return undefined
  return (received, passed) => {
    let out = passed
    if (pinned !== undefined && isRecord(received) && isRecord(passed)) {
      const fields = Array.isArray(pinned) ? pinned : Object.keys(received).filter(key => !(pinned as { except: readonly string[] }).except.includes(key))
      const restored: Record<string, unknown> = { ...passed }
      for (const field of fields) {
        if (!(field in received)) continue
        if (!(field in passed) || passed[field] === undefined) {
          restored[field] = received[field]
          continue
        }
        if (JSON.stringify(passed[field]) !== JSON.stringify(received[field])) throw new Error(`${event}: ${field} is pinned; a rewrite is refused`)
      }
      out = restored
    }
    return context ? keepContextInStep(received, out) : out
  }
}

let callIds = 0

/** What the engine fills in a plugin's call: a note's door, origin and id; a tool call's id. */
function filled(event: string, input: Record<string, unknown>, mod: LoadedMod): Record<string, unknown> {
  if (event === 'session.append') {
    const message = isRecord(input['message']) ? input['message'] : {}
    return {
      ...input,
      message: { ...message, ...(message['type'] === 'user' ? { role: 'user', isMeta: true } : {}) },
      door: 'note',
      origin: { kind: 'plugin', plugin: mod.ref.name },
      uuid: crypto.randomUUID(),
    }
  }
  if (event === 'tool.call' && input['tool_use_id'] === undefined) return { ...input, tool_use_id: `toolu_mod_${String(++callIds)}` }
  return input
}
