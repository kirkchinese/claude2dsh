/**
 * Path containment, safe reads and small filesystem helpers. Agent Plugins
 * requires package paths to stay inside the plugin root; connectors reuse the
 * same check before handing a path to a DSH service.
 * @module @kirkchinese/harness-forge-core
 */
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path'

/**
 * The `\\server\share` a Windows path names, when it names one: a UNC path, also as `//server/share` or
 * `\\?\UNC\server\share`. Device paths (`\\.\…`, `\\?\…` other than a drive) count too: none is a plain
 * local file. Undefined for a drive path, and for any path on another platform, where `//` is the root.
 */
export function networkShareOf(path: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== 'win32') return undefined
  const normalized = win32.normalize(path)
  if (/^\\\\\?\\[A-Za-z]:\\/u.test(normalized)) return undefined
  const unc = /^\\\\\?\\UNC\\([^\\]+)\\([^\\]+)/iu.exec(normalized) ?? /^\\\\([^\\?.][^\\]*)\\([^\\]+)/u.exec(normalized)
  if (unc !== null) return `\\\\${(unc[1] ?? '').toLowerCase()}\\${(unc[2] ?? '').toLowerCase()}`
  return normalized.startsWith('\\\\') ? normalized : undefined
}

/**
 * Whether reading `path` would reach a network share or device that `base` is not already on. Windows reads a
 * UNC path over SMB and signs in to that server with the person's credentials, so a path a configuration names
 * must not make it reach a new one.
 */
export function reachesNewShare(path: string, base: string, platform: NodeJS.Platform = process.platform): boolean {
  const share = networkShareOf(path, platform)
  return share !== undefined && share !== networkShareOf(base, platform)
}

/**
 * The most symbolic links one resolution follows: Linux's limit (path_resolution(7): "a maximum of 40 symbolic
 * links"). macOS stops at 32 (`MAXSYMLINKS`) and Windows at 63 reparse points; a chain longer than this is
 * treated as one that cannot be resolved.
 */
export const SYMLINK_HOPS = 40

/** The two calls that read a link without following it: neither opens the link's target. */
export interface LinkReader {
  lstat(path: string): { isSymbolicLink(): boolean }
  readlink(path: string): string
}

/** The system's own link reader. */
export const SYSTEM_LINKS: LinkReader = { lstat: lstatSync, readlink: readlinkSync }

/**
 * Whether resolving `path` would reach a network share or device that `base` is not on (see
 * {@link reachesNewShare}), through the path itself or through any symbolic link or junction on the way,
 * followed within {@link SYMLINK_HOPS}. Only `lstat` and `readlink` are called, and never on a new share, so
 * nothing connects to one; a resolver (realpath, open) may follow the path once this says no. A loop, too many
 * links or a link that cannot be read counts as reaching one. Off Windows there are no shares and no calls.
 */
export function linksReachNewShare(path: string, base: string, platform: NodeJS.Platform = process.platform, links: LinkReader = SYSTEM_LINKS): boolean {
  if (platform !== 'win32') return false
  if (reachesNewShare(path, base, platform)) return true
  const parsed = win32.parse(win32.resolve(path))
  let current = parsed.root
  const parts = win32.resolve(path).slice(parsed.root.length).split(/[\\/]+/u).filter(part => part.length > 0)
  for (let hops = 0; parts.length > 0;) {
    const part = parts.shift() ?? ''
    if (part === '.') continue
    if (part === '..') {
      current = win32.dirname(current)
      continue
    }
    const next = win32.join(current, part)
    let link: boolean
    try {
      link = links.lstat(next).isSymbolicLink()
    } catch (error: unknown) {
      // Nothing there: nothing below it can be a link. Any other failure leaves the path unknown.
      return (error as NodeJS.ErrnoException).code !== 'ENOENT'
    }
    if (!link) {
      current = next
      continue
    }
    if (++hops > SYMLINK_HOPS) return true
    let target: string
    try {
      target = links.readlink(next)
    } catch {
      return true
    }
    const resolved = win32.resolve(current, target)
    if (reachesNewShare(target, base, platform) || reachesNewShare(resolved, base, platform)) return true
    const root = win32.parse(resolved).root
    parts.unshift(...resolved.slice(root.length).split(/[\\/]+/u).filter(segment => segment.length > 0))
    current = root
  }
  return false
}

/** Return true when `candidate` is inside `root` (or equals it). */
export function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Resolve a plugin-relative path and reject escapes. */
export function resolveInside(root: string, path: string): string | undefined {
  const candidate = resolve(root, path)
  return isInside(root, candidate) ? candidate : undefined
}

