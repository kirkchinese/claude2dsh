/**
 * Which plugin parts installed adapters bring: an adapter package (a local
 * `dsh-adapter-*` bundle written in DSH's creation mode from a porting brief,
 * or one installed from npm) declares `harnessForge.ports`
 * (`[{ plugin, component }]`, the original's names) in its package.json.
 * A package found on disk only counts once DSH's plugin manager lists it as an
 * enabled bundle whose plugin rows started without a fault (`adapterReadiness`):
 * a failed install can leave a `node_modules` link behind that DSH never runs.
 * The workbench overview and `harness_verify_port` apply that one decision.
 * @module @kirkchinese/harness-forge
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AdapterCoverage } from './overview.js'

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function portsOf(manifest: Record<string, unknown>): AdapterCoverage['ports'] {
  const ports = (manifest['harnessForge'] as { ports?: unknown } | undefined)?.ports
  if (!Array.isArray(ports)) return []
  return ports.flatMap((port: unknown) => {
    const plugin = (port as { plugin?: unknown }).plugin
    const component = (port as { component?: unknown }).component
    return typeof plugin === 'string' && typeof component === 'string' ? [{ plugin, component }] : []
  })
}

/** Where a package's files are: a local install is a link to its source directory. */
function realDir(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return dir
  }
}

/** Package manifests directly under a node_modules directory (scoped ones included). */
function manifestsUnder(modules: string): Array<{ manifest: Record<string, unknown>; dir: string }> {
  if (!existsSync(modules)) return []
  const out: Array<{ manifest: Record<string, unknown>; dir: string }> = []
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const dirs = entry.name.startsWith('@')
      ? readdirSync(join(modules, entry.name), { withFileTypes: true }).map(inner => join(modules, entry.name, inner.name))
      : [join(modules, entry.name)]
    for (const dir of dirs) {
      const manifest = readJson(join(dir, 'package.json'))
      if (manifest !== undefined) out.push({ manifest, dir })
    }
  }
  return out
}

/**
 * The adapters installed in this DSH profile.
 * @param profileDir - the DSH profile directory; its packages and its parent's shared ones are read.
 */
export function adapterCoverage(profileDir: string | undefined): AdapterCoverage[] {
  const out: AdapterCoverage[] = []
  const seen = new Set<string>()
  const roots = profileDir === undefined ? [] : [join(profileDir, 'node_modules'), join(dirname(profileDir), 'node_modules')]
  for (const modules of roots) {
    for (const { manifest, dir } of manifestsUnder(modules)) {
      const name = typeof manifest['name'] === 'string' ? manifest['name'] : undefined
      const ports = portsOf(manifest)
      // A `dsh-adapter-*` package without ports still covers the part its name was given for (see `adapterPackageName`).
      if (name === undefined || (ports.length === 0 && !name.startsWith('dsh-adapter-')) || seen.has(name)) continue
      seen.add(name)
      out.push({ name, ports, dir: realDir(dir) })
    }
  }
  return out
}

/** The part of `pluginManager` (`@deepseek-ai/dsh-plugin-manager`) adapter checks read. */
export interface PluginManagerLike {
  listBundles(): Promise<ReadonlyArray<{
    readonly name: string
    readonly enabled: boolean
    readonly error?: { readonly code: string; readonly diagnostic?: string }
    readonly rows: ReadonlyArray<{ readonly rowId: string; readonly entryId?: string }>
  }>>
  listPlugins(): Promise<ReadonlyArray<{ readonly entryId: string; readonly enabled: boolean; readonly fiberPhase: string | null; readonly diagnostic?: string }>>
}

export type ListedBundle = Awaited<ReturnType<PluginManagerLike['listBundles']>>[number]

/** Where an adapter package stands with DSH: installed and enabled as a bundle that loads, or why not. */
export type BundleState =
  | { readonly state: 'enabled'; readonly bundle: ListedBundle }
  | { readonly state: 'unlisted' }
  | { readonly state: 'off' }
  | { readonly state: 'broken'; readonly error: NonNullable<ListedBundle['error']> }

