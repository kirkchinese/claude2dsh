/**
 * What a person pastes to get a plugin from the network, and where each
 * marketplace entry's plugin is fetched from. Pure: no network, no disk.
 *
 * - `owner/repo`, `owner/repo@ref`, `owner/repo#ref`, `github:owner/repo` and
 *   `https://github.com/owner/repo[/tree/<ref>/<path>]` name a GitHub repository
 *   (a marketplace, or a single plugin).
 * - Any other `https://`, `http://`, `ssh://`, `git@host:path` or `file://` URL
 *   is a git repository (`#ref` pins a ref), except an `http(s)` URL ending in
 *   `.json`, which is a hosted `marketplace.json`.
 * - `@scope/name`, `name`, `name@version`, `npm:<spec>` and
 *   `https://www.npmjs.com/package/<name>` are npm packages (OpenCode plugins).
 * - An absolute or `./`/`~` path is a local folder.
 *
 * What a person pastes may name any host they choose. What a marketplace names
 * is the marketplace's say-so: {@link marketplaceProblem} limits it to HTTPS
 * (and npm's registry), full commit SHAs and well-formed refs.
 * @module @kirkchinese/harness-forge-core
 */
import { HarnessError } from './contracts.js'
import type { MarketplaceSource } from './marketplace.js'
import { stripTrailing } from './text.js'

/** A git repository, or one directory of it. */
export interface GitSpec {
  readonly kind: 'git'
  /** Clone URL. */
  readonly url: string
  /** Branch or tag; the default branch when absent. */
  readonly ref?: string
  /** Full commit SHA this source is pinned to. */
  readonly sha?: string
  /** Directory of the plugin inside the repository. */
  readonly subpath?: string
  /** Set when the repository is on GitHub: allows the HTTPS archive fallback when git is missing. */
  readonly github?: { readonly owner: string; readonly repo: string }
}

/** A `marketplace.json` served over HTTP(S). Its entries cannot use relative paths. */
export interface JsonSpec {
  readonly kind: 'json'
  readonly url: string
}

/** An npm package. */
export interface NpmSpec {
  readonly kind: 'npm'
  readonly package: string
  /** Version, range or dist-tag; `latest` when absent. */
  readonly version?: string
  readonly registry?: string
}

/** A zip archive over HTTPS (a Claude Code `archive` plugin source). */
export interface ArchiveSpec {
  readonly kind: 'archive'
  readonly url: string
  readonly sha256?: string
}

/** A folder on this computer. */
export interface LocalSpec {
  readonly kind: 'local'
  readonly path: string
}

/** Where something to install comes from. */
export type RemoteSpec = GitSpec | JsonSpec | NpmSpec | ArchiveSpec | LocalSpec

/** A marketplace Harness Forge lists ready to browse; each is confirmed from its publisher's documentation. */
export interface DefaultMarketplace {
  /** The marketplace's `name`, as its harness shows it. */
  readonly id: string
  /** What the person would paste for it. */
  readonly input: string
  readonly harness: 'claude-code' | 'codex'
  /** Where its publisher documents it. */
  readonly docs: string
}

/**
 * Anthropic's official and community marketplaces and its two topic marketplaces
 * (https://code.claude.com/docs/en/plugins/anthropic-marketplaces), and OpenAI's
 * curated Codex plugins (https://developers.openai.com/codex/plugins/build).
 */
export const DEFAULT_MARKETPLACES: readonly DefaultMarketplace[] = [
  { id: 'claude-plugins-official', input: 'anthropics/claude-plugins-official', harness: 'claude-code', docs: 'https://code.claude.com/docs/en/plugins/anthropic-marketplaces' },
  { id: 'claude-community', input: 'anthropics/claude-plugins-community', harness: 'claude-code', docs: 'https://code.claude.com/docs/en/plugins/anthropic-marketplaces' },
  { id: 'anthropic-agent-skills', input: 'anthropics/skills', harness: 'claude-code', docs: 'https://code.claude.com/docs/en/plugins/anthropic-marketplaces' },
  { id: 'knowledge-work-plugins', input: 'anthropics/knowledge-work-plugins', harness: 'claude-code', docs: 'https://code.claude.com/docs/en/plugins/anthropic-marketplaces' },
  { id: 'openai-curated', input: 'openai/plugins', harness: 'codex', docs: 'https://developers.openai.com/codex/plugins/build' },
]

