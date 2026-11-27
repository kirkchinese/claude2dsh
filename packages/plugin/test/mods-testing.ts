/**
 * `claude-code/testing`, the kit a mod's `*.test.ts` files import, run over
 * this engine as `claude plugin test` runs them over Claude Code's: each test
 * gets the engine's own `$` and an `on` whose hooks (stubs) sit beneath every
 * plugin, the plugin under test loaded fresh at the test's first call on `$`,
 * with `describe`, `expect`, `tier`, and `mock` (clock, store, env).
 * A test helper, not shipped.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { dispatch, matches, selects, type HookEntry, type HookFn, type PluginTier } from '../src/mods/chain.js'
import { ModsEngine, type EngineHost, type ModDefinition, type RenderFrame } from '../src/mods/engine.js'
import { createExpect, ExpectationError } from '../src/mods/expect.js'
import { bundleModule, createEnvironment, evaluateBundle, realmOf, scanBundleRefusal, scanBundleUses, scanRefusal, scanUses, type Bundle } from '../src/mods/loader.js'
import { CLASSIC_EVENTS, ENGINE_EVENTS, OPS } from '../src/mods/ops.js'
import { elementTable } from '../src/mods/runtime.js'
import { errorLine, isRecord, messageOf } from '../src/mods/values.js'
import { workspaceBundler } from './workspace-bundler.js'

/** One test's outcome. */
export interface TestOutcome {
  readonly name: string
  readonly ok: boolean
  readonly ms: number
  readonly error?: string
  /** What the engine reported while it ran: each hook skipped, and why. */
  readonly reported: readonly string[]
}

/** One test file's outcomes. */
export interface TestFileOutcome {
  readonly file: string
  readonly tests: readonly TestOutcome[]
  /** Why the file did not run (bundling, loading, no test). */
  readonly error?: string
}

/** A plugin folder's hooks module, name and options. */
export interface PluginUnderTest {
  readonly name: string
  readonly root: string
  readonly entry: string
  readonly options: Readonly<Record<string, unknown>>
  /** What the scan read off the module's source. */
  readonly uses?: Readonly<Record<string, unknown>>
  readonly refusal?: string
}

/** Read a plugin folder the way the engine loads it. */
export function readPlugin(root: string): PluginUnderTest {
  const manifestPath = join(root, '.claude-plugin', 'plugin.json')
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown> : {}
  const name = typeof manifest['name'] === 'string' ? manifest['name'] : root.split(/[\\/]/u).pop() ?? 'plugin'
  const declared = manifest['hooks']
  const hookFiles = (Array.isArray(declared) ? declared : typeof declared === 'string' ? [declared] : ['./hooks/hooks.json'])
    .filter((item): item is string => typeof item === 'string')
    .map(item => resolve(root, item))
  let entry: string | undefined
  for (const file of hookFiles) {
    if (!existsSync(file)) continue
    const config = JSON.parse(readFileSync(file, 'utf8')) as { modules?: unknown }
    const modules = Array.isArray(config.modules) ? config.modules.filter((item): item is string => typeof item === 'string') : []
    if (modules[0] !== undefined) {
      entry = resolve(dirname(file), modules[0])
      break
    }
  }
  if (entry === undefined) throw new Error(`${root} declares no hooks module (hooks.json "modules")`)
  const options: Record<string, unknown> = {}
  const userConfig = isRecord(manifest['userConfig']) ? manifest['userConfig'] : {}
  for (const [key, field] of Object.entries(userConfig)) {
    if (isRecord(field) && field['default'] !== undefined) options[key] = field['default']
  }
  return { name, root, entry, options }
}

/** Every `*.test.ts` / `*.test.tsx` file under a folder. */
export function findTestFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.test\.tsx?$/u.test(entry.name)) out.push(path)
    }
  }
  walk(root)
  return out.sort()
}