/** Why a helper below did not read a path {@link leadsToShare} refused. */
export const LEADS_TO_SHARE = 'leads to a network share'

/**
 * Whether reading `path` would take a link to a network share the path is not on: a local path led to any share,
 * or a share's path to another. The one guard every file helper below runs before its first stat, open or
 * realpath, since on Windows touching a share signs in to its server. Off Windows it returns at once
 * (`linksReachNewShare` makes no call there).
 */
export function leadsToShare(path: string, platform: NodeJS.Platform = process.platform): boolean {
  return linksReachNewShare(path, path, platform)
}

/**
 * A path a file's content names (a manifest field, a config entry, an import, a link), resolved against
 * `origin`, the folder of the file it came from; undefined when, on Windows, the value, the resolved path or a
 * link on its way reaches a network share `origin` is not on. Every value read from a file goes through this
 * before the first filesystem call: {@link leadsToShare} checks a path against itself, so a value naming a share
 * outright would pass it. Paths found by walking a folder are the helpers' own concern.
 */
export function contentPath(value: string, origin: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (reachesNewShare(value, origin, platform)) return undefined
  const path = resolve(origin, value)
  return linksReachNewShare(path, origin, platform) ? undefined : path
}

/** Resolve symlinks when the path exists, falling back to the lexical path. */
export function realOrLexical(path: string): string {
  if (leadsToShare(path)) return resolve(path)
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** Return true when a path exists and is a regular file. */
export function isFile(path: string): boolean {
  if (leadsToShare(path)) return false
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Return true when a path exists and is a directory. */
export function isDirectory(path: string): boolean {
  if (leadsToShare(path)) return false
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * List immediate child directories, sorted for determinism. A symbolic link
 * to a directory counts, as harnesses follow linked skill directories.
 */
export function childDirectories(root: string): string[] {
  if (leadsToShare(root)) return []
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(`${root}/${entry.name}`)))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b, 'en'))
  } catch {
    return []
  }
}

/** Read a UTF-8 file, returning undefined instead of throwing. */
export function readText(path: string): string | undefined {
  if (leadsToShare(path)) return undefined
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** Read and parse JSON, returning undefined instead of throwing. */
export function readJson(path: string): unknown {
  const text = readText(path)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/**
 * A file a harness keeps its record in, as read: absent (`{}`: a missing file records nothing, which is a complete
 * read), its object, or why it could not be read. A harness writing it may leave it malformed or cut off for a moment;
 * that must never read as "it records nothing".
 */
export interface RecordRead<T> {
  readonly value?: T
  readonly problem?: string
}

/** Errors that mean the file is not there: nothing recorded. */
const ABSENT = new Set(['ENOENT', 'ENOTDIR'])

/** Read a harness's record file as text: absent, its text, or why it could not be read. */
export function readRecordText(path: string): RecordRead<string> {
  if (leadsToShare(path)) return { problem: `${path} could not be read (${LEADS_TO_SHARE})` }
  try {
    return { value: readFileSync(path, 'utf8') }
  } catch (error: unknown) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && ABSENT.has(code)) return {}
    return { problem: `${path} could not be read (${error instanceof Error ? error.message : String(error)})` }
  }
}

/** Read a harness's JSON object record (see {@link RecordRead}). */
export function readJsonRecord(path: string): RecordRead<Record<string, unknown>> {
  const text = readRecordText(path)
  if (text.value === undefined) return text.problem === undefined ? {} : { problem: text.problem }
  try {
    const value: unknown = JSON.parse(text.value)
    return isPlainObject(value) ? { value } : { problem: `${path} is not a JSON object` }
  } catch (error: unknown) {
    return { problem: `${path} is not valid JSON (${error instanceof Error ? error.message : String(error)})` }
  }
}

/** Parse JSON and require a plain object. */
export function readJsonObject(path: string): Record<string, unknown> | undefined {
  const value = readJson(path)
  return isPlainObject(value) ? value : undefined
}

/** A plain (non-null, non-array) object. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read a string field. */
export function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key]
  return typeof field === 'string' && field.trim().length > 0 ? field : undefined
}

/** Read a string-array field, accepting a single string. */
export function stringArrayField(value: Record<string, unknown>, key: string): string[] {
  const field = value[key]
  if (typeof field === 'string') return [field]
  if (!Array.isArray(field)) return []
  return field.filter((item): item is string => typeof item === 'string')
}

/** Convert a Windows or POSIX path to a stable POSIX display form. */
export function toPosix(path: string): string {
  return path.split(sep).join('/')
}

/** The trailing path segment without an extension. */
export function stem(path: string): string {
  const normalized = path.replace(/\\/gu, '/')
  const name = normalized.slice(normalized.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}
