/**
 * Discovery of foreign plugin roots on this machine. It looks only for
 * plugin roots a registered dialect claims (see `dialects/`), stops descending
 * at the first plugin root, and never follows symlinked directories.
 * @module @kirkchinese/harness-forge-core
 */
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { isDirectory, leadsToShare } from './paths.js'
import { countComponents, type ComponentCounts, type ForeignPlugin, type SourceId } from './types.js'
import { detectDialect, dialects, FALLBACK_SOURCE, isPluginRoot } from './dialects/registry.js'
import type { Dialect } from './dialects/types.js'
import type { PluginIdProblem } from './dialects/opencode/plugin-id.js'

/** One discovered plugin root. */
export interface DiscoveredPlugin {
  readonly root: string
  readonly name: string
  readonly source: SourceId
  readonly manifestKind: string
  readonly version?: string
  readonly license?: string
  readonly description?: string
  readonly components: ComponentCounts
  /**
   * Where it was found: the user's own assets, a plugin the harness has
   * installed, or a plugin directory under a discovery root.
   */
  readonly origin: 'user' | 'installed' | 'directory'
  /** Whether the harness runs it: set for an installed plugin, and `false` for user assets it switches off. */
  readonly enabled?: boolean
  /**
   * Set instead of `enabled` when whether the harness runs it cannot be told, saying why: an OpenCode plugin whose
   * id its source does not settle (`missing`, `ambiguous`, `dynamic`), under an entry that switches plugins by id.
   */
  readonly enabledUnknown?: PluginIdProblem
  /** The marketplace that offers it. */
  readonly marketplace?: string
  /** What its harness knows an installed plugin by, across updates (see `HarnessPluginEntry.key`). */
  readonly installKey?: string
}

/** A marketplace a harness added, with a local copy: its plugins are offers, installed one by one, never discovered. */
export interface DiscoveredMarketplace {
  readonly source: SourceId
  readonly name: string
  readonly root: string
}

/** Something discovery could not read: it was skipped, and the rest was found. */
export interface DiscoveryWarning {
  /** The harness whose record or assets it is. */
  readonly source: SourceId
  /** What was skipped, named, and why. */
  readonly message: string
}

/** Discovery output. Missing roots and unreadable entries are reported, not treated as fatal. */
export interface DiscoveryResult {
  readonly plugins: readonly DiscoveredPlugin[]
  /** The local marketplaces of the harnesses whose plugin folder is a root. */
  readonly marketplaces: readonly DiscoveredMarketplace[]
  readonly roots: readonly string[]
  readonly missingRoots: readonly string[]
  readonly warnings: readonly DiscoveryWarning[]
}

/** Options for a filesystem walk. */
export interface DiscoverOptions {
  readonly maxDepth?: number
  readonly excludedNames?: readonly string[]
  /** Home directory whose harness directories are read specially (tests). */
  readonly home?: string
}

const DEFAULT_EXCLUDED = new Set(['node_modules', '.git', 'dist', 'lib', 'out', '.cache'])

/** Where the registered dialects' harnesses install plugins, plus the common-format folders. */
export function defaultDiscoveryRoots(home = homedir()): string[] {
  return dialects().flatMap(dialect => dialect.discoveryRoots?.(home) ?? [])
}

/**
 * Discover plugin roots under the given directories. A dialect's user assets
 * are listed when its anchor folder is a root, even when that folder does not
 * exist. A harness that records its plugins (Claude Code, Codex, OpenCode)
 * has its plugin folder read through that record: the plugins it installed,
 * one version each, read as that harness's plugins. Cached versions and
 * marketplace offers are not plugins of the person's; the marketplaces that
 * offer them are listed apart.
 */