/** Run every test file of a plugin folder. */
export async function runPluginTests(root: string, options: { files?: readonly string[]; filter?: RegExp } = {}): Promise<TestFileOutcome[]> {
  const pluginBundle = await bundleModule(readPlugin(root).entry, workspaceBundler)
  const refusal = scanBundleRefusal(pluginBundle, workspaceBundler.parseAst)
  const plugin: PluginUnderTest = { ...readPlugin(root), uses: scanBundleUses(pluginBundle), ...(refusal !== undefined ? { refusal } : {}) }
  const files = options.files ?? findTestFiles(root)
  const outcomes: TestFileOutcome[] = []
  for (const file of files) outcomes.push(await runTestFile(plugin, pluginBundle, file, options.filter))
  return outcomes
}

interface Declared {
  readonly name: string
  readonly options: { readonly plugins?: readonly unknown[]; readonly timeoutMs?: number }
  readonly body: ($: unknown, on: unknown) => unknown
}

/** The kit module one test file imports. */
interface Kit {
  readonly declared: Declared[]
  tier: PluginTier
  /** The test file's environment, where inline plugins run. */
  realm?: { readonly Error: ErrorConstructor }
  current: TestRun | undefined
  readonly module: Readonly<Record<string, unknown>>
}

function createKit(): Kit {
  const kit: Kit = { declared: [], tier: 'user', current: undefined, module: {} }
  const groups: string[] = []
  const expect = createExpect((error) => { kit.current?.failures.push(error) })
  const module = Object.freeze({
    describe: (name: string, body: () => void) => {
      groups.push(name)
      try { body() } finally { groups.pop() }
    },
    test: (name: string, ...rest: unknown[]) => {
      const body = rest.length > 1 ? rest[1] : rest[0]
      const options = rest.length > 1 && isRecord(rest[0]) ? rest[0] : {}
      if (typeof body !== 'function') throw new Error(`test("${name}") takes a body`)
      kit.declared.push({ name: [...groups, name].join(' > '), options: options as Declared['options'], body: body as Declared['body'] })
    },
    tier: (tier: PluginTier) => { kit.tier = tier },
    expect,
    mock: Object.freeze({
      clock: (on: unknown, options?: { now?: number }) => mockClock(on as StubOn, options?.now ?? 0),
      store: (on: unknown, entries?: Readonly<Record<string, unknown>>) => { mockStore(on as StubOn, entries ?? {}) },
      env: (on: unknown, variables: Readonly<Record<string, string>>) => { mockEnv(on as StubOn, variables) },
      session: (on: unknown) => mockSession(on as StubOn),
    }),
  })
  Object.assign(kit, { module })
  return kit
}

async function runTestFile(plugin: PluginUnderTest, pluginBundle: Bundle, file: string, filter: RegExp | undefined): Promise<TestFileOutcome> {
  const name = relative(plugin.root, file).replace(/\\/gu, '/')
  let bundle: Bundle
  try {
    bundle = await bundleModule(file, workspaceBundler)
  } catch (error: unknown) {
    return { file: name, tests: [], error: `did not bundle: ${messageOf(error)}` }
  }
  const kit = createKit()
  try {
    const environment = createEnvironment({ console })
    kit.realm = realmOf(environment)
    evaluateBundle(bundle, environment, { 'claude-code/testing': kit.module })
  } catch (error: unknown) {
    return { file: name, tests: [], error: `did not load: ${errorLine(error)}` }
  }
  if (kit.declared.length === 0) return { file: name, tests: [], error: 'declares no test(): nothing ran' }
  const tests: TestOutcome[] = []
  for (const declared of kit.declared) {
    if (filter !== undefined && !filter.test(declared.name)) continue
    tests.push(await runOne(plugin, pluginBundle, kit, declared))
  }
  return { file: name, tests }
}

/** One test's run: its engine, its stubs, its mounts. */
interface TestRun {
  readonly failures: ExpectationError[]
  readonly reported: string[]
}

type StubOn = (pattern: string, second: unknown, third?: unknown) => { catch(handler: unknown): void }

