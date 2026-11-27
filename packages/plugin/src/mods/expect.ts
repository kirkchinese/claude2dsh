/**
 * `expect` of `claude-code/testing`: the checks claude-code.d.ts `Matchers`
 * and `Matching` declare, comparing plain data across environments.
 * @module @kirkchinese/harness-forge/mods
 */
import { isRegExp, isThenable } from './values.js'

/** A failed check. */
export class ExpectationError extends Error {
  override readonly name = 'ExpectationError'
}

const ASYMMETRIC = Symbol.for('claude-code.testing.asymmetric')

interface Asymmetric {
  readonly [ASYMMETRIC]: (value: unknown) => boolean
  readonly text: string
}

function asymmetric(text: string, test: (value: unknown) => boolean): Asymmetric {
  return Object.freeze({ [ASYMMETRIC]: test, text, toString: () => text, toJSON: () => text })
}

function isAsymmetric(value: unknown): value is Asymmetric {
  return typeof value === 'object' && value !== null && ASYMMETRIC in value
}

function describe(value: unknown): string {
  if (isAsymmetric(value)) return value.text
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'function') return `[Function ${(value as { name?: string }).name ?? ''}]`
  if (isRegExp(value)) return String(value)
  if (value === undefined) return 'undefined'
  try {
    const text = JSON.stringify(value, (_key, item: unknown) => (item === undefined ? '__undefined__' : isAsymmetric(item) ? item.text : typeof item === 'bigint' ? `${item}n` : item))
    return (text ?? String(value)).replace(/"__undefined__"/gu, 'undefined')
  } catch {
    return String(value)
  }
}

function tag(value: unknown): string {
  return Object.prototype.toString.call(value)
}

/** `toEqual`: recursive equality, undefined properties ignored; `strict` keeps them and checks arrays' holes and types. */
export function equals(a: unknown, b: unknown, strict = false): boolean {
  if (isAsymmetric(b)) return b[ASYMMETRIC](a)
  if (isAsymmetric(a)) return a[ASYMMETRIC](b)
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (tag(a) !== tag(b)) return false
  if (isRegExp(a)) return String(a) === String(b)
  if (a instanceof Date || tag(a) === '[object Date]') return (a as Date).getTime() === (b as Date).getTime()
  if (Array.isArray(a)) {
    const other = b as unknown[]
    if (a.length !== other.length) return false
    return a.every((item, index) => equals(item, other[index], strict))
  }
  if (tag(a) === '[object Map]') {
    const left = a as Map<unknown, unknown>
    const right = b as Map<unknown, unknown>
    return left.size === right.size && [...left].every(([key, item]) => right.has(key) && equals(item, right.get(key), strict))
  }
  if (tag(a) === '[object Set]') {
    const left = [...(a as Set<unknown>)]
    const right = [...(b as Set<unknown>)]
    return left.length === right.length && left.every(item => right.some(other => equals(item, other, strict)))
  }
  if (ArrayBuffer.isView(a)) {
    const left = a as unknown as ArrayLike<unknown>
    const right = b as unknown as ArrayLike<unknown>
    return left.length === right.length && Array.from(left).every((item, index) => item === right[index])
  }
  const keys = (value: object): string[] => Object.keys(value).filter(key => strict || (value as Record<string, unknown>)[key] !== undefined)
  const left = keys(a)
  const right = keys(b)
  if (left.length !== right.length) return false
  if (strict && Object.getPrototypeOf(a)?.constructor?.name !== Object.getPrototypeOf(b)?.constructor?.name) return false
  return left.every(key => Object.prototype.hasOwnProperty.call(b, key) && equals((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], strict))
}

/** `toMatchObject`: every property of the pattern matches, recursively. */
function matchesObject(value: unknown, pattern: unknown): boolean {
  if (isAsymmetric(pattern)) return pattern[ASYMMETRIC](value)
  if (Array.isArray(pattern)) {
    return Array.isArray(value) && value.length === pattern.length && pattern.every((item, index) => matchesObject(value[index], item))
  }
  if (typeof pattern === 'object' && pattern !== null && !isRegExp(pattern) && tag(pattern) === '[object Object]') {
    if (typeof value !== 'object' || value === null) return false
    return Object.keys(pattern).every(key => key in (value as object) && matchesObject((value as Record<string, unknown>)[key], (pattern as Record<string, unknown>)[key]))
  }
  return equals(value, pattern)
}

function hasPath(value: unknown, path: string | readonly string[]): { found: boolean; value: unknown } {
  const parts = Array.isArray(path) ? path : String(path).replace(/\[(\d+)\]/gu, '.$1').split('.').filter(part => part.length > 0)
  let current: unknown = value
  for (const part of parts) {
    if (current === null || current === undefined || !(typeof current === 'object' || typeof current === 'function') || !(part in (current as object))) return { found: false, value: undefined }
    current = (current as Record<string, unknown>)[part]
  }
  return { found: true, value: current }
}

