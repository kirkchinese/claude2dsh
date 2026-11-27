/**
 * The mods' drawings in a DSH session, on the desktop surface: the band above
 * the prompt (`AbovePrompt`) and the panes mods open (`$.ui.open`). Each is a
 * `ui.render` dispatch; the tree it settles on is checked against the desktop
 * element table and sent to the browser as plain data, every control's
 * callback kept here under an action id. A press, a submitted input or a
 * picked option raises `ui.press` / `ui.input` / `ui.select`, whose core runs
 * the callback in its mod's environment.
 * @module @kirkchinese/harness-forge/mods
 */
import { elementTable } from './runtime.js'
import { isRecord, messageOf } from './values.js'

/** A node as the browser draws it. */
export type SerializedNode = string | SerializedElement

/** An element as the browser draws it: plain props, its controls' action ids. */
export interface SerializedElement {
  readonly type: string
  readonly props: Readonly<Record<string, unknown>>
  readonly children: readonly SerializedNode[]
  /** `press`, `submit`, `input`, `select`, `link` → action id. */
  readonly actions?: Readonly<Record<string, string>>
}

/** One open pane. */
export interface PaneSnapshot {
  readonly plugin: string
  readonly id: string
  readonly title: string
  readonly tree: SerializedNode | null
  /** Why the pane could not be drawn. */
  readonly error?: string
}

/** What a session's browser draws, at one generation. */
export interface SurfaceSnapshot {
  readonly generation: number
  readonly band: SerializedNode | null
  readonly bandError?: string
  readonly panes: readonly PaneSnapshot[]
}

/** What an action runs. */
interface Action {
  readonly kind: 'press' | 'submit' | 'input' | 'select' | 'link'
  readonly fn: (...args: unknown[]) => unknown
  readonly plugin: string
  readonly element: string
  readonly component: 'AbovePrompt' | 'Pane'
  readonly requestId: string
}

const BAND_ID = 'band'
const SURFACE = 'desktop'
const COLUMNS = 120
const ROWS = 12
const PANE_COLUMNS = 100
const PANE_ROWS = 40
const HANDLER_PROPS: Readonly<Record<string, Action['kind']>> = { onPress: 'press', onSubmit: 'submit', onInput: 'input', onSelect: 'select', onLinkPress: 'link' }

/** How a session raises its events. */
export interface SurfaceHost {
  raise(event: string, input: unknown): Promise<unknown>
  report(line: string): void
  isWorking(): boolean
  /** Run outside any mod hook's context (see `invalidate`). */
  detached?(fn: () => void): void
}

/** The drawings of one session. */
export class SessionSurfaces {
  private generation = 0
  private snapshot: SurfaceSnapshot = { generation: 0, band: null, panes: [] }
  private readonly panes = new Map<string, { plugin: string; title: string; isFocused: boolean }>()
  private actions = new Map<string, Action>()
  private readonly watchers = new Set<(snapshot: SurfaceSnapshot) => void>()
  private pending: ReturnType<typeof setTimeout> | undefined
  private drawing: Promise<void> | undefined
  private isDirty = false
  private isClosed = false

  /** `generation`: where numbering continues when a session's agent is replaced, so later drawings stay newer. */
  constructor(private readonly host: SurfaceHost, generation = 0) {
    this.generation = generation
    this.snapshot = { generation, band: null, panes: [] }
  }

  /** The latest drawing. */
  current(): SurfaceSnapshot {
    return this.snapshot
  }

  /** Watch every drawing from now on; returns the unsubscribe. */
  watch(listener: (snapshot: SurfaceSnapshot) => void): () => void {
    this.watchers.add(listener)
    listener(this.snapshot)
    return () => { this.watchers.delete(listener) }
  }

  /** Something a drawing may depend on changed: draw again soon (folds bursts). */
  invalidate(): void {
    if (this.isClosed) return
    if (this.pending !== undefined) return
    // A mod's own `$.ui.open` or `$.ui.invalidate` asks for this redraw; a timer created in its hook would carry
    // that hook's context into the redraw, and the engine would then skip the mod's hooks as a re-entry, drawing
    // nothing. The redraw is the engine's, not the mod's call, so it is scheduled outside any hook's context.
    const schedule = (): void => {
      this.pending = setTimeout(() => {
        this.pending = undefined
        void this.refresh()
      }, 40)
      this.pending.unref?.()
    }
    if (this.host.detached !== undefined) this.host.detached(schedule)
    else schedule()
  }