/** The state of the bundle named `name` among the plugin manager's bundles. */
export function bundleState(name: string, bundles: readonly ListedBundle[]): BundleState {
  const bundle = bundles.find(item => item.name === name)
  if (bundle === undefined) return { state: 'unlisted' }
  if (!bundle.enabled) return { state: 'off' }
  if (bundle.error !== undefined) return { state: 'broken', error: bundle.error }
  return { state: 'enabled', bundle }
}

/** One step of an adapter's readiness, as `harness_verify_port` reports it. */
export interface ReadinessCheck {
  readonly check: 'declared' | 'enabled' | 'loaded'
  readonly ok: boolean
  readonly detail: string
}

const step = (name: ReadinessCheck['check'], ok: boolean, detail: string): ReadinessCheck => ({ check: name, ok, detail })

/** What the plugin manager says now, read once for any number of adapters. */
export interface ManagerSnapshot {
  readonly bundles: readonly ListedBundle[]
  readonly plugins: Awaited<ReturnType<PluginManagerLike['listPlugins']>>
}

export async function managerSnapshot(manager: PluginManagerLike): Promise<ManagerSnapshot> {
  const [bundles, plugins] = await Promise.all([manager.listBundles(), manager.listPlugins()])
  return { bundles, plugins }
}

/**
 * Whether an adapter package found on disk is ready: DSH lists it as an enabled bundle that loads, and every
 * plugin row it declares runs, active, without a startup fault. The one decision the overview counts an adapter
 * by and `harness_verify_port` reports step by step; the last check returned is the first that failed.
 */
export function adapterReadiness(name: string, snapshot: ManagerSnapshot): ReadinessCheck[] {
  const status = bundleState(name, snapshot.bundles)
  if (status.state === 'unlisted') return [step('enabled', false, `${name} is on disk but DSH does not list it as an installed bundle: install it with plugin_manager install_bundle (a link left by a failed install does not count), and check that its package.json declares a bundle (dsh-doc references/host-plugin.md)`)]
  if (status.state === 'off') return [step('enabled', false, `${name} is installed but switched off: enable it with plugin_manager set_bundle`)]
  if (status.state === 'broken') return [step('enabled', false, `${name} is enabled but its bundle cannot load: ${status.error.code}${status.error.diagnostic !== undefined ? ` — ${status.error.diagnostic}` : ''}`)]
  const enabled = step('enabled', true, `${name} is enabled`)
  const rows = status.bundle.rows
  if (rows.length === 0) return [enabled, step('loaded', true, 'its bundle declares no plugin rows, so nothing has to start')]
  const entries = new Map(snapshot.plugins.map(entry => [entry.entryId, entry]))
  const problems: string[] = []
  for (const row of rows) {
    const entry = row.entryId === undefined ? undefined : entries.get(row.entryId)
    if (entry === undefined) problems.push(`row "${row.rowId}" has no running entry`)
    else if (entry.diagnostic !== undefined) problems.push(`row "${row.rowId}" failed to start: ${entry.diagnostic}`)
    else if (!entry.enabled) problems.push(`row "${row.rowId}" is disabled`)
    else if (entry.fiberPhase !== 'active') problems.push(`row "${row.rowId}" is ${entry.fiberPhase ?? 'not running'}`)
  }
  return [enabled, problems.length === 0
    ? step('loaded', true, `all ${String(rows.length)} plugin row(s) of its bundle are active, without startup failures`)
    : step('loaded', false, problems.join('; '))]
}

/**
 * The adapters on disk that are ready (see `adapterReadiness`). Without a plugin manager none is confirmed, so
 * none counts.
 */
export async function enabledAdapters(adapters: readonly AdapterCoverage[], manager: PluginManagerLike | undefined): Promise<AdapterCoverage[]> {
  if (manager === undefined || adapters.length === 0) return []
  const snapshot = await managerSnapshot(manager)
  return adapters.filter(adapter => adapterReadiness(adapter.name, snapshot).every(item => item.ok))
}