function thrownMatches(error: unknown, expected: unknown): boolean {
  if (expected === undefined) return true
  const message = typeof error === 'object' && error !== null && 'message' in error ? String((error as { message: unknown }).message) : String(error)
  if (typeof expected === 'string') return message.includes(expected)
  if (isRegExp(expected)) return expected.test(message)
  if (typeof expected === 'function') return error instanceof (expected as new () => unknown) || (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === (expected as { name?: unknown }).name)
  if (typeof expected === 'object' && expected !== null && 'message' in expected) return message === String((expected as { message: unknown }).message)
  return false
}

type Check = (received: unknown, ...args: unknown[]) => { pass: boolean; message: string }

const CHECKS: Readonly<Record<string, Check>> = {
  toBe: (r, e) => ({ pass: Object.is(r, e), message: `expected ${describe(r)} to be ${describe(e)}` }),
  toEqual: (r, e) => ({ pass: equals(r, e), message: `expected ${describe(r)} to equal ${describe(e)}` }),
  toStrictEqual: (r, e) => ({ pass: equals(r, e, true), message: `expected ${describe(r)} to strictly equal ${describe(e)}` }),
  toMatchObject: (r, e) => ({ pass: matchesObject(r, e), message: `expected ${describe(r)} to match object ${describe(e)}` }),
  toContain: (r, e) => ({
    pass: typeof r === 'string' ? r.includes(String(e)) : r !== null && typeof r === 'object' && Symbol.iterator in r ? [...(r as Iterable<unknown>)].some(item => item === e) : false,
    message: `expected ${describe(r)} to contain ${describe(e)}`,
  }),
  toContainEqual: (r, e) => ({ pass: r !== null && typeof r === 'object' && Symbol.iterator in r && [...(r as Iterable<unknown>)].some(item => equals(item, e)), message: `expected ${describe(r)} to contain an item equal to ${describe(e)}` }),
  toHaveLength: (r, e) => ({ pass: r !== null && r !== undefined && (r as { length?: unknown }).length === e, message: `expected ${describe(r)} to have length ${describe(e)} (it has ${String((r as { length?: unknown } | null)?.length)})` }),
  toHaveProperty: (r, path, ...value) => {
    const found = hasPath(r, path as string)
    return { pass: found.found && (value.length === 0 || equals(found.value, value[0])), message: `expected ${describe(r)} to have property ${describe(path)}${value.length > 0 ? ` equal to ${describe(value[0])}` : ''}` }
  },
  toBeUndefined: r => ({ pass: r === undefined, message: `expected ${describe(r)} to be undefined` }),
  toBeDefined: r => ({ pass: r !== undefined, message: `expected ${describe(r)} to be defined` }),
  toBeNull: r => ({ pass: r === null, message: `expected ${describe(r)} to be null` }),
  toBeTruthy: r => ({ pass: Boolean(r), message: `expected ${describe(r)} to be truthy` }),
  toBeFalsy: r => ({ pass: !r, message: `expected ${describe(r)} to be falsy` }),
  toBeNaN: r => ({ pass: Number.isNaN(r), message: `expected ${describe(r)} to be NaN` }),
  toBeGreaterThan: (r, e) => ({ pass: (r as number) > (e as number), message: `expected ${describe(r)} to be greater than ${describe(e)}` }),
  toBeGreaterThanOrEqual: (r, e) => ({ pass: (r as number) >= (e as number), message: `expected ${describe(r)} to be at least ${describe(e)}` }),
  toBeLessThan: (r, e) => ({ pass: (r as number) < (e as number), message: `expected ${describe(r)} to be less than ${describe(e)}` }),
  toBeLessThanOrEqual: (r, e) => ({ pass: (r as number) <= (e as number), message: `expected ${describe(r)} to be at most ${describe(e)}` }),
  toMatch: (r, e) => ({ pass: typeof r === 'string' && (isRegExp(e) ? new RegExp(e.source, e.flags.replace('g', '')).test(r) : r.includes(String(e))), message: `expected ${describe(r)} to match ${describe(e)}` }),
  toStartWith: (r, e) => ({ pass: typeof r === 'string' && r.startsWith(String(e)), message: `expected ${describe(r)} to start with ${describe(e)}` }),
  toEndWith: (r, e) => ({ pass: typeof r === 'string' && r.endsWith(String(e)), message: `expected ${describe(r)} to end with ${describe(e)}` }),
  toBeInstanceOf: (r, e) => ({ pass: typeof e === 'function' && (r instanceof (e as new () => unknown) || (typeof r === 'object' && r !== null && Object.getPrototypeOf(r)?.constructor?.name === (e as { name: string }).name)), message: `expected ${describe(r)} to be an instance of ${(e as { name?: string }).name ?? 'the class'}` }),
}

