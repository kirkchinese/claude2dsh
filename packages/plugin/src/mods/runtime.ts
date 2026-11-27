/**
 * What a hooks module's environment provides beyond plain JavaScript: the
 * `claude-code` module's run-time helpers (`atom`, `read`, `update`, `derive`,
 * `memberOf` over `$.state`), the JSX factory `h` / `Fragment`, and the
 * element tables `$.ui.resolve(e)` returns, by surface.
 * @module @kirkchinese/harness-forge/mods
 */
import { isRecord } from './values.js'

/** A `$.state` value: its name and default. */
export interface Atom<T = unknown> {
  readonly plugin: string
  readonly key: string
  readonly initial: T
}

interface StateApi {
  readonly state: {
    get(atom: { plugin: string; key: string }): Promise<unknown>
    set(atom: { plugin: string; key: string }, value: unknown): Promise<void>
  }
}

interface Derived {
  readonly derived: true
  readonly from: readonly Readable[]
  readonly compute: (...values: unknown[]) => unknown
}

interface Member {
  readonly member: true
  readonly of: Atom
  readonly key: string
  readonly initial: unknown
}

type Readable = Atom | Derived | Member

function stateOf($: unknown): StateApi['state'] {
  const state = isRecord($) ? $['state'] : undefined
  if (!isRecord(state) || typeof state['get'] !== 'function') throw new Error('read, update and derive take the hook\'s $')
  return state as unknown as StateApi['state']
}

/** Name a `$.state` value and its default. */
export function atom<T>(id: { plugin: string; key: string }, initial: T): Atom<T> {
  if (!isRecord(id) || typeof id.plugin !== 'string' || typeof id.key !== 'string') throw new Error('atom takes { plugin, key } and a default')
  return Object.freeze({ plugin: id.plugin, key: id.key, initial })
}

/** A value computed from others; `read` recomputes it, a render reading it subscribes to its sources. */
export function derive(from: Readable | readonly Readable[], compute: (...values: unknown[]) => unknown): Derived {
  return Object.freeze({ derived: true as const, from: Object.freeze(Array.isArray(from) ? [...from] : [from as Readable]), compute })
}

/** One member of an object-valued atom, read and written on its own. */
export function memberOf(of: Atom, key: string, initial?: unknown): Member {
  return Object.freeze({ member: true as const, of, key, initial })
}

/** Read a value: the stored one, or its default. */
export async function read($: unknown, value: Readable): Promise<unknown> {
  if ('derived' in value) return value.compute(...await Promise.all(value.from.map(source => read($, source))))
  if ('member' in value) {
    const whole = await read($, value.of)
    return isRecord(whole) && value.key in whole ? whole[value.key] : value.initial
  }
  const stored = await stateOf($).get({ plugin: value.plugin, key: value.key })
  return stored === undefined ? value.initial : stored
}

/** Write a value from the current one; resolves to what was written. */
export async function update($: unknown, value: Atom | Member, change: (current: unknown) => unknown): Promise<unknown> {
  if ('member' in value) {
    const whole = await read($, value.of)
    const current = isRecord(whole) && value.key in whole ? whole[value.key] : value.initial
    const next = await change(current)
    await stateOf($).set({ plugin: value.of.plugin, key: value.of.key }, { ...(isRecord(whole) ? whole : {}), [value.key]: next })
    return next
  }
  const next = await change(await read($, value))
  await stateOf($).set({ plugin: value.plugin, key: value.key }, next)
  return next
}

/** The `claude-code` module as a hooks module imports it at run time. */
export const CLAUDE_CODE_MODULE = Object.freeze({ atom, read, update, derive, memberOf })

// -----------------------------------------------------------------------------
// Elements
// -----------------------------------------------------------------------------

/** A plain-data element. */
export interface Element {
  readonly type: string
  readonly props: Readonly<Record<string, unknown>>
  readonly children?: readonly unknown[]
}