  /** A mod opened a pane (`$.ui.open`). */
  open(plugin: string, args: Readonly<Record<string, unknown>>): { isPlaced: boolean; reason?: string } {
    const id = String(args['id'] ?? '')
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(id)) throw new Error('a pane id is 1-64 letters, digits, "_" or "-"')
    const prior = this.panes.get(id)
    if (prior !== undefined && prior.plugin !== plugin) throw new Error(`pane ${id} is ${prior.plugin}'s`)
    this.panes.set(id, { plugin, title: typeof args['title'] === 'string' ? args['title'] : prior?.title ?? id, isFocused: args['focus'] === true })
    this.invalidate()
    return { isPlaced: true }
  }

  /** A pane closes, by its mod or the person; the hooks of `ui.close` have let it. */
  close(id: string): void {
    if (this.panes.delete(id)) this.invalidate()
  }

  /** The open panes, as `$.ui.panes()` lists them. */
  list(): Array<{ id: string; plugin: string; title: string; placement: 'dock'; isFocused: boolean }> {
    return [...this.panes].map(([id, pane]) => ({ id, plugin: pane.plugin, title: pane.title, placement: 'dock' as const, isFocused: pane.isFocused }))
  }

  /** Whose pane an id is. */
  owner(id: string): string | undefined {
    return this.panes.get(id)?.plugin
  }

  dispose(): void {
    this.isClosed = true
    if (this.pending !== undefined) clearTimeout(this.pending)
    this.watchers.clear()
  }

  /** Draw the band and every pane. */
  async refresh(): Promise<SurfaceSnapshot> {
    if (this.drawing !== undefined) {
      this.isDirty = true
      await this.drawing
      return this.snapshot
    }
    this.drawing = this.draw()
    try {
      await this.drawing
    } finally {
      this.drawing = undefined
    }
    if (this.isDirty) {
      this.isDirty = false
      return this.refresh()
    }
    return this.snapshot
  }

  private async draw(): Promise<void> {
    const actions = new Map<string, Action>()
    const band = await this.render('AbovePrompt', BAND_ID, undefined, {
      hasSurvey: false,
      isWorking: this.host.isWorking(),
      maxRows: ROWS,
      bodyColumns: COLUMNS,
      scroll: { offset: 0, bodyRows: ROWS },
      view: {},
    }, { columns: COLUMNS, rows: ROWS }, actions)
    const panes: PaneSnapshot[] = []
    for (const [id, pane] of this.panes) {
      const drawn = await this.render('Pane', id, pane.plugin, {
        title: pane.title,
        isFocused: pane.isFocused,
        bodyColumns: PANE_COLUMNS,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: PANE_ROWS },
        view: {},
      }, { columns: PANE_COLUMNS, rows: PANE_ROWS, isFullscreen: false }, actions)
      panes.push({ plugin: pane.plugin, id, title: pane.title, tree: drawn.tree, ...(drawn.error !== undefined ? { error: drawn.error } : {}) })
    }
    this.actions = actions
    this.snapshot = { generation: ++this.generation, band: band.tree, ...(band.error !== undefined ? { bandError: band.error } : {}), panes }
    for (const watcher of [...this.watchers]) {
      try {
        watcher(this.snapshot)
      } catch (error: unknown) {
        this.host.report(`a surface watcher failed: ${messageOf(error)}`)
      }
    }
  }

  private async render(
    component: 'AbovePrompt' | 'Pane',
    requestId: string,
    plugin: string | undefined,
    props: Record<string, unknown>,
    viewport: Record<string, unknown>,
    actions: Map<string, Action>,
  ): Promise<{ tree: SerializedNode | null; error?: string }> {
    let tree: unknown
    try {
      tree = await this.host.raise('ui.render', { surface: SURFACE, component, requestId, viewport, props, ...(plugin !== undefined ? { plugin } : {}) })
    } catch (error: unknown) {
      return { tree: null, error: messageOf(error) }
    }
    const problem = validate(tree)
    if (problem !== undefined) return { tree: null, error: `the desktop surface cannot draw it: ${problem}` }
    const owner = plugin ?? ''
    return { tree: serialize(tree, component, requestId, owner, actions) }
  }

  /**
   * The person acted on a control of the drawing at `generation`: its event
   * (`ui.press`, `ui.input`, `ui.select`) runs, the callback last.
   */
  async act(generation: number, actionId: string, value?: unknown): Promise<SurfaceSnapshot> {
    const action = this.actions.get(actionId)
    if (action === undefined || generation !== this.snapshot.generation) {
      throw new Error('that control is no longer drawn; the band or pane has been drawn again')
    }
    const base = { plugin: action.plugin, element: action.element, component: action.component, requestId: action.requestId, surface: SURFACE }
    if (action.kind === 'press' || action.kind === 'link') {
      await this.host.raise('ui.press', { ...base, ...(action.kind === 'link' ? { link: value } : {}) })
    } else if (action.kind === 'select') {
      await this.host.raise('ui.select', { ...base, value: String(value ?? '') })
    } else {
      await this.host.raise('ui.input', { ...base, value: String(value ?? ''), kind: action.kind === 'submit' ? 'submit' : 'change' })
    }
    return this.refresh()
  }

  /**
   * The person moved the keyboard focus to a control, or scrolled a pane or
   * the band: `ui.focus` / `ui.scroll`, origin `person`. A hook may
   * refuse it or handle it; the drawing follows either way.
   */
  async move(kind: 'focus' | 'scroll', target: Readonly<Record<string, unknown>>): Promise<{ snapshot: SurfaceSnapshot; refused?: string }> {
    const pane = typeof target['pane'] === 'string' ? target['pane'] : undefined
    const component = pane === undefined ? 'AbovePrompt' : 'Pane'
    const requestId = pane ?? BAND_ID
    const owner = pane === undefined ? undefined : this.panes.get(pane)?.plugin
    const input = kind === 'focus'
      ? {
          component,
          requestId,
          ...(typeof target['element'] === 'string' ? { element: target['element'] } : {}),
          ...(owner !== undefined ? { plugin: owner } : {}),
          origin: { kind: 'person' },
        }
      : {
          component,
          requestId,
          offset: Number(target['offset']) || 0,
          by: Number(target['by']) || 0,
          bodyRows: Number(target['bodyRows']) || PANE_ROWS,
          contentRows: Number(target['contentRows']) || PANE_ROWS,
          origin: { kind: 'person' },
          ...(owner !== undefined ? { plugin: owner } : {}),
        }
    const result = await this.host.raise(kind === 'focus' ? 'ui.focus' : 'ui.scroll', input).catch((error: unknown) => ({ deny: messageOf(error) })) as Record<string, unknown>
    const snapshot = await this.refresh()
    return { snapshot, ...(typeof result['deny'] === 'string' ? { refused: result['deny'] } : {}) }
  }

  /** Core of a control's event: its callback, in its mod's environment. */
  async runCallback(event: string, e: Readonly<Record<string, unknown>>): Promise<unknown> {
    const kind = event === 'ui.select' ? ['select'] : event === 'ui.input' ? [e['kind'] === 'change' ? 'input' : 'submit', 'input'] : e['link'] !== undefined ? ['link', 'press'] : ['press']
    const action = [...this.actions.values()].find(item => item.element === e['element'] && item.requestId === e['requestId'] && kind.includes(item.kind))
    if (action === undefined) throw new Error(`no control keyed ${String(e['element'])} is drawn`)
    const argument = event === 'ui.press' ? (e['link'] !== undefined ? [e['link'], e] : []) : [e['value'], e]
    await action.fn(...argument)
    return { element: action.element }
  }
}