/** Build an `expect` that reports each failed check to `fail` before throwing. */
export function createExpect(fail: (error: ExpectationError) => void): unknown {
  const raise = (message: string, note: string | undefined): never => {
    const error = new ExpectationError(note === undefined ? message : `${note}: ${message}`)
    fail(error)
    throw error
  }
  const matchers = (received: unknown, note: string | undefined, negate: boolean): Record<string, (...args: unknown[]) => void> => {
    const table: Record<string, (...args: unknown[]) => void> = {}
    for (const [name, check] of Object.entries(CHECKS)) {
      table[name] = (...args: unknown[]) => {
        const { pass, message } = check(received, ...args)
        if (pass === negate) raise(negate ? message.replace(/^expected (.*?) to /u, 'expected $1 not to ') : message, note)
      }
    }
    table['toThrow'] = (expected?: unknown) => {
      if (typeof received !== 'function') return raise(`expected a function to call, got ${describe(received)}`, note)
      let thrown = false
      let error: unknown
      try {
        const out = (received as () => unknown)()
        if (isThenable(out)) (out as Promise<unknown>).catch(() => {})
      } catch (caught: unknown) {
        thrown = true
        error = caught
      }
      const pass = thrown && thrownMatches(error, expected)
      if (pass === negate) raise(negate ? `expected the function not to throw${expected === undefined ? '' : ` ${describe(expected)}`}` : `expected the function to throw${expected === undefined ? '' : ` ${describe(expected)}`}${thrown ? `, it threw ${describe((error as { message?: unknown })?.message ?? error)}` : ''}`, note)
    }
    return table
  }
  const settled = (received: unknown, note: string | undefined, mode: 'resolves' | 'rejects', negate: boolean): Record<string, (...args: unknown[]) => Promise<void>> => {
    const table: Record<string, (...args: unknown[]) => Promise<void>> = {}
    for (const name of [...Object.keys(CHECKS), 'toThrow']) {
      table[name] = async (...args: unknown[]) => {
        let value: unknown
        try {
          const resolved = await (received as Promise<unknown>)
          if (mode === 'rejects') return raise(`expected the promise to reject, it resolved ${describe(resolved)}`, note)
          value = resolved
        } catch (error: unknown) {
          if (error instanceof ExpectationError) throw error
          if (mode === 'resolves') return raise(`expected the promise to resolve, it rejected ${describe((error as { message?: unknown })?.message ?? error)}`, note)
          value = error
        }
        if (name === 'toThrow') {
          const pass = thrownMatches(value, args[0])
          if (pass === negate) raise(`expected the rejection ${describe((value as { message?: unknown })?.message ?? value)} ${negate ? 'not ' : ''}to match ${describe(args[0])}`, note)
          return
        }
        matchers(value, note, negate)[name]!(...args)
      }
    }
    return table
  }
  const expect = (received: unknown, note?: string) => Object.freeze({
    ...matchers(received, note, false),
    not: Object.freeze(matchers(received, note, true)),
    resolves: Object.freeze({ ...settled(received, note, 'resolves', false), not: Object.freeze(settled(received, note, 'resolves', true)) }),
    rejects: Object.freeze({ ...settled(received, note, 'rejects', false), not: Object.freeze(settled(received, note, 'rejects', true)) }),
  })
  return Object.freeze(Object.assign(expect, {
    any: (type: unknown) => asymmetric(`Any<${(type as { name?: string }).name ?? '?'}>`, (value) => {
      const name = (type as { name?: string }).name
      if (name === 'Number') return typeof value === 'number' || value instanceof Number
      if (name === 'String') return typeof value === 'string' || value instanceof String
      if (name === 'Boolean') return typeof value === 'boolean'
      if (name === 'Function') return typeof value === 'function'
      if (name === 'Object') return typeof value === 'object' && value !== null
      if (name === 'Array') return Array.isArray(value)
      return typeof type === 'function' && (value instanceof (type as new () => unknown) || Object.getPrototypeOf(value ?? {})?.constructor?.name === name)
    }),
    anything: () => asymmetric('Anything', value => value !== null && value !== undefined),
    stringContaining: (text: string) => asymmetric(`StringContaining ${JSON.stringify(text)}`, value => typeof value === 'string' && value.includes(text)),
    stringMatching: (pattern: string | RegExp) => asymmetric(`StringMatching ${String(pattern)}`, value => typeof value === 'string' && (isRegExp(pattern) ? new RegExp(pattern.source, pattern.flags.replace('g', '')).test(value) : value.includes(pattern))),
    objectContaining: (shape: object) => asymmetric(`ObjectContaining ${describe(shape)}`, value => typeof value === 'object' && value !== null && Object.keys(shape).every(key => key in value && equals((value as Record<string, unknown>)[key], (shape as Record<string, unknown>)[key]))),
    arrayContaining: (items: readonly unknown[]) => asymmetric(`ArrayContaining ${describe(items)}`, value => Array.isArray(value) && items.every(item => value.some(entry => equals(entry, item)))),
  }))
}
