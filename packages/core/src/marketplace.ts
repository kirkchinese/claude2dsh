/**
 * Read-only marketplace indexes. Harness Forge intentionally supports the
 * common local/relative and git/npm declarations first; unsupported source
 * kinds are reported instead of guessed.
 * @module @kirkchinese/harness-forge-core
 */
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { HarnessError } from './contracts.js'
import { isFile, isInside, isPlainObject, readJsonObject } from './paths.js'

/** A marketplace index source kind. */
export type MarketplaceSourceKind = 'path' | 'git' | 'npm' | 'archive' | 'command' | 'unknown'

/** Where one marketplace entry's plugin lives. */
export interface MarketplaceSource {
  readonly kind: MarketplaceSourceKind
  /** Absolute local path for `path` sources. */
  readonly path?: string
  /** Repository URL for `git` sources. */
  readonly url?: string
  /** Subdirectory inside a git repository. */
  readonly subpath?: string
  readonly ref?: string
  readonly sha?: string
  /** npm package name. */
  readonly package?: string
  readonly version?: string
  /** Original declaration for diagnostics. */
  readonly raw: unknown
}

/** One entry in a marketplace index. */
export interface MarketplaceEntry {
  readonly name: string
  readonly description?: string
  readonly version?: string
  readonly license?: string
  readonly category?: string
  readonly tags: readonly string[]
  readonly source: MarketplaceSource
}

/** A parsed marketplace index. */
export interface MarketplaceIndex {
  readonly name: string
  readonly description?: string
  readonly owner?: string
  readonly root: string
  readonly manifestPath: string
  readonly entries: readonly MarketplaceEntry[]
  readonly warnings: readonly string[]
}

/** Marketplace parsing failure with a stable code. */
export class MarketplaceError extends HarnessError {
  constructor(
    code: 'manifest-not-found' | 'manifest-invalid' | 'plugins-missing' | 'entry-not-found' | 'unsupported-source',
    message: string,
  ) {
    super(code, message)
    this.name = 'MarketplaceError'
  }
}

/** Candidate manifest names, in Claude-then-Codex order. */
const MANIFESTS = [
  join('.claude-plugin', 'marketplace.json'),
  join('.agents', 'plugins', 'marketplace.json'),
  'marketplace.json',
] as const

/**
 * Read a marketplace index from a directory or a direct manifest path.
 * @param path - directory or JSON manifest.
 * @returns parsed index.
 * @throws {MarketplaceError} when no manifest or invalid JSON is found.
 */
export function readMarketplace(path: string): MarketplaceIndex {
  const absolute = resolve(path)
  const manifestPath = isFile(absolute)
    ? absolute
    : MANIFESTS.map(candidate => join(absolute, candidate)).find(candidate => isFile(candidate))
  if (manifestPath === undefined) {
    throw new MarketplaceError('manifest-not-found', `no marketplace.json found under ${absolute}`)
  }
  const data = readJsonObject(manifestPath)
  if (data === undefined) {
    throw new MarketplaceError('manifest-invalid', `cannot parse marketplace manifest ${manifestPath}`)
  }
  return parseMarketplace(data, marketplaceRoot(manifestPath), manifestPath)
}

/** The marketplace root is the directory containing the manifest's owner
 * directory (`.claude-plugin` or `.agents/plugins`), not that directory. */
function marketplaceRoot(manifestPath: string): string {
  const normalized = manifestPath.replace(/\\/gu, '/')
  if (normalized.endsWith('/.claude-plugin/marketplace.json')) return dirname(dirname(manifestPath))
  if (normalized.endsWith('/.agents/plugins/marketplace.json')) return dirname(dirname(dirname(manifestPath)))
  return dirname(manifestPath)
}