/** Why the desktop surface cannot draw a tree, or undefined. */
function validate(tree: unknown): string | undefined {
  const table = elementTable(SURFACE)
  let count = 0
  const visit = (node: unknown, depth: number): string | undefined => {
    if (node === null || node === undefined || typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return undefined
    if (Array.isArray(node)) {
      for (const child of node) {
        const problem = visit(child, depth)
        if (problem !== undefined) return problem
      }
      return undefined
    }
    if (!isRecord(node) || typeof node['type'] !== 'string') return 'a node is neither text nor an element'
    if (++count > 20_000) return 'more than 20000 elements'
    if (depth > 32) return 'nested deeper than 32 levels'
    if (node['type'] !== 'engine' && !(node['type'] in table)) return `${node['type']} is not a desktop element`
    const children = Array.isArray(node['children']) ? node['children'] : []
    return visit(children, depth + 1)
  }
  return visit(tree, 0)
}

let actionIds = 0

function serialize(node: unknown, component: Action['component'], requestId: string, plugin: string, actions: Map<string, Action>): SerializedNode | null {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) {
    const children = node.map(child => serialize(child, component, requestId, plugin, actions)).filter((child): child is SerializedNode => child !== null)
    return { type: 'Box', props: { flexDirection: 'column' }, children }
  }
  if (!isRecord(node) || typeof node['type'] !== 'string' || node['type'] === 'engine') return null
  const props: Record<string, unknown> = {}
  const own: Record<string, string> = {}
  // Whose control: the runtime's stamp, else the pane's owner.
  const stamp = isRecord(node['press']) && typeof node['press']['plugin'] === 'string' ? node['press']['plugin'] : undefined
  const owner = stamp ?? plugin
  const source = isRecord(node['props']) ? node['props'] : {}
  const key = typeof source['key'] === 'string' ? source['key'] : undefined
  for (const [name, value] of Object.entries(source)) {
    const kind = HANDLER_PROPS[name]
    if (kind !== undefined && typeof value === 'function') {
      const id = `a${String(++actionIds)}`
      actions.set(id, { kind, fn: value as Action['fn'], plugin: owner, element: key ?? String(source['label'] ?? node['type']), component, requestId })
      own[kind] = id
      continue
    }
    if (typeof value === 'function') continue
    const kept = plain(value)
    if (kept !== undefined) props[name] = kept
  }
  const children = (Array.isArray(node['children']) ? node['children'] : [])
    .map(child => serialize(child, component, requestId, owner, actions))
    .filter((child): child is SerializedNode => child !== null)
  return { type: node['type'], props, children, ...(Object.keys(own).length > 0 ? { actions: own } : {}) }
}

/** JSON data only: what is not (a function, undefined, a non-finite number) is left out. */
function plain(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : undefined
  if (Array.isArray(value)) return value.map(plain).filter(item => item !== undefined)
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, plain(item)] as const).filter(([, item]) => item !== undefined))
  }
  return undefined
}