async function runOne(plugin: PluginUnderTest, pluginBundle: Bundle, kit: Kit, declared: Declared): Promise<TestOutcome> {
  const run: TestRun = { failures: [], reported: [] }
  kit.current = run
  const started = performance.now()
  const stubs: HookEntry[] = []
  let loaded: Promise<void> | undefined
  let stubSeq = 0
  const mounts = new Set<Mount>()
  const drawings: Drawing[] = []
  const stubRef = Object.freeze({ name: 'test', tier: 'builtin' as const, rank: Number.MAX_SAFE_INTEGER })
  let engine!: ModsEngine
  // A stub's $: the engine's own, with the element tables a render stub draws with.
  let stubApi: unknown
  const testApi = (): unknown => {
    stubApi ??= Object.freeze({ ...(engineApi as Record<string, unknown>), ui: Object.freeze({ ...((engineApi as Record<string, Record<string, unknown>>)['ui'] ?? {}), resolve: (e: unknown) => elementTable(isRecord(e) && typeof e['surface'] === 'string' ? e['surface'] : 'terminal') }) })
    return stubApi
  }
  const host: EngineHost = {
    core: (event, e, context) => {
      activity.count++
      const selected = stubs.filter(hook => selects(hook.pattern, event))
      if (process.env['HF_MODS_DEBUG'] !== undefined) console.error(`core ${event} from ${context.origin.plugin}: ${JSON.stringify(e)?.slice(0, 200)}`)
      return dispatch({
        event,
        input: e,
        origin: context.origin,
        hooks: selected,
        bottom: async (bottomE) => kitCore(event, bottomE),
        api: () => testApi(),
        applies: (hook, value) => hook.matcher === undefined || matches(hook.matcher, value),
        validate: result => (isOpEvent(event) ? valueOrDeny(result) : undefined),
        report: (line) => { run.reported.push(line.replace(/^test: /u, `the test's `)) },
      })
    },
    report: (line) => { run.reported.push(line); if (process.env['HF_MODS_DEBUG'] !== undefined) console.error(`report ${line}`) },
    elements: (surface, _component, plugin) => elementTable(surface, plugin),
    stateRead: (key, render) => { for (const mount of mounts) mount.read(key, render) },
    stateWritten: (key) => { for (const mount of mounts) mount.written(key) },
  }
  /** What answers beneath the stubs: the kit's own answers, else nothing. */
  const kitCore = async (event: string, e: unknown): Promise<unknown> => {
    if (event === 'ui.invalidate') {
      for (const mount of mounts) mount.invalidate()
      return { value: undefined }
    }
    if (event === 'session.append') return isRecord(e) ? { message: e['message'], uuid: e['uuid'] ?? crypto.randomUUID() } : {}
    if (event === 'ui.press') return pressCore(e, mounts, drawings)
    if (event === 'ui.input' || event === 'ui.select') return controlCore(event, e, mounts, drawings)
    if (event === 'plugin.register') return { allow: true }
    throw new Error(`no implementation for ${event}`)
  }
  engine = new ModsEngine(host)
  const ensureLoaded = (): Promise<void> => {
    loaded ??= (async () => {
      const definitions: ModDefinition[] = []
      const environment = createEnvironment()
      const exports = evaluateBundle(pluginBundle, environment)
      const register = exports['register'] ?? exports['default']
      if (typeof register !== 'function') throw new Error(`${plugin.entry} exports no register(on, options)`)
      // The inline plugins load first, then the plugin under test.
      for (const inline of declared.options.plugins ?? []) {
        if (!isRecord(inline) || typeof inline['name'] !== 'string' || typeof inline['register'] !== 'function') continue
        const refusal = scanRefusal(String(inline['register']), workspaceBundler.parseAst)
        definitions.push({
          ...(refusal !== undefined ? { refusal } : {}),
          name: inline['name'],
          tier: (typeof inline['tier'] === 'string' ? inline['tier'] : 'user') as PluginTier,
          root: plugin.root,
          register: inline['register'] as ModDefinition['register'],
          provenance: `${inline['name']}@claude-plugin-test`,
          uses: scanUses(String(inline['register'])),
          realm: kit.realm,
        })
      }
      definitions.push({
        name: plugin.name,
        tier: kit.tier,
        root: plugin.root,
        options: plugin.options,
        register: register as ModDefinition['register'],
        provenance: `${plugin.name}@claude-plugin-test`,
        uses: plugin.uses ?? {},
        ...(plugin.refusal !== undefined ? { refusal: plugin.refusal } : {}),
        realm: realmOf(environment),
      })
      const result = await engine.load(definitions)
      const refusal = result.refused[0]
      if (refusal !== undefined) throw new Error(`${refusal.name}: refused by ${refusal.by}: ${refusal.reason}`)
      const failure = result.failed[0]
      if (failure !== undefined) throw new Error(`${failure.name}: hooks module did not load: ${failure.error}`)
    })()
    return loaded
  }
  const on: StubOn = (pattern, second, third) => {
    if (loaded !== undefined) throw new Error(`on("${pattern}") after the test first called $`)
    const fn = (third ?? second) as HookFn
    const hook: HookEntry = { id: -(++stubSeq), mod: stubRef, pattern, matcher: third === undefined ? undefined : second, fn, seq: stubSeq }
    stubs.push(hook)
    return Object.freeze({ catch: (handler: unknown) => { hook.catchFn = handler as HookFn } })
  }
  const raise = async (event: string, input: unknown): Promise<unknown> => {
    await ensureLoaded()
    return engine.raise(event, input)
  }
  const engineApi = buildEngineApi(raise, mounts, drawings, () => engine, ensureLoaded)
  let error: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeoutMs = declared.options.timeoutMs ?? 5000
    await Promise.race([
      Promise.resolve().then(() => declared.body(engineApi, on)),
      new Promise((_resolve, reject) => { timer = setTimeout(() => { reject(new Error(`timed out after ${String(timeoutMs)} ms`)) }, timeoutMs) }),
    ])
  } catch (caught: unknown) {
    error = errorLine(caught)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    engine.dispose()
    for (const mount of mounts) mount.close()
    kit.current = undefined
  }
  if (error === undefined && run.failures.length > 0) error = errorLine(run.failures[0])
  const ms = performance.now() - started
  return error === undefined
    ? { name: declared.name, ok: true, ms, reported: run.reported }
    : { name: declared.name, ok: false, ms, error, reported: run.reported }
}

