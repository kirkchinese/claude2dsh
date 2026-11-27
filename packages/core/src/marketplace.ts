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
  /** npm registry URL. */
  readonly registry?: string
  /** Zip URL of an `archive` source is `url`; this is its pinned digest. */
  readonly sha256?: string
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
  /** The entry as written: with no `plugin.json` of its own, the plugin's manifest (Claude Code's rule). */
  readonly fields: Readonly<Record<string, unknown>>
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

/** Options of {@link parseMarketplace}. */
export interface ParseMarketplaceOptions {
  /**
   * False for a `marketplace.json` fetched by URL: there are no files beside it,
   * so its relative entries cannot be installed (Claude Code's rule).
   */
  readonly filesAvailable?: boolean
}

/** Parse a marketplace document rooted at `root`. */
export function parseMarketplace(
  data: Record<string, unknown>,
  root: string,
  manifestPath = join(root, 'marketplace.json'),
  options: ParseMarketplaceOptions = {},
): MarketplaceIndex {
  const warnings: string[] = []
  const name = typeof data['name'] === 'string' && data['name'].trim().length > 0 ? data['name'].trim() : 'unnamed-marketplace'
  const description = typeof data['description'] === 'string'
    ? data['description']
    : isPlainObject(data['metadata']) && typeof data['metadata']['description'] === 'string' ? data['metadata']['description'] : undefined
  const owner = isPlainObject(data['owner']) && typeof data['owner']['name'] === 'string'
    ? data['owner']['name']
    : undefined
  const metadata = isPlainObject(data['metadata']) ? data['metadata'] : {}
  const pluginRoot = typeof metadata['pluginRoot'] === 'string' ? metadata['pluginRoot'] : undefined
  const context: SourceContext = { root, warnings, filesAvailable: options.filesAvailable !== false, ...(pluginRoot !== undefined ? { pluginRoot } : {}) }
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
    const source = parseSource(raw['source'], context, entryName)
    if (source === undefined) continue
    entries.push({
      name: entryName,
      ...(typeof raw['description'] === 'string' ? { description: raw['description'] } : {}),
      ...(typeof raw['version'] === 'string' ? { version: raw['version'] } : {}),
      ...(typeof raw['license'] === 'string' ? { license: raw['license'] } : {}),
      ...(typeof raw['category'] === 'string' ? { category: raw['category'] } : {}),
      tags: Array.isArray(raw['tags']) ? raw['tags'].filter((tag): tag is string => typeof tag === 'string') : [],
      source,
      fields: raw,
    })
  }
  return { name, ...(description !== undefined ? { description } : {}), ...(owner !== undefined ? { owner } : {}), root, manifestPath, entries, warnings }
}

interface SourceContext {
  readonly root: string
  readonly warnings: string[]
  readonly filesAvailable: boolean
  readonly pluginRoot?: string
}

/** A relative entry path inside the marketplace root, or undefined (with a warning) when it leaves it. */
function insideRoot(declared: string, context: SourceContext, entryName: string, raw: unknown): MarketplaceSource | undefined {
  if (!context.filesAvailable) {
    context.warnings.push(`entry ${entryName} uses a relative path, which a marketplace.json fetched by URL cannot provide`)
    return { kind: 'unknown', raw }
  }
  const path = resolve(context.root, declared)
  if (!isInside(context.root, path)) {
    context.warnings.push(`entry ${entryName} source escapes the marketplace root: ${declared}`)
    return undefined
  }
  return { kind: 'path', path, raw }
}

function parseSource(raw: unknown, context: SourceContext, entryName: string): MarketplaceSource | undefined {
  const { warnings } = context
  if (typeof raw === 'string') {
    if (raw.startsWith('.') || isAbsolute(raw)) return insideRoot(raw, context, entryName, raw)
    // A bare name resolves under metadata.pluginRoot (Claude Code v2.1.239+).
    if (context.pluginRoot !== undefined && /^[^/\\]+$/u.test(raw)) return insideRoot(join(context.pluginRoot, raw), context, entryName, raw)
    warnings.push(`entry ${entryName} has an unsupported relative source: ${raw}`)
    return { kind: 'unknown', raw }
  }
  if (!isPlainObject(raw)) {
    warnings.push(`entry ${entryName} has no source`)
    return undefined
  }
  const type = typeof raw['source'] === 'string' ? raw['source'] : ''
  if (type === 'local' || type === 'path' || type === '') {
    const declared = typeof raw['path'] === 'string' ? raw['path'] : undefined
    if (declared === undefined) {
      warnings.push(`entry ${entryName} local source has no path`)
      return { kind: 'unknown', raw }
    }
    return insideRoot(declared, context, entryName, raw)
  }
  const pins = {
    ...(typeof raw['ref'] === 'string' ? { ref: raw['ref'] } : {}),
    ...(typeof raw['sha'] === 'string' ? { sha: raw['sha'] } : {}),
  }
  if (type === 'github') {
    const repo = typeof raw['repo'] === 'string' ? raw['repo'] : undefined
    if (repo === undefined) return { kind: 'unknown', raw }
    return { kind: 'git', url: `https://github.com/${repo}.git`, ...pins, raw }
  }
  if (type === 'url' || type === 'git' || type === 'git-subdir') {
    const url = typeof raw['url'] === 'string' ? raw['url'] : undefined
    if (url === undefined) return { kind: 'unknown', raw }
    const subpath = typeof raw['path'] === 'string' ? raw['path'].replace(/^\.\//u, '') : undefined
    if (subpath !== undefined && (subpath.split(/[\\/]/u).includes('..') || isAbsolute(subpath))) {
      warnings.push(`entry ${entryName} source path escapes its repository: ${subpath}`)
      return undefined
    }
    // git-subdir takes GitHub owner/repo shorthand; url and git take a full URL.
    const full = type === 'git-subdir' && /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/u.test(url) ? `https://github.com/${url}.git` : url
    return { kind: 'git', url: full, ...(subpath !== undefined && subpath.length > 0 && subpath !== '.' ? { subpath } : {}), ...pins, raw }
  }
  if (type === 'npm') {
    const pkg = typeof raw['package'] === 'string' ? raw['package'] : undefined
    if (pkg === undefined) return { kind: 'unknown', raw }
    return {
      kind: 'npm',
      package: pkg,
      ...(typeof raw['version'] === 'string' ? { version: raw['version'] } : {}),
      ...(typeof raw['registry'] === 'string' ? { registry: raw['registry'] } : {}),
      raw,
    }
  }
  if (type === 'archive') {
    return {
      kind: 'archive',
      ...(typeof raw['url'] === 'string' ? { url: raw['url'] } : {}),
      ...(typeof raw['sha256'] === 'string' ? { sha256: raw['sha256'] } : {}),
      raw,
    }
  }
  if (type === 'command') return { kind: 'command', raw }
  return { kind: 'unknown', raw }
}