/** Flatten JSX children: false, null, undefined and true are dropped; numbers drawn as strings. */
export function normalizeChildren(children: readonly unknown[]): unknown[] {
  const out: unknown[] = []
  const visit = (child: unknown): void => {
    if (child === null || child === undefined || typeof child === 'boolean') return
    if (Array.isArray(child)) { for (const item of child) visit(item); return }
    if (typeof child === 'number') { out.push(String(child)); return }
    out.push(child)
  }
  for (const child of children) visit(child)
  return out
}

/** The JSX factory: a plain-data element from a constructor or a tag name. */
export function h(tag: unknown, props: Record<string, unknown> | null | undefined, ...children: unknown[]): unknown {
  const given = { ...(props ?? {}) }
  if (children.length > 0) given['children'] = children.length === 1 ? children[0] : children
  if (typeof tag === 'function') return (tag as (props: Record<string, unknown>) => unknown)(given)
  if (typeof tag === 'string') return element(tag, given)
  throw new Error(`h: ${String(tag)} is no element constructor`)
}

/** `<>...</>`: a column Box around the children. */
export function Fragment(props: { children?: unknown }): Element {
  return element('Box', { flexDirection: 'column', children: props.children })
}

function element(type: string, props: Record<string, unknown>): Element {
  const { children, ...rest } = props
  const list = normalizeChildren(children === undefined ? [] : [children])
  if (type === 'Button') {
    // The label may be the one string child; the key defaults to the label.
    const label = typeof rest['label'] === 'string' ? rest['label'] : list.every(child => typeof child === 'string') ? list.join('') : undefined
    const key = typeof rest['key'] === 'string' ? rest['key'] : label
    return Object.freeze({
      type,
      props: Object.freeze({ ...rest, ...(label !== undefined ? { label } : {}), ...(key !== undefined ? { key } : {}) }),
      ...(list.length > 0 && !list.every(child => typeof child === 'string') ? { children: Object.freeze(list) } : {}),
    })
  }
  return Object.freeze({ type, props: Object.freeze(rest), ...(list.length > 0 ? { children: Object.freeze(list) } : {}) })
}

/** Elements each surface draws (mods reference, "Elements"). */
const SURFACE_ELEMENTS: Readonly<Record<string, readonly string[]>> = {
  terminal: ['Box', 'Text', 'Button', 'Link', 'Code', 'Markdown', 'Input', 'Select', 'Client', 'Raster', 'Image'],
  desktop: ['Box', 'Text', 'Button', 'Link', 'Code', 'Markdown', 'Input', 'Select', 'Svg', 'Client'],
  vscode: ['Box', 'Text', 'Button', 'Link', 'Code', 'Markdown', 'Input', 'Select', 'Svg'],
  mobile: ['Box', 'Text', 'Button', 'Link', 'Code', 'Markdown', 'Input', 'Select'],
}

const tables = new Map<string, Readonly<Record<string, unknown>>>()

/** Elements whose callbacks a press reaches: the runtime stamps whose they are. */
const CONTROLS = new Set(['Button', 'Input', 'Select', 'Markdown'])

/**
 * The element table of a surface: a frozen constructor per element it draws.
 * Given a plugin, its controls carry `press: { plugin }`, as the runtime
 * stamps the elements a plugin's hook draws.
 */
export function elementTable(surface: string, plugin?: string): Readonly<Record<string, unknown>> {
  const cacheKey = `${surface}\u0000${plugin ?? ''}`
  const cached = tables.get(cacheKey)
  if (cached !== undefined) return cached
  const names = SURFACE_ELEMENTS[surface] ?? SURFACE_ELEMENTS['terminal']!
  const table = Object.freeze(Object.fromEntries(names.map(name => [name, (props: Record<string, unknown>) => {
    const made = element(name, props ?? {})
    return plugin === undefined || !CONTROLS.has(name) ? made : Object.freeze({ ...made, press: Object.freeze({ plugin }) })
  }])))
  tables.set(cacheKey, table)
  return table
}