/** Events whose stubs answer `{ value }` or `{ deny }`. */
function isOpEvent(event: string): boolean {
  const op = OPS[event]
  if (op !== undefined) return op.kind !== 'event'
  if (event === 'clock.after' || event === 'clock.every') return true
  if (ENGINE_EVENTS.includes(event) || event.startsWith('classic.')) return false
  return event.includes('.')
}

function valueOrDeny(result: unknown): string | undefined {
  if (isRecord(result) && (typeof result['deny'] === 'string' || 'value' in result)) return undefined
  return 'returned neither { value } nor { deny }'
}

const OWNED = new Set(['ui.press', 'ui.input', 'ui.select', 'ui.focus', 'ui.render', 'ui.message', 'ui.fault', 'ui.scroll'])

function ownedApplies(event: string, hook: HookEntry, e: unknown): boolean {
  if (!OWNED.has(event) || !isRecord(e) || typeof e['plugin'] !== 'string') return true
  const named = isRecord(hook.matcher) && 'plugin' in hook.matcher
  if (named) return true
  return hook.matcher === undefined && (hook.pattern === '*' || hook.pattern.endsWith('.*'))
}

// -----------------------------------------------------------------------------
// The test's `$`: every engine event as the engine raises it, and ui.mount/press
// -----------------------------------------------------------------------------

let toolUseIds = 0

