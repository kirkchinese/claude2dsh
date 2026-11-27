/**
 * Plain-data helpers for the mods engine: events and results cross between a
 * mod's environment and the host as deeply frozen plain data.
 * @module @kirkchinese/harness-forge/mods
 */

/** Whether a value is a RegExp, from any realm. */
export function isRegExp(value: unknown): value is RegExp {
  return Object.prototype.toString.call(value) === '[object RegExp]'
}

/** Whether a value is a plain object (not an array, RegExp or null), from any realm. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isRegExp(value)
}

/** Whether a value is a promise-like, from any realm. */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null && typeof (value as { then?: unknown }).then === 'function'
}

const MAX_DEPTH = 28_000

/**
 * Deeply freeze a value in place and return it. Functions (a Button's
 * `onPress`) stay callable; they are frozen as objects only.
 */
export function deepFreeze<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH) throw new Error(`nesting deeper than ${String(MAX_DEPTH)} levels is not supported`)
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key], depth + 1)
  return Object.freeze(value)
}

/**
 * A frozen copy of an event as it crosses into the chain: plain objects and
 * arrays are copied; functions, RegExps and other objects are kept by
 * reference (a render tree's callbacks must stay the plugin's own).
 */
export function frozenCopy<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH) throw new Error(`nesting deeper than ${String(MAX_DEPTH)} levels is not supported`)
  if (Array.isArray(value)) return Object.freeze(value.map(item => frozenCopy(item, depth + 1))) as T
  if (isRecord(value) && isPlain(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = frozenCopy(item, depth + 1)
    return Object.freeze(out) as T
  }
  return value
}

function isPlain(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null
  return proto === null || Object.getPrototypeOf(proto) === null
}

/** JSON round trip, as `$.store.set` keeps values. */
export function jsonCopy(value: unknown): unknown {
  if (value === undefined) return undefined
  const text = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'function') throw new Error('a function is not JSON data')
    if (typeof item === 'bigint') throw new Error('a bigint is not JSON data')
    return item
  })
  return text === undefined ? undefined : JSON.parse(text) as unknown
}

/** Structural equality over plain data (cross-realm), as `toEqual` reads it. */
export function plainEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const other = b as unknown[]
    return a.length === other.length && a.every((item, index) => plainEqual(item, other[index]))
  }
  const left = Object.keys(a).filter(key => (a as Record<string, unknown>)[key] !== undefined)
  const right = Object.keys(b as object).filter(key => (b as Record<string, unknown>)[key] !== undefined)
  return left.length === right.length && left.every(key => plainEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}

/** An error's text as Claude Code's notices print it: `Error: boom`. */
export function errorLine(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const named = (error as { name?: unknown }).name
    const name = typeof named === 'string' ? named : 'Error'
    return `${name}: ${String((error as { message: unknown }).message)}`
  }
  return String(error)
}

/** An error's message alone. */
export function messageOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'message' in error ? String((error as { message: unknown }).message) : String(error)
}