export function discoverPlugins(roots: readonly string[], options: DiscoverOptions = {}): DiscoveryResult {
  const maxDepth = options.maxDepth ?? 6
  const excluded = new Set([...DEFAULT_EXCLUDED, ...(options.excludedNames ?? [])])
  const plugins: DiscoveredPlugin[] = []
  const seen = new Set<string>()
  const missing: string[] = []
  const marketplaces: DiscoveredMarketplace[] = []
  const warnings: DiscoveryWarning[] = []
  const home = options.home ?? homedir()
  // One harness's record that cannot be read costs that harness's part only, not the others'.
  const guarded = <T>(dialect: Dialect, what: string, read: () => T): T | undefined => {
    try {
      return read()
    } catch (error: unknown) {
      warnings.push({ source: dialect.id, message: `${dialect.label} ${what} could not be read and is skipped: ${error instanceof Error ? error.message : String(error)}` })
      return undefined
    }
  }
  const add = (plugin: DiscoveredPlugin): void => {
    if (seen.has(plugin.root)) return
    seen.add(plugin.root)
    plugins.push(plugin)
  }
  for (const input of roots) {
    const root = resolve(input)
    for (const dialect of dialects()) {
      if (dialect.user === undefined || resolve(dialect.user.anchor(home)) !== root) continue
      const user = guarded(dialect, 'user assets', () => dialect.user!.scan(home))
      if (user === undefined) continue
      const enablement = guarded(dialect, 'user assets', () => dialect.user!.enablement?.(home))
      const state = enablement === undefined ? {} : 'enabledUnknown' in enablement ? { enabledUnknown: enablement.enabledUnknown } : enablement.enabled ? {} : { enabled: false }
      add({ ...summarize(user, 'user'), ...state })
    }
    const recorded = dialects().find(dialect => dialect.harnessPlugins?.roots(home).some(path => resolve(path) === root) === true)
    // A harness's record can name plugins outside a folder that does not exist (OpenCode's configured packages).
    if (!isDirectory(root)) missing.push(root)
    if (recorded !== undefined) {
      const listed = guarded(recorded, `plugin record for ${root}`, () => recorded.harnessPlugins!.list(home, root))
      // What could not be read is said, not passed over: the plugins it would have listed are missing from this view.
      for (const message of [...listed?.unread ?? [], ...(listed?.unresolved ?? []).map(item => item.message)]) warnings.push({ source: recorded.id, message })
      for (const entry of listed?.entries ?? []) {
        const discovered = scanned(recorded, entry.root)
        if (discovered === undefined) continue
        add({
          ...discovered,
          origin: 'installed',
          installKey: entry.key,
          ...(entry.enabled !== undefined ? { enabled: entry.enabled } : {}),
          ...(entry.enabledUnknown !== undefined ? { enabledUnknown: entry.enabledUnknown } : {}),
          ...(entry.marketplace !== undefined ? { marketplace: entry.marketplace } : {}),
        })
      }
      for (const market of guarded(recorded, 'marketplaces', () => recorded.harnessPlugins!.marketplaces?.(home)) ?? []) {
        if (!marketplaces.some(known => known.root === market.root)) marketplaces.push({ source: recorded.id, ...market })
      }
      continue
    }
    if (isDirectory(root)) walk(root, 0, maxDepth, excluded, seen, plugins)
  }
  plugins.sort((a, b) => ORIGIN_ORDER[a.origin] - ORIGIN_ORDER[b.origin] || a.name.localeCompare(b.name, 'en') || a.root.localeCompare(b.root, 'en'))
  return { plugins, marketplaces, roots: roots.map(root => resolve(root)), missingRoots: missing, warnings }
}

const ORIGIN_ORDER: Readonly<Record<DiscoveredPlugin['origin'], number>> = { user: 0, installed: 1, directory: 2 }

function summarize(plugin: ForeignPlugin, origin: DiscoveredPlugin['origin']): DiscoveredPlugin {
  return {
    root: plugin.root,
    name: plugin.name,
    source: plugin.source,
    manifestKind: plugin.ref.manifestKind,
    ...(plugin.version !== undefined ? { version: plugin.version } : {}),
    ...(plugin.license !== undefined ? { license: plugin.license } : {}),
    ...(plugin.description !== undefined ? { description: plugin.description } : {}),
    components: countComponents(plugin.components),
    origin,
  }
}

function walk(
  directory: string,
  depth: number,
  maxDepth: number,
  excluded: ReadonlySet<string>,
  seen: Set<string>,
  out: DiscoveredPlugin[],
): void {
  if (depth > maxDepth) return
  const key = resolve(directory)
  if (seen.has(key)) return
  seen.add(key)
  // A listed folder may itself be a common-format plugin (a skills folder); the folders below it may not.
  const plugin = pluginAt(directory, depth === 0)
  if (plugin !== undefined) {
    out.push(plugin)
    return
  }
  let entries
  // On a link to a network share the path is not on: as unreadable (see `leadsToShare`).
  if (leadsToShare(directory)) return
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || excluded.has(entry.name)) continue
    walk(join(directory, entry.name), depth + 1, maxDepth, excluded, seen, out)
  }
}

/** A plugin the harness installed, read as that harness's: Codex keeps a plugin with a Claude manifest too, say. */
function scanned(dialect: Dialect, root: string): DiscoveredPlugin | undefined {
  if (!isDirectory(root)) return undefined
  try {
    return summarize(dialect.scan(root), 'directory')
  } catch {
    return undefined
  }
}

function pluginAt(directory: string, listed: boolean): DiscoveredPlugin | undefined {
  if (!isPluginRoot(directory, listed)) return undefined
  const dialect = detectDialect(directory, listed)
  if (dialect === undefined) return undefined
  try {
    return summarize(dialect.scan(directory), 'directory')
  } catch {
    return undefined
  }
}

/**
 * The dialect a plugin root speaks. A multi-harness root (Claude manifest and
 * `opencode.json` side by side) is read through the first manifest in
 * registry order; a bare plugin layout comes next, the common formats last.
 */
export function detectSource(root: string): SourceId {
  return detectDialect(root)?.id ?? FALLBACK_SOURCE
}