function buildEngineApi(raise: (event: string, input: unknown) => Promise<unknown>, mounts: Set<Mount>, drawings: Drawing[], engine: () => ModsEngine, ensureLoaded: () => Promise<void>): unknown {
  const nouns: Record<string, Record<string, unknown>> = {}
  for (const event of ENGINE_EVENTS) {
    if (event === 'ui.resolve' || event === 'engine.create' || event === 'plugin.register') continue
    const [noun, method] = event.split('.') as [string, string]
    nouns[noun] ??= {}
    nouns[noun]![method] = (input: unknown) => {
      let e = input ?? {}
      if (event === 'tool.call' && isRecord(e) && e['tool_use_id'] === undefined) e = { ...e, tool_use_id: `toolu_test_${String(++toolUseIds)}` }
      if (event === 'turn.step') return streamOf(raise(event, e))
      if (event === 'ui.render') {
        return raise(event, e).then((tree) => {
          const target = isRecord(e) ? e : {}
          const at = drawings.findIndex(drawing => drawing.requestId === target['requestId'] && drawing.surface === target['surface'])
          const drawing: Drawing = { ...(typeof target['plugin'] === 'string' ? { plugin: target['plugin'] } : {}), requestId: target['requestId'], surface: target['surface'], component: target['component'], tree }
          if (at >= 0) drawings.splice(at, 1)
          drawings.unshift(drawing)
          return tree
        })
      }
      return raise(event, e)
    }
  }
  nouns['classic'] = Object.fromEntries(CLASSIC_EVENTS.map(name => [name, (input: unknown) => raise(`classic.${name}`, input ?? {})]))
  nouns['ui']!['mount'] = async (target: unknown) => {
    await ensureLoaded()
    const mount = new Mount(engine(), target, mounts)
    mounts.add(mount)
    await mount.draw()
    return mount.handle()
  }
  nouns['ui']!['press'] = async (target: unknown) => {
    await ensureLoaded()
    if (!isRecord(target)) throw new Error('$.ui.press takes { plugin, key }')
    const holder = [...mounts].find(mount => mount.holds(String(target['plugin']), String(target['key']), target['requestId'], target['surface']))
    if (holder !== undefined) return holder.press({ key: target['key'], plugin: target['plugin'], ...(target['link'] !== undefined ? { link: target['link'] } : {}) })
    const key = String(target['key'])
    const drawing = drawings.find(item => (target['requestId'] === undefined || item.requestId === target['requestId'])
      && (target['surface'] === undefined || item.surface === target['surface'])
      && (item.plugin === undefined || item.plugin === target['plugin'])
      && findAll(item.tree, { key }).length > 0)
    if (drawing === undefined) throw new Error(`no drawing holds ${String(target['plugin'])}'s ${key}`)
    return raise('ui.press', {
      plugin: target['plugin'],
      element: key,
      component: drawing.component,
      requestId: drawing.requestId,
      surface: drawing.surface,
      ...(target['link'] !== undefined ? { link: target['link'] } : {}),
    })
  }
  return Object.freeze(Object.fromEntries(Object.entries(nouns).map(([noun, table]) => [noun, Object.freeze(table)])))
}

/** A streaming event's result as the test reads it: an async generator whose return is the result. */
function streamOf(result: Promise<unknown>): AsyncGenerator<unknown, unknown> & { result: Promise<unknown> } {
  const generator = (async function* () {
    const value = await result
    if (isRecord(value) && Array.isArray(value['__chunks'])) for (const chunk of value['__chunks']) yield chunk
    return value
  })()
  return Object.assign(generator, { result })
}

// -----------------------------------------------------------------------------
// Mounted drawings
// -----------------------------------------------------------------------------

/** A tree a test's `$.ui.render` drew, which `$.ui.press` may press into. */
interface Drawing {
  readonly plugin?: string
  readonly requestId?: unknown
  readonly surface?: unknown
  readonly component?: unknown
  readonly tree: unknown
}

interface FoundElement {
  type: string
  key: string | undefined
  props: Record<string, unknown>
  text: string
  children: unknown[]
}

let requestIds = 0

class Mount {
  private tree: unknown
  private refusal: string | undefined
  private dirty = false
  private closed = false
  private readonly reads = new Set<string>()
  private readonly target: Record<string, unknown>

  constructor(private readonly engine: ModsEngine, target: unknown, private readonly all: Set<Mount>) {
    if (!isRecord(target) || typeof target['surface'] !== 'string') throw new Error('$.ui.mount takes a surface: terminal, desktop, vscode or mobile')
    if (!['terminal', 'desktop', 'vscode', 'mobile'].includes(target['surface'])) throw new Error(`$.ui.mount: ${target['surface']} is no surface`)
    this.target = { ...target, requestId: typeof target['requestId'] === 'string' ? target['requestId'] : `mount-${String(++requestIds)}` }
  }

  get surface(): string {
    return String(this.target['surface'])
  }