const OWNER = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})'
const REPO = '[A-Za-z0-9._-]+'
// One optional `/sub/path` group (its class includes `/`): `(?:/[^@#\s]+)*` matches the same text but backtracks exponentially.
const SHORTHAND = new RegExp(`^(?:github:)?(${OWNER})/(${REPO}?)((?:/[^@#\\s]+)?)(?:[@#](\\S+))?$`, 'u')
/** npm's package name rules, loosely: lowercase, URL-safe, optional scope. */
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u
const SHA = /^[0-9a-f]{40}$/u
/** An npm version, range or dist-tag: never a URL, a path or a git spec (no `/`, no `:`). */
const NPM_RANGE = /^[\w.^~<>=|*+\-\s]*$/u

/** Whether a string is a full (40 hex digit) commit SHA. */
export function isFullSha(value: string): boolean {
  return SHA.test(value)
}

/**
 * Whether a branch or tag name is one git accepts (`git check-ref-format`) and
 * cannot be read as an option: no leading `-`, no `..`, `@{`, `//`, control
 * characters, spaces or `~^:?*[\`, no component starting with `.` or ending
 * with `.lock`, and not ending with `/` or `.`.
 */
export function isValidRef(ref: string): boolean {
  if (ref.length === 0 || ref.length > 255 || ref === '@') return false
  if (!/^[A-Za-z0-9._/@+-]+$/u.test(ref) || ref.startsWith('-') || ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.')) return false
  if (ref.includes('..') || ref.includes('@{') || ref.includes('//')) return false
  return ref.split('/').every(part => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'))
}

/** Whether an npm version, range or dist-tag stays a registry lookup (never a git, URL or path spec). */
export function isRegistryRange(value: string): boolean {
  return NPM_RANGE.test(value) && !value.trim().startsWith('-')
}

/** Whether a directory inside a repository stays inside it and cannot be read as an option. */
function isSafeSubpath(path: string): boolean {
  const parts = path.split(/[\\/]/u)
  return !path.startsWith('-') && !path.startsWith('/') && !/^[A-Za-z]:/u.test(path) && !parts.includes('..')
}

function invalid(input: string, why: string): HarnessError {
  return new HarnessError('unsupported-source', `${why}: ${input}`, {
    suggestion: 'Paste owner/repo, a git URL, a URL to marketplace.json, or an npm package name.',
  })
}

/** The GitHub repository a clone URL names, or undefined for another host. */
export function githubOf(url: string): { owner: string; repo: string } | undefined {
  const match = /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/iu.exec(url)
  if (match === null) return undefined
  return { owner: match[1]!, repo: match[2]! }
}

function github(owner: string, repo: string, ref?: string, subpath?: string): GitSpec {
  const clean = repo.replace(/\.git$/u, '')
  if (ref !== undefined && ref.length > 0 && !SHA.test(ref) && !isValidRef(ref)) throw invalid(ref, 'not a branch, tag or commit name git accepts')
  if (subpath !== undefined && subpath.length > 0 && !isSafeSubpath(subpath)) throw invalid(subpath, 'the directory leaves the repository')
  return {
    kind: 'git',
    url: `https://github.com/${owner}/${clean}.git`,
    github: { owner, repo: clean },
    ...(ref !== undefined && ref.length > 0 ? SHA.test(ref) ? { sha: ref } : { ref } : {}),
    ...(subpath !== undefined && subpath.length > 0 ? { subpath } : {}),
  }
}

/** Split an npm spec `name@version` (scope-aware). */
function npmSpec(spec: string): NpmSpec | undefined {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0)
  const name = at < 0 ? spec : spec.slice(0, at)
  const version = at < 0 ? undefined : spec.slice(at + 1)
  if (!NPM_NAME.test(name) || version === '' || (version !== undefined && !isRegistryRange(version))) return undefined
  return { kind: 'npm', package: name, ...(version !== undefined ? { version } : {}) }
}

/**
 * Read what a person pasted.
 * @throws {HarnessError} `unsupported-source` when it names nothing Harness Forge can fetch.
 */
export function parseRemoteInput(raw: string): RemoteSpec {
  const input = raw.trim()
  if (input.length === 0) throw invalid(input, 'nothing to fetch')
  if (/^(?:\/|~[/\\]?|\.{1,2}[/\\]|[A-Za-z]:[/\\])/u.test(input) || input === '~' || input === '.') return { kind: 'local', path: input }
  if (input.startsWith('npm:')) {
    const spec = npmSpec(input.slice(4))
    if (spec === undefined) throw invalid(input, 'not an npm package name')
    return spec
  }
  if (/^https?:\/\//iu.test(input)) {
    let url: URL
    try {
      url = new URL(input)
    } catch {
      throw invalid(input, 'not a valid URL')
    }
    const host = url.hostname.toLowerCase()
    if (host === 'github.com' || host === 'www.github.com') {
      const parts = url.pathname.split('/').filter(part => part.length > 0)
      if (parts.length < 2) throw invalid(input, 'not a GitHub repository URL')
      const [owner, repo, kind, ref, ...rest] = parts
      const fragment = url.hash.length > 1 ? decodeURIComponent(url.hash.slice(1)) : undefined
      if ((kind === 'tree' || kind === 'blob') && ref !== undefined) {
        const path = rest.join('/')
        // A link to a marketplace.json file in the repository: the repository is the marketplace.
        const subpath = /(?:^|\/)\.claude-plugin\/marketplace\.json$|(?:^|\/)\.agents\/plugins\/marketplace\.json$/u.test(path) ? undefined : path.replace(/\/?(?:\.claude-plugin|\.codex-plugin)\/plugin\.json$/u, '')
        return github(owner!, repo!, decodeURIComponent(ref), subpath)
      }
      if (kind !== undefined && kind !== 'tree') throw invalid(input, 'not a GitHub repository URL')
      return github(owner!, repo!, fragment)
    }
    if (host === 'www.npmjs.com' || host === 'npmjs.com') {
      const match = /^\/package\/((?:@[^/]+\/)?[^/]+)(?:\/v\/([^/]+))?/u.exec(url.pathname)
      const spec = match === null ? undefined : npmSpec(`${decodeURIComponent(match[1]!)}${match[2] !== undefined ? `@${match[2]}` : ''}`)
      if (spec === undefined) throw invalid(input, 'not an npm package page')
      return spec
    }
    if (/\.json$/iu.test(url.pathname)) return { kind: 'json', url: url.href }
    return gitUrl(input)
  }
  if (/^(?:ssh|git|file):\/\//iu.test(input) || /^[\w.-]+@[\w.-]+:/u.test(input)) return gitUrl(input)
  const shorthand = SHORTHAND.exec(input)
  if (shorthand !== null && shorthand[2] !== undefined && shorthand[2].length > 0 && !input.startsWith('@')) {
    return github(shorthand[1]!, shorthand[2], shorthand[4], shorthand[3]?.replace(/^\//u, ''))
  }
  const spec = npmSpec(input)
  if (spec !== undefined) return spec
  throw invalid(input, 'not a repository, URL or package')
}

/** A git URL with an optional `#ref` (a full SHA there pins the commit). */
function gitUrl(input: string): GitSpec {
  const hash = input.indexOf('#')
  const url = hash < 0 ? input : input.slice(0, hash)
  const ref = hash < 0 ? undefined : input.slice(hash + 1)
  if (url.startsWith('-') || /\s/u.test(url)) throw invalid(input, 'not a git URL')
  const hub = githubOf(url)
  if (hub !== undefined) return github(hub.owner, hub.repo, ref)
  if (ref !== undefined && ref.length > 0 && !SHA.test(ref) && !isValidRef(ref)) throw invalid(ref, 'not a branch, tag or commit name git accepts')
  return { kind: 'git', url, ...(ref !== undefined && ref.length > 0 ? SHA.test(ref) ? { sha: ref } : { ref } : {}) }
}

/** The transport a git URL uses: `https`, `http`, `ssh` (also `user@host:path`), `git`, `file`, or undefined for anything else. */
export function gitTransport(url: string): 'https' | 'http' | 'ssh' | 'git' | 'file' | undefined {
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//u.exec(url)?.[1]?.toLowerCase()
  if (scheme === 'https' || scheme === 'http' || scheme === 'ssh' || scheme === 'git' || scheme === 'file') return scheme
  if (scheme === undefined && /^[\w.-]+@[\w.-]+:(?!\/\/)/u.test(url) && !url.startsWith('-')) return 'ssh'
  return undefined
}

/**
 * Where a marketplace entry's plugin is fetched from, or undefined for an entry
 * inside the marketplace (a `path` source) and for sources Harness Forge does not
 * fetch (`command`: it would run a command from the marketplace on this computer).
 */
export function specOfSource(source: MarketplaceSource): RemoteSpec | undefined {
  if (source.kind === 'git' && source.url !== undefined) {
    let base: GitSpec
    try {
      base = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/u.test(source.url) ? github(...(source.url.split('/') as [string, string])) : gitUrl(source.url)
    } catch {
      return undefined
    }
    const sha = source.sha ?? base.sha
    return {
      kind: 'git',
      url: base.url,
      ...(base.github !== undefined ? { github: base.github } : {}),
      ...(source.ref !== undefined ? { ref: source.ref } : base.ref !== undefined ? { ref: base.ref } : {}),
      // A sha that is not a full commit SHA is kept, for marketplaceProblem to refuse rather than fetch unpinned.
      ...(sha !== undefined ? { sha: sha.toLowerCase() } : {}),
      ...(source.subpath !== undefined ? { subpath: source.subpath.replace(/^\.\//u, '') } : {}),
    }
  }
  if (source.kind === 'npm' && source.package !== undefined) {
    const spec = source.package.startsWith('https://') ? undefined : npmSpec(source.package)
    if (spec === undefined) return undefined
    return { ...spec, ...(spec.version === undefined && source.version !== undefined ? { version: source.version } : {}), ...(source.registry !== undefined ? { registry: source.registry } : {}) }
  }
  if (source.kind === 'archive' && source.url !== undefined && /^https:\/\//iu.test(source.url)) {
    return { kind: 'archive', url: source.url, ...(source.sha256 !== undefined ? { sha256: source.sha256.toLowerCase() } : {}) }
  }
  return undefined
}

/**
 * Why Harness Forge does not fetch what a marketplace entry names, or undefined
 * when it does: a marketplace may not steer Harness Forge to another transport
 * (`ssh`, `file`, `ext::`…) than HTTPS, to an unpinned commit it claims to pin,
 * to a ref git could read as an option, out of the repository, or (for npm) to
 * a spec that is not a registry lookup. Which registry it may name is decided
 * when it is fetched, against the person's configuration.
 */
export function marketplaceProblem(spec: RemoteSpec): string | undefined {
  switch (spec.kind) {
    case 'git': {
      if (gitTransport(spec.url) !== 'https') return `only https git URLs are fetched for a marketplace entry: ${spec.url}`
      try {
        const url = new URL(spec.url)
        if (url.username.length > 0 || url.password.length > 0) return 'a marketplace entry may not carry credentials in its URL'
      } catch {
        return `not a URL: ${spec.url}`
      }
      if (spec.sha !== undefined && !SHA.test(spec.sha)) return `sha is not a full 40-character commit SHA: ${spec.sha}`
      if (spec.ref !== undefined && !isValidRef(spec.ref)) return `not a branch or tag name git accepts: ${spec.ref}`
      if (spec.subpath !== undefined && !isSafeSubpath(spec.subpath)) return `the plugin path leaves its repository: ${spec.subpath}`
      return undefined
    }
    case 'npm':
      if (!NPM_NAME.test(spec.package)) return `not an npm package name: ${spec.package}`
      if (spec.version !== undefined && !isRegistryRange(spec.version)) return `not an npm version or range: ${spec.version}`
      if (spec.registry !== undefined && !/^https:\/\//iu.test(spec.registry)) return `only an https npm registry is used: ${spec.registry}`
      return undefined
    case 'archive':
      if (!/^https:\/\//iu.test(spec.url)) return `only https archives are fetched: ${spec.url}`
      if (spec.sha256 !== undefined && !/^[0-9a-f]{64}$/u.test(spec.sha256)) return `sha256 is not a SHA-256 digest: ${spec.sha256}`
      return undefined
    case 'json':
    case 'local':
      return `a marketplace entry cannot be a ${spec.kind === 'json' ? 'marketplace' : 'local folder'}`
  }
}

/**
 * Why an npm dependency spec is not installed, or undefined when it is a
 * registry lookup (a version, range or tag, or an `npm:name@range` alias).
 * Git, GitHub, `file:`, `link:`, `workspace:` and URL specs are refused: npm
 * fetches them from elsewhere and may run their `prepare` script to build them.
 */
export function dependencyProblem(name: string, spec: string): string | undefined {
  if (isRegistryRange(spec)) return undefined
  const alias = /^npm:((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)(?:@(.*))?$/u.exec(spec)
  if (alias !== null && (alias[2] === undefined || isRegistryRange(alias[2]))) return undefined
  return `${name} is "${spec}": Harness Forge installs dependencies from the npm registry only, not from git, a URL or a local path`
}

/** The source a fetched plugin is known by: what installed status and stored copies are keyed by. */
export function specIdentity(spec: RemoteSpec): string {
  switch (spec.kind) {
    case 'git': return `git:${spec.url}${spec.subpath !== undefined ? `//${stripTrailing(spec.subpath.replace(/\\/gu, '/'), '/')}` : ''}`
    case 'npm': return `npm:${spec.registry ?? ''}:${spec.package}`
    case 'json': return `json:${spec.url}`
    case 'archive': return `archive:${spec.url}`
    case 'local': return `local:${spec.path}`
  }
}

/** One line naming a source for the person: `github.com/owner/repo@ref/path`, a URL, `npm:name@version`. */
export function describeSpec(spec: RemoteSpec): string {
  switch (spec.kind) {
    case 'git': {
      const base = spec.github !== undefined ? `github.com/${spec.github.owner}/${spec.github.repo}` : spec.url
      return `${base}${spec.ref !== undefined ? `#${spec.ref}` : ''}${spec.subpath !== undefined ? ` (${spec.subpath})` : ''}`
    }
    case 'npm': return `npm:${spec.package}${spec.version !== undefined ? `@${spec.version}` : ''}`
    case 'json':
    case 'archive': return spec.url
    case 'local': return spec.path
  }
}

/** The web page of a source, when it has one: what the confirmation links to. */
export function pageOfSpec(spec: RemoteSpec): string | undefined {
  if (spec.kind === 'git' && spec.github !== undefined) {
    const at = spec.sha ?? spec.ref
    return `https://github.com/${spec.github.owner}/${spec.github.repo}${at !== undefined || spec.subpath !== undefined ? `/tree/${at ?? 'HEAD'}${spec.subpath !== undefined ? `/${spec.subpath}` : ''}` : ''}`
  }
  if (spec.kind === 'git' && /^https?:\/\//iu.test(spec.url)) return spec.url.replace(/\.git$/u, '')
  if (spec.kind === 'json' || spec.kind === 'archive') return spec.url
  return undefined
}

/** npm's own registry: the one a marketplace may name besides the person's configured registry. */
export const NPM_REGISTRY = 'https://registry.npmjs.org/'

/** A registry URL with one trailing slash, scheme and host lowercased; undefined when it is not an http(s) URL. */
export function normalizeRegistry(registry: string): string | undefined {
  try {
    const url = new URL(registry.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    return `${url.origin}${stripTrailing(url.pathname, '/')}/`
  } catch {
    return undefined
  }
}

/** The page of an npm package version on the registry it comes from: npmjs.com for npm's own, else the registry's document of it. */
export function npmPage(registry: string, name: string, version: string): string {
  return normalizeRegistry(registry) === NPM_REGISTRY
    ? `https://www.npmjs.com/package/${name}/v/${encodeURIComponent(version)}`
    : `${normalizeRegistry(registry) ?? registry}${name.replace('/', '%2F')}`
}

/** The GitHub archive URL of a ref or commit (`HEAD` for the default branch). */
export function githubTarball(owner: string, repo: string, ref = 'HEAD'): string {
  return `https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeURIComponent(ref).replace(/%2F/gu, '/')}`
}

/** The GitHub API URL that answers a ref's commit SHA as plain text (with `Accept: application/vnd.github.sha`). */
export function githubCommitApi(owner: string, repo: string, ref = 'HEAD'): string {
  return `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`
}
