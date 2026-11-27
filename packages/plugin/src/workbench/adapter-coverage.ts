/**
 * Which plugin parts installed adapters bring: an adapter package (a local
 * `dsh-adapter-*` bundle written in DSH's creation mode from a porting brief,
 * or one installed from npm) declares `harnessForge.ports`
 * (`[{ plugin, component }]`, the original's names) in its package.json.
 * A package found on disk only counts once DSH's plugin manager lists it as an
 * enabled bundle that loads (`enabledAdapters`): a failed install can leave a
 * `node_modules` link behind that DSH never runs. The workbench overview and
 * `harness_verify_port` apply the same criterion.
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

/**
 * The adapters on disk that DSH has installed and enabled (see `bundleState`). Without a plugin manager none is
 * confirmed, so none counts.
 */
export async function enabledAdapters(adapters: readonly AdapterCoverage[], manager: PluginManagerLike | undefined): Promise<AdapterCoverage[]> {
  if (manager === undefined || adapters.length === 0) return []
  const bundles = await manager.listBundles()
  return adapters.filter(adapter => bundleState(adapter.name, bundles).state === 'enabled')
}