  async draw(): Promise<void> {
    this.reads.clear()
    const e = {
      surface: this.target['surface'],
      component: this.target['component'],
      requestId: this.target['requestId'],
      props: this.target['props'] ?? {},
      ...(this.target['viewport'] !== undefined ? { viewport: this.target['viewport'] } : {}),
      ...(typeof this.target['plugin'] === 'string' ? { plugin: this.target['plugin'] } : {}),
    }
    const tree = await this.engine.raise('ui.render', e)
    this.refusal = validateTree(tree, this.surface)
    this.tree = tree
    this.dirty = false
    if (this.refusal !== undefined) throw new Error(`the ${this.surface} surface cannot draw the tree: ${this.refusal}`)
  }

  read(key: string, render: RenderFrame): void {
    void render
    this.reads.add(key)
  }

  written(key: string): void {
    if (this.reads.has(key)) this.dirty = true
  }

  invalidate(): void {
    this.dirty = true
  }

  close(): void {
    this.closed = true
    this.all.delete(this)
  }

  holds(plugin: string, key: string, requestId: unknown, surface: unknown): boolean {
    if (requestId !== undefined && requestId !== this.target['requestId']) return false
    if (surface !== undefined && surface !== this.target['surface']) return false
    return (this.target['plugin'] === plugin || plugin === 'undefined') && findAll(this.tree, { key }).length > 0
  }

  private async fresh(): Promise<void> {
    if (this.closed) throw new Error('the drawing was unmounted')
    // Let what an act started settle, then draw again what changed.
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
    if (this.dirty) await this.draw()
  }

  /** The tree as last drawn. */
  get current(): unknown {
    return this.tree
  }

  async press(target: Record<string, unknown>): Promise<unknown> {
    await this.fresh()
    const key = String(target['key'])
    const e = {
      plugin: typeof target['plugin'] === 'string' ? target['plugin'] : this.target['plugin'],
      element: key,
      component: this.target['component'],
      requestId: this.target['requestId'],
      surface: this.target['surface'],
      ...(target['link'] !== undefined ? { link: target['link'] } : {}),
    }
    const result = await this.engine.raise('ui.press', e)
    await this.fresh()
    return result
  }

  async act(event: 'ui.input' | 'ui.select', target: Record<string, unknown>): Promise<unknown> {
    await this.fresh()
    const key = String(target['key'])
    const e = event === 'ui.input'
      ? { plugin: target['plugin'] ?? this.target['plugin'], element: key, value: target['text'], kind: target['kind'] ?? 'submit', component: this.target['component'], requestId: this.target['requestId'], surface: this.target['surface'] }
      : { plugin: target['plugin'] ?? this.target['plugin'], element: key, value: target['value'], component: this.target['component'], requestId: this.target['requestId'], surface: this.target['surface'] }
    const result = await this.engine.raise(event, e)
    await this.fresh()
    return result
  }

  handle(): unknown {
    return Object.freeze({
      surface: this.target['surface'],
      drawn: async () => { await this.fresh(); return this.tree },
      find: async (query: Record<string, unknown>) => { await this.fresh(); return findAll(this.tree, query)[0] },
      findAll: async (query: Record<string, unknown>) => { await this.fresh(); return findAll(this.tree, query) },
      press: (target: Record<string, unknown>) => this.press(target),
      input: (target: Record<string, unknown>) => this.act('ui.input', target),
      select: (target: Record<string, unknown>) => this.act('ui.select', target),
      keepsBeneath: async () => { await this.fresh(); return findElements(this.tree, element => element.type === 'engine').length > 0 },
      redraw: async (props?: unknown) => { if (props !== undefined) this.target['props'] = props; await this.draw() },
      unmount: async () => { this.close() },
    })
  }
}

/** Press core: the Button's own `onPress`, in its plugin's environment. */
/** The trees a press may land in: mounted drawings, then what `$.ui.render` drew, latest first. */
function treesOf(mounts: Set<Mount>, drawings: readonly Drawing[], e: Record<string, unknown>): unknown[] {
  return [
    ...[...mounts].filter(mount => e['requestId'] === undefined || mount.holds(String(e['plugin']), String(e['element']), e['requestId'], e['surface'])).map(mount => mount.current),
    ...drawings.filter(drawing => (e['requestId'] === undefined || drawing.requestId === e['requestId']) && (e['surface'] === undefined || drawing.surface === e['surface'])).map(drawing => drawing.tree),
  ]
}

