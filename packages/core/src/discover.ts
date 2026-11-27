/**
 * Discovery of foreign plugin roots on this machine. It looks only for
 * plugin roots a registered dialect claims (see `dialects/`), stops descending
 * at the first plugin root, and never follows symlinked directories.
 * @module @kirkchinese/harness-forge-core
 */
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { isDirectory } from './paths.js'
import { countComponents, type ComponentCounts, type ForeignPlugin, type SourceId } from './types.js'
import { detectDialect, dialects, FALLBACK_SOURCE, isPluginRoot } from './dialects/registry.js'

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
   * installed, a plugin a marketplace offers but the harness has not
   * installed, or a plugin directory under a discovery root.
   */
  readonly origin: 'user' | 'installed' | 'marketplace' | 'directory'
  /** For an installed plugin: whether the harness has it enabled. */
  readonly enabled?: boolean
  /** The marketplace that offers it. */
  readonly marketplace?: string
}

/** Discovery output. Missing roots are reported, not treated as fatal. */
export interface DiscoveryResult {
  readonly plugins: readonly DiscoveredPlugin[]
  readonly roots: readonly string[]
  readonly missingRoots: readonly string[]
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
 * exist. A harness that records its plugins (Claude Code) has its plugin
 * folder read through that record (one version each, plus marketplace offers)
 * instead of every cached version.
 */
export function discoverPlugins(roots: readonly string[], options: DiscoverOptions = {}): DiscoveryResult {
  const maxDepth = options.maxDepth ?? 6
  const excluded = new Set([...DEFAULT_EXCLUDED, ...(options.excludedNames ?? [])])
  const plugins: DiscoveredPlugin[] = []
  const seen = new Set<string>()
  const missing: string[] = []
  const home = options.home ?? homedir()
  const add = (plugin: DiscoveredPlugin): void => {
    if (seen.has(plugin.root)) return
    seen.add(plugin.root)
    plugins.push(plugin)
  }
  for (const input of roots) {
    const root = resolve(input)
    for (const dialect of dialects()) {
      if (dialect.user === undefined || resolve(dialect.user.anchor(home)) !== root) continue
      const user = dialect.user.scan(home)
      if (user !== undefined) add(summarize(user, 'user'))
    }
    const recorded = dialects().find(dialect => dialect.harnessPlugins !== undefined && resolve(dialect.harnessPlugins.root(home)) === root)
    if (!isDirectory(root)) {
      missing.push(root)
      continue
    }
    if (recorded !== undefined) {
      for (const entry of recorded.harnessPlugins!.list(home)) {
        const discovered = pluginAt(entry.root, false)
        if (discovered === undefined) continue
        add({
          ...discovered,
          origin: entry.origin,
          ...(entry.enabled !== undefined ? { enabled: entry.enabled } : {}),
          ...(entry.marketplace !== undefined ? { marketplace: entry.marketplace } : {}),
        })
      }
      continue
    }
    walk(root, 0, maxDepth, excluded, seen, plugins)
  }
  plugins.sort((a, b) => ORIGIN_ORDER[a.origin] - ORIGIN_ORDER[b.origin] || a.name.localeCompare(b.name, 'en') || a.root.localeCompare(b.root, 'en'))
  return { plugins, roots: roots.map(root => resolve(root)), missingRoots: missing }
}

const ORIGIN_ORDER: Readonly<Record<DiscoveredPlugin['origin'], number>> = { user: 0, installed: 1, directory: 2, marketplace: 3 }

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