/** Parse a marketplace document rooted at `root`. */
export function parseMarketplace(
  data: Record<string, unknown>,
  root: string,
  manifestPath = join(root, 'marketplace.json'),
): MarketplaceIndex {
  const warnings: string[] = []
  const name = typeof data['name'] === 'string' && data['name'].trim().length > 0 ? data['name'].trim() : 'unnamed-marketplace'
  const description = typeof data['description'] === 'string' ? data['description'] : undefined
  const owner = isPlainObject(data['owner']) && typeof data['owner']['name'] === 'string'
    ? data['owner']['name']
    : undefined
  const plugins = data['plugins']
  if (!Array.isArray(plugins)) throw new MarketplaceError('plugins-missing', `marketplace ${name} has no plugins array`)
  const entries: MarketplaceEntry[] = []
  for (const [index, raw] of plugins.entries()) {
    if (!isPlainObject(raw)) {
      warnings.push(`entry ${index + 1} is not an object`)
      continue
    }
    const entryName = typeof raw['name'] === 'string' ? raw['name'].trim() : ''
    if (entryName.length === 0) {
      warnings.push(`entry ${index + 1} has no name`)
      continue
    }
    const source = parseSource(raw['source'], root, entryName, warnings)
    if (source === undefined) continue
    entries.push({
      name: entryName,
      ...(typeof raw['description'] === 'string' ? { description: raw['description'] } : {}),
      ...(typeof raw['version'] === 'string' ? { version: raw['version'] } : {}),
      ...(typeof raw['license'] === 'string' ? { license: raw['license'] } : {}),
      ...(typeof raw['category'] === 'string' ? { category: raw['category'] } : {}),
      tags: Array.isArray(raw['tags']) ? raw['tags'].filter((tag): tag is string => typeof tag === 'string') : [],
      source,
    })
  }
  return { name, ...(description !== undefined ? { description } : {}), ...(owner !== undefined ? { owner } : {}), root, manifestPath, entries, warnings }
}

function parseSource(raw: unknown, root: string, entryName: string, warnings: string[]): MarketplaceSource | undefined {
  if (typeof raw === 'string') {
    const path = raw.startsWith('.') || isAbsolute(raw) ? resolve(root, raw) : undefined
    if (path !== undefined && !isInside(root, path)) {
      warnings.push(`entry ${entryName} source escapes the marketplace root: ${raw}`)
      return undefined
    }
    if (path !== undefined) return { kind: 'path', path, raw }
    // Claude relative sources must start with './'; a bare name may be
    // resolved under metadata.pluginRoot, which this first reader does not
    // model. Report rather than invent a location.
    warnings.push(`entry ${entryName} has an unsupported relative source: ${raw}`)
    return { kind: 'unknown', raw }
  }
  if (!isPlainObject(raw)) {
    warnings.push(`entry ${entryName} has no source`)
    return undefined
  }
  const type = typeof raw['source'] === 'string' ? raw['source'] : ''
  if (type === 'local' || type === 'path' || type === '') {
    const declared = typeof raw['path'] === 'string' ? raw['path'] : typeof raw['source'] === 'string' ? raw['source'] : undefined
    if (declared === undefined) {
      warnings.push(`entry ${entryName} local source has no path`)
      return { kind: 'unknown', raw }
    }
    const path = resolve(root, declared)
    if (!isInside(root, path)) {
      warnings.push(`entry ${entryName} source escapes the marketplace root: ${declared}`)
      return undefined
    }
    return { kind: 'path', path, raw }
  }
  if (type === 'github') {
    const repo = typeof raw['repo'] === 'string' ? raw['repo'] : undefined
    if (repo === undefined) return { kind: 'unknown', raw }
    return {
      kind: 'git',
      url: `https://github.com/${repo}.git`,
      ...(typeof raw['ref'] === 'string' ? { ref: raw['ref'] } : {}),
      ...(typeof raw['sha'] === 'string' ? { sha: raw['sha'] } : {}),
      raw,
    }
  }
  if (type === 'url' || type === 'git' || type === 'git-subdir') {
    const url = typeof raw['url'] === 'string' ? raw['url'] : undefined
    if (url === undefined) return { kind: 'unknown', raw }
    return {
      kind: 'git',
      url,
      ...(typeof raw['path'] === 'string' ? { subpath: raw['path'] } : {}),
      ...(typeof raw['ref'] === 'string' ? { ref: raw['ref'] } : {}),
      ...(typeof raw['sha'] === 'string' ? { sha: raw['sha'] } : {}),
      raw,
    }
  }
  if (type === 'npm') {
    const pkg = typeof raw['package'] === 'string' ? raw['package'] : undefined
    if (pkg === undefined) return { kind: 'unknown', raw }
    return {
      kind: 'npm',
      package: pkg,
      ...(typeof raw['version'] === 'string' ? { version: raw['version'] } : {}),
      raw,
    }
  }
  if (type === 'archive' || type === 'command') return { kind: type, raw }
  return { kind: 'unknown', raw }
}