function controlOf(tree: unknown, key: string, prop: string): ((...args: unknown[]) => unknown) | undefined {
  const found = findElements(tree, element => elementKey(element) === key)[0]
  const handler = found?.props[prop]
  return typeof handler === 'function' ? handler as (...args: unknown[]) => unknown : undefined
}

/** Press core: the Button's own `onPress`, in its plugin's environment. */
async function pressCore(e: unknown, mounts: Set<Mount>, drawings: readonly Drawing[]): Promise<unknown> {
  if (!isRecord(e)) return {}
  const key = String(e['element'])
  for (const tree of treesOf(mounts, drawings, e)) {
    const handler = controlOf(tree, key, 'onPress') ?? (e['link'] !== undefined ? controlOf(tree, key, 'onLinkPress') : undefined)
    if (handler === undefined) continue
    await handler(e['link'])
    return { element: key }
  }
  throw new Error(`no Button keyed ${key} is drawn`)
}

async function controlCore(event: string, e: unknown, mounts: Set<Mount>, drawings: readonly Drawing[]): Promise<unknown> {
  if (!isRecord(e)) return {}
  const key = String(e['element'])
  for (const tree of treesOf(mounts, drawings, e)) {
    const handler = event === 'ui.select'
      ? controlOf(tree, key, 'onSelect')
      : controlOf(tree, key, e['kind'] === 'change' ? 'onInput' : 'onSubmit') ?? controlOf(tree, key, 'onInput')
    if (handler === undefined) continue
    await handler(e['value'])
    return { element: key }
  }
  throw new Error(`no ${event === 'ui.select' ? 'Select' : 'Input'} keyed ${key} is drawn`)
}

interface PlainElement {
  type: string
  props: Record<string, unknown>
  children: unknown[]
}

function asElement(node: unknown): PlainElement | undefined {
  if (!isRecord(node) || typeof node['type'] !== 'string') return undefined
  return { type: node['type'], props: isRecord(node['props']) ? node['props'] : {}, children: Array.isArray(node['children']) ? node['children'] : [] }
}

function elementKey(element: PlainElement): string | undefined {
  const key = element.props['key']
  return typeof key === 'string' ? key : undefined
}

function findElements(tree: unknown, test: (element: PlainElement) => boolean): PlainElement[] {
  const out: PlainElement[] = []
  const visit = (node: unknown): void => {
    const element = asElement(node)
    if (element === undefined) return
    if (test(element)) out.push(element)
    for (const child of element.children) visit(child)
  }
  visit(tree)
  return out
}

function shownText(node: unknown): string {
  if (typeof node === 'string') return node
  const element = asElement(node)
  if (element === undefined) return ''
  const own = ['label', 'text', 'source', 'value'].map(prop => element.props[prop]).find(value => typeof value === 'string') as string | undefined
  if (own !== undefined && element.children.length === 0) return own
  return element.children.map(shownText).join('')
}

function findAll(tree: unknown, query: Record<string, unknown>): FoundElement[] {
  return findElements(tree, (element) => {
    if (typeof query['type'] === 'string' && element.type !== query['type']) return false
    if (typeof query['key'] === 'string' && elementKey(element) !== query['key']) return false
    if (query['text'] !== undefined) {
      const text = shownText(element)
      if (typeof query['text'] === 'string' ? !text.includes(query['text']) : !(query['text'] as RegExp).test(text)) return false
    }
    return true
  }).map(element => ({ type: element.type, key: elementKey(element), props: element.props, text: shownText(element), children: element.children }))
}

/** Why a surface cannot draw a tree, or undefined. */
function validateTree(tree: unknown, surface: string): string | undefined {
  const table = elementTable(surface)
  let count = 0
  const visit = (node: unknown, depth: number): string | undefined => {
    if (typeof node === 'string') return undefined
    const element = asElement(node)
    if (element === undefined) return `${JSON.stringify(node)?.slice(0, 60)} is no element`
    if (++count > 20_000) return 'more than 20000 elements'
    if (depth > 32) return 'nested deeper than 32 levels'
    if (element.type !== 'engine' && !(element.type in table)) return `${element.type} is not an element of the ${surface} surface`
    for (const child of element.children) {
      const problem = visit(child, depth + 1)
      if (problem !== undefined) return problem
    }
    return undefined
  }
  return tree === null || tree === undefined ? undefined : visit(tree, 0)
}

// -----------------------------------------------------------------------------
// mock
// -----------------------------------------------------------------------------

/** Calls reaching beneath the plugins: the loop has settled once they stop coming. */
const activity = { count: 0 }

/** Let the event loop run until nothing new reaches beneath the plugins for a while. */
async function settled(): Promise<void> {
  let quiet = 0
  let seen = activity.count
  for (let tick = 0; tick < 2_000 && quiet < 25; tick++) {
    await new Promise(resolveTick => setImmediate(resolveTick))
    if (activity.count === seen) quiet++
    else {
      seen = activity.count
      quiet = 0
    }
  }
}

interface Wait {
  due: number
  resolve: () => void
}

function mockClock(on: StubOn, start: number): unknown {
  let now = start
  const waits: Wait[] = []
  const hold = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolveWait, reject) => {
    const wait: Wait = { due: now + Math.max(0, Number(ms) || 0), resolve: resolveWait }
    waits.push(wait)
    signal?.addEventListener('abort', () => {
      const index = waits.indexOf(wait)
      if (index >= 0) waits.splice(index, 1)
      reject(new Error('the wait was dropped'))
    }, { once: true })
  })
  const settleLoop = settled
  const moveTo = async (target: number): Promise<void> => {
    await settleLoop()
    for (;;) {
      waits.sort((a, b) => a.due - b.due)
      const nextWait = waits[0]
      if (nextWait === undefined || nextWait.due > target) break
      waits.shift()
      now = Math.max(now, nextWait.due)
      nextWait.resolve()
      await settleLoop()
    }
    now = Math.max(now, target)
    await settleLoop()
  }
  on('clock.now', () => ({ value: now }))
  on('clock.sleep', async (_$: unknown, e: { ms: number }, next: { signal: AbortSignal }) => { await hold(e.ms, next.signal); return { value: undefined } })
  on('clock.after', async (_$: unknown, e: { ms: number }, next: { signal: AbortSignal }) => { await hold(e.ms, next.signal); return { value: undefined } })
  on('clock.every', async (_$: unknown, e: { ms: number }, next: { signal: AbortSignal }) => { await hold(e.ms, next.signal); return { value: undefined } })
  return Object.freeze({
    now: () => now,
    advance: (ms: number) => moveTo(now + ms),
    set: (ms: number) => moveTo(Math.max(now, ms)),
    settle: () => moveTo(now),
    sleep: (ms: number) => hold(ms),
  })
}

function mockStore(on: StubOn, entries: Readonly<Record<string, unknown>>): void {
  const store = new Map<string, unknown>(Object.entries(entries).map(([key, value]) => [key, JSON.parse(JSON.stringify(value)) as unknown]))
  on('store.get', (_$: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.set', (_$: unknown, e: { key: string; value: unknown }) => { store.set(e.key, e.value === undefined ? undefined : JSON.parse(JSON.stringify(e.value)) as unknown); return { value: undefined } })
  on('store.delete', (_$: unknown, e: { key: string }) => { store.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...store.keys()] }))
}

function mockEnv(on: StubOn, variables: Readonly<Record<string, string>>): void {
  on('env.get', (_$: unknown, e: { name: string }) => ({ value: variables[e.name] }))
}

function mockSession(on: StubOn): unknown {
  const rows: unknown[] = []
  on('session.append', (_$: unknown, e: Record<string, unknown>) => {
    rows.push(e)
    return { message: e['message'], uuid: e['uuid'] ?? crypto.randomUUID() }
  })
  return Object.freeze({ appended: () => [...rows] })
}
