/**
 * Unpacking what Harness Forge downloads (a GitHub `.tar.gz` when git is
 * missing, a zip `archive` source, an npm tarball) and copying a plugin out of
 * a checkout, with Node alone. Plugins are files and directories: links,
 * hard links, devices and other special entries are refused, every path must
 * stay inside its destination, and what is written is bounded as it is written.
 * Unpacking yields to the event loop as it goes, so the operation's deadline
 * and cancellation interrupt it.
 * @module @kirkchinese/harness-forge
 */
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { Readable, type Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createInflateRaw } from 'node:zlib'
import { HarnessError, isInside } from '@kirkchinese/harness-forge-core'

/** Bounds on what one unpack or copy may write. */
export interface TreeLimits {
  /** Total bytes of file content. */
  readonly maxBytes: number
  /** Files, directories and links together (for a tar, every header record). */
  readonly maxEntries: number
}

/** Claude Code's bounds on a plugin copied into its cache: 256 MiB, 20,000 entries. */
export const PLUGIN_LIMITS: TreeLimits = { maxBytes: 256 * 1024 * 1024, maxEntries: 20_000 }
/** A whole repository unpacked to read its marketplace: larger, since only part of it is a plugin. */
export const REPOSITORY_LIMITS: TreeLimits = { maxBytes: 512 * 1024 * 1024, maxEntries: 100_000 }

/** Options of an unpack. */
export interface UnpackOptions {
  readonly limits?: TreeLimits
  /** Aborting stops the unpack with the signal's reason. */
  readonly signal?: AbortSignal
}

function tooLarge(what: string, limits: TreeLimits): HarnessError {
  return new HarnessError('fetch-failed', `${what} is larger than Harness Forge accepts (${String(Math.round(limits.maxBytes / 1024 / 1024))} MiB or ${String(limits.maxEntries)} files)`)
}

function damaged(kind: string, why: string): HarnessError {
  return new HarnessError('fetch-failed', `the download is not a ${kind} archive Harness Forge can read: ${why}`)
}

function special(name: string): HarnessError {
  return new HarnessError('fetch-failed', `the archive contains a link or special file (${name}); plugins are plain files, so Harness Forge does not unpack it`)
}

/** Stop when cancellation (or the deadline) has fired, with its reason. */
function stopIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason instanceof Error ? signal.reason : new HarnessError('fetch-failed', 'cancelled')
}

/** Let timers (the deadline) and cancellation in, and stop when they fired. */
async function checkpoint(signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolvePromise) => { setImmediate(resolvePromise) })
  stopIfAborted(signal)
}

/** Raised inside {@link decompress} when the output passes its bound. */
class OutputTooLarge extends Error {}

/**
 * Decompress `input` as a stream, chunk by chunk, so cancellation stops it
 * part-way and its output is bounded as it grows.
 * @throws {OutputTooLarge} once more than `maxOutput` bytes come out.
 */
async function decompress(input: Buffer, inflater: Transform, maxOutput: number, signal: AbortSignal | undefined): Promise<Buffer> {
  stopIfAborted(signal)
  const chunks: Buffer[] = []
  let length = 0
  try {
    await pipeline(Readable.from([input]), inflater, async (source: AsyncIterable<Buffer>) => {
      for await (const chunk of source) {
        length += chunk.length
        if (length > maxOutput) throw new OutputTooLarge()
        chunks.push(chunk)
      }
    }, ...(signal !== undefined ? [{ signal }] : []))
  } catch (error: unknown) {
    stopIfAborted(signal)
    throw error
  }
  return Buffer.concat(chunks, length)
}

/** Windows device names, reserved in any folder and with any extension. */
const RESERVED = /^(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\..*)?$/iu

/**
 * Where an archive member goes, or undefined when its name leaves the
 * destination. A name no folder can hold everywhere, or that Windows would
 * read as another, is refused: a `:` (an alternate data stream or a drive),
 * a device name, or a trailing dot or space (which Windows drops).
 */
function memberPath(dest: string, name: string, strip: number): string | undefined {
  const parts = name.replace(/\\/gu, '/').split('/').filter(part => part.length > 0 && part !== '.')
  if (parts.length <= strip) return undefined
  const kept = parts.slice(strip)
  if (kept.some(part => part === '..')) return undefined
  const bad = kept.find(part => part.includes(':') || /[ .]$/u.test(part) || RESERVED.test(part))
  if (bad !== undefined) throw new HarnessError('fetch-failed', `the archive has a name Windows cannot hold (${bad}); Harness Forge does not unpack it`)
  const target = resolve(dest, ...kept)
  return isInside(dest, target) && target !== resolve(dest) ? target : undefined
}

/**
 * How a destination is told apart from others: in Unicode NFC (macOS treats
 * other normalizations of a name as the same file), and case-insensitively
 * where the file system is (macOS, Windows).
 */
export function destinationKey(path: string, platform: NodeJS.Platform = process.platform): string {
  const normal = path.normalize('NFC')
  return platform === 'win32' || platform === 'darwin' ? normal.toLowerCase() : normal
}

/**
 * What one unpack has written: every file and directory (the ones made for
 * a file's parents included) counts toward the entry bound, and no two
 * members may land on the same path.
 */
class Destination {
  private readonly paths = new Map<string, 'file' | 'dir'>()
  entries = 0

  constructor(private readonly root: string, private readonly limits: TreeLimits, private readonly signal: AbortSignal | undefined) {}

  /** Count `n` more entries (records an unpack reads without writing). */
  charge(n = 1): void {
    this.entries += n
    if (this.entries > this.limits.maxEntries) throw tooLarge('the archive', this.limits)
  }

  private claim(path: string, kind: 'file' | 'dir'): boolean {
    const key = destinationKey(path)
    const was = this.paths.get(key)
    if (was !== undefined) {
      if (was === 'dir' && kind === 'dir') return false
      throw new HarnessError('fetch-failed', `the archive has two members for ${relative(this.root, path).replace(/\\/gu, '/')}; Harness Forge does not unpack it`)
    }
    this.paths.set(key, kind)
    this.charge()
    return true
  }

  /** A directory, with its parents. */
  directory(path: string): void {
    const chain: string[] = []
    for (let dir = path; dir !== this.root && isInside(this.root, dir); dir = dirname(dir)) chain.unshift(dir)
    for (const dir of chain) this.claim(dir, 'dir')
    mkdirSync(path, { recursive: true })
  }

  /** A file, with its parents; created, never written over (whatever name the file system takes as the same). */
  file(path: string, data: Buffer, mode: number): void {
    // Nothing more is written once the unpack is cancelled.
    stopIfAborted(this.signal)
    this.directory(dirname(path))
    this.claim(path, 'file')
    try {
      writeFileSync(path, data, { mode, flag: 'wx' })
    } catch (error: unknown) {
      if ((error as { code?: unknown }).code !== 'EEXIST') throw error
      throw new HarnessError('fetch-failed', `the archive has two members for ${relative(this.root, path).replace(/\\/gu, '/')}; Harness Forge does not unpack it`)
    }
  }
}

/** What a tar header field holds, up to its first NUL. */
function field(block: Buffer, start: number, length: number): string {
  const slice = block.subarray(start, start + length)
  const end = slice.indexOf(0)
  return slice.subarray(0, end < 0 ? slice.length : end).toString('utf8')
}

/** A tar size field: octal digits only (no base-256, no sign), else undefined. */
function octal(block: Buffer, start: number, length: number): number | undefined {
  const text = field(block, start, length).trim()
  if (!/^[0-7]{1,12}$/u.test(text)) return text.length === 0 ? 0 : undefined
  return Number.parseInt(text, 8)
}

/** A pax header block's records (`<len> key=value\n`). */
function paxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>()
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    if (space < 0) break
    const length = Number.parseInt(data.subarray(offset, space).toString('utf8'), 10)
    if (!Number.isFinite(length) || length <= 0 || offset + length > data.length) break
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8')
    const equals = record.indexOf('=')
    if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1))
    offset += length
  }
  return records
}

/**
 * Unpack a `.tar.gz` into `dest` (which must not exist yet or be empty).
 * @returns the commit SHA a `git archive` tarball records (GitHub's pax `comment`), when there is one.
 */
export async function extractTarGz(archive: Buffer, dest: string, options: UnpackOptions & { readonly strip?: number } = {}): Promise<{ commit?: string }> {
  const limits = options.limits ?? REPOSITORY_LIMITS
  let tar: Buffer
  try {
    tar = await decompress(archive, createGunzip(), limits.maxBytes + limits.maxEntries * 1024, options.signal)
  } catch (error: unknown) {
    if (error instanceof OutputTooLarge) throw tooLarge('the archive', limits)
    if (error instanceof HarnessError || options.signal?.aborted === true) throw error
    throw new HarnessError('fetch-failed', 'the download is not a valid .tar.gz archive', { cause: error })
  }
  stopIfAborted(options.signal)
  mkdirSync(dest, { recursive: true })
  const root = resolve(dest)
  const out = new Destination(root, limits, options.signal)
  const strip = options.strip ?? 0
  let commit: string | undefined
  let bytes = 0
  let records = 0
  let longName: string | undefined
  let pax = new Map<string, string>()
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    // Every record counts, extension records included: a stream of them is no cheaper to read.
    records += 1
    // Every header record counts, whatever it is or becomes (repeated, skipped, an extension), and so does every output.
    out.charge()
    if (records % 256 === 0) await checkpoint(options.signal)
    const size = octal(header, 124, 12)
    if (size === undefined) throw damaged('tar', 'a member has a malformed size')
    const type = String.fromCharCode(header[156] ?? 0)
    const dataStart = offset + 512
    if (dataStart + size > tar.length) throw damaged('tar', 'it ends inside a member')
    const data = tar.subarray(dataStart, dataStart + size)
    offset = dataStart + Math.ceil(size / 512) * 512
    if (type === 'g') {
      const comment = paxRecords(data).get('comment')
      if (comment !== undefined && /^[0-9a-f]{40}$/u.test(comment)) commit = comment
      continue
    }
    if (type === 'x') {
      pax = paxRecords(data)
      continue
    }
    if (type === 'L') {
      longName = field(data, 0, data.length)
      continue
    }
    const prefix = field(header, 345, 155)
    const name = pax.get('path') ?? longName ?? (prefix.length > 0 ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100))
    pax = new Map()
    longName = undefined
    if (type !== '0' && type !== '\0' && type !== '7' && type !== '5') throw special(name)
    const target = memberPath(root, name, strip)
    if (target === undefined) continue
    if (type === '5') {
      out.directory(target)
      continue
    }
    bytes += data.length
    if (bytes > limits.maxBytes) throw tooLarge('the archive', limits)
    const mode = octal(header, 100, 8) ?? 0o644
    out.file(target, data, (mode & 0o755) | 0o600)
  }
  // A cancelled unpack is not reported done, however short the archive.
  await checkpoint(options.signal)
  return commit === undefined ? {} : { commit }
}

/** Unpack a zip into `dest`: stored and deflated members, without ZIP64. */
export async function extractZip(archive: Buffer, dest: string, options: UnpackOptions = {}): Promise<void> {
  const limits = options.limits ?? PLUGIN_LIMITS
  const invalid = (why: string): HarnessError => damaged('zip', why)
  stopIfAborted(options.signal)
  let end = -1
  for (let index = archive.length - 22; index >= Math.max(0, archive.length - 22 - 65_535); index -= 1) {
    if (archive.readUInt32LE(index) === 0x06054b50) {
      end = index
      break
    }
  }
  if (end < 0) throw invalid('no end of central directory')
  const count = archive.readUInt16LE(end + 10)
  const directoryStart = archive.readUInt32LE(end + 16)
  if (count === 0xffff || directoryStart === 0xffffffff) throw invalid('ZIP64 archives are not supported')
  if (count > limits.maxEntries) throw tooLarge('the archive', limits)
  if (directoryStart > end) throw invalid('a central directory outside the archive')
  mkdirSync(dest, { recursive: true })
  const root = resolve(dest)
  const out = new Destination(root, limits, options.signal)
  /** Byte ranges of the members' local records and data: no two may overlap, nor reach into the central directory. */
  const ranges: Array<readonly [number, number]> = []
  let bytes = 0
  let offset = directoryStart
  for (let index = 0; index < count; index += 1) {
    if (index % 64 === 63) await checkpoint(options.signal)
    if (offset + 46 > end || archive.readUInt32LE(offset) !== 0x02014b50) throw invalid('a damaged central directory')
    const method = archive.readUInt16LE(offset + 10)
    const compressed = archive.readUInt32LE(offset + 20)
    const size = archive.readUInt32LE(offset + 24)
    const nameLength = archive.readUInt16LE(offset + 28)
    const extraLength = archive.readUInt16LE(offset + 30)
    const commentLength = archive.readUInt16LE(offset + 32)
    const mode = archive.readUInt32LE(offset + 38) >>> 16
    const local = archive.readUInt32LE(offset + 42)
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    offset += 46 + nameLength + extraLength + commentLength
    const type = mode & 0o170000
    const directory = name.endsWith('/')
    if (type !== 0 && type !== 0o100000 && !(directory && type === 0o040000)) throw special(name)
    const target = memberPath(root, name, 0)
    if (target === undefined) continue
    if (directory) {
      out.directory(target)
      continue
    }
    if (local + 30 > directoryStart || archive.readUInt32LE(local) !== 0x04034b50) throw invalid('a damaged member header')
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28)
    const stop = start + compressed
    if (stop > directoryStart) throw invalid(`${name} reaches past its data`)
    if (ranges.some(([from, to]) => local < to && from < stop)) throw invalid(`${name} overlaps another member`)
    ranges.push([local, stop])
    const raw = archive.subarray(start, stop)
    let content: Buffer
    if (method === 0) {
      if (compressed !== size) throw invalid(`${name} is stored with two different sizes`)
      content = raw
    } else if (method === 8) {
      try {
        content = await decompress(raw, createInflateRaw(), Math.min(size, limits.maxBytes - bytes), options.signal)
      } catch (error: unknown) {
        if (options.signal?.aborted === true) throw error
        throw bytes + size > limits.maxBytes ? tooLarge('the archive', limits) : invalid(`${name} does not inflate to its size`)
      }
      if (content.length !== size) throw invalid(`${name} does not inflate to its size`)
    } else {
      throw invalid(`compression method ${String(method)}`)
    }
    // What is written counts, whatever the header says.
    bytes += content.length
    if (bytes > limits.maxBytes) throw tooLarge('the archive', limits)
    out.file(target, content, (mode & 0o755) | 0o600)
  }
  await checkpoint(options.signal)
}

/**
 * How a source file is opened: read-only, without following a link, and
 * without waiting. A FIFO or device put in a listed file's place would
 * otherwise block the synchronous open (a FIFO until something writes to it),
 * and with it DSH; non-blocking, it opens at once, and `fstat` then turns it
 * away before anything is read. Neither flag exists on Windows, where
 * `fs.constants` leaves them out: creating links there needs privileges the
 * plugin's folder does not grant, and named pipes live under `\\.\pipe\`,
 * never in a folder.
 */
const SOURCE_FILE_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)

/**
 * Read a regular file without following a link, even one put in its place
 * after it was listed (a folder another program refreshes): undefined when it
 * is not a regular file now. Everything is read from the one descriptor whose
 * type was checked. At most `size` bytes are read, the size its listing gave,
 * so the copy's budget holds while the file grows.
 */
function readPlainFile(path: string, size: number): { data: Buffer; mode: number } | undefined {
  let fd: number
  try {
    fd = openSync(path, SOURCE_FILE_FLAGS)
  } catch (error: unknown) {
    if ((error as { code?: unknown }).code === 'ELOOP') return undefined
    throw error
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) return undefined
    const data = Buffer.alloc(Math.min(size, stat.size))
    let read = 0
    while (read < data.length) {
      const n = readSync(fd, data, read, data.length - read, read)
      if (n === 0) break
      read += n
    }
    return { data: data.subarray(0, read), mode: stat.mode }
  } finally {
    closeSync(fd)
  }
}

/**
 * Copy a plugin directory to `dest`, leaving out `.git` and every link (a
 * link is not followed, so nothing outside the checkout is read). The
 * directory itself must be a real directory inside `boundary`, reached through
 * no link, and so must every directory under it when it is read. Returns the
 * links and anything else that is not a regular file (a FIFO, a device) left
 * out. Used for every source, a folder on this computer included, so what is
 * shown and installed is this copy.
 *
 * A parent directory replaced by a link between a directory's real-path check
 * and the open of a file in it is not caught: that takes a process running
 * now, on this computer, with write access to the user's own folders, which
 * could as well change the plugin's files before they are listed.
 */
export function copyTree(source: string, dest: string, boundary: string = source, limits: TreeLimits = PLUGIN_LIMITS): string[] {
  const top = lstatSync(source)
  if (top.isSymbolicLink() || !top.isDirectory()) throw new HarnessError('path-escape', `the plugin directory is a link or not a directory: ${relative(boundary, source) || '.'}`)
  // Through no link: its real path sits where its path says, inside the checkout.
  const real = realpathSync(source)
  const realBoundary = realpathSync(boundary)
  if ((real !== realBoundary && !isInside(realBoundary, real)) || relative(realBoundary, real) !== relative(resolve(boundary), resolve(source))) {
    throw new HarnessError('path-escape', `the plugin directory is reached through a link: ${relative(boundary, source) || '.'}`)
  }
  let bytes = 0
  let entries = 0
  const skipped: string[] = []
  const visit = (from: string, realFrom: string, to: string): void => {
    // Still where it was listed, not a link swapped in since.
    if (realpathSync(from) !== realFrom) throw new HarnessError('path-escape', `the plugin folder changed into a link while it was copied: ${relative(source, from) || '.'}`)
    mkdirSync(to, { recursive: true })
    for (const name of readdirSync(from)) {
      if (name === '.git') continue
      const path = join(from, name)
      const relativePath = relative(source, path).replace(/\\/gu, '/')
      entries += 1
      if (entries > limits.maxEntries) throw tooLarge('the plugin', limits)
      const stat = lstatSync(path)
      if (stat.isDirectory()) {
        visit(path, join(realFrom, name), join(to, name))
        continue
      }
      if (stat.isFile() && bytes + stat.size > limits.maxBytes) throw tooLarge('the plugin', limits)
      const file = stat.isFile() ? readPlainFile(path, stat.size) : undefined
      if (file === undefined) {
        skipped.push(relativePath)
        continue
      }
      bytes += file.data.length
      if (bytes > limits.maxBytes) throw tooLarge('the plugin', limits)
      writeFileSync(join(to, name), file.data, { mode: file.mode & 0o777, flag: 'wx' })
    }
  }
  visit(source, real, dest)
  return skipped
}

/**
 * A SHA-256 over a directory or file as installed: every path (sorted), its
 * type, whether it is executable, a file's bytes and a link's target. Equal
 * digests are the same files; what a confirmation showed is bound to one.
 */
export function treeDigest(path: string): string {
  const hash = createHash('sha256')
  const visit = (absolute: string, relativePath: string): void => {
    const stat = lstatSync(absolute)
    if (stat.isSymbolicLink()) {
      hash.update(`L\0${relativePath}\0${readlinkSync(absolute)}\0`)
    } else if (stat.isDirectory()) {
      hash.update(`D\0${relativePath}\0`)
      for (const name of readdirSync(absolute).sort()) visit(join(absolute, name), relativePath.length > 0 ? `${relativePath}/${name}` : name)
    } else if (stat.isFile()) {
      hash.update(`F\0${relativePath}\0${(stat.mode & 0o111) !== 0 ? 'x' : '-'}\0${String(stat.size)}\0`)
      hash.update(readFileSync(absolute))
      hash.update('\0')
    }
  }
  visit(path, '')
  return hash.digest('hex')
}

/** The files that say what a plugin or marketplace is: read before the plugin is copied, so never through a link. */
const MANIFESTS = [
  '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', '.codex-plugin/plugin.json', '.agents/plugins/marketplace.json',
  'plugin.json', 'package.json', 'opencode.json', 'opencode.jsonc', 'hooks/hooks.json', '.mcp.json',
] as const

/** Refuse a checkout directory whose manifests (or the folders holding them) are links. */
export function refuseLinkedManifests(dir: string): void {
  for (const manifest of MANIFESTS) {
    let path = dir
    for (const part of manifest.split('/')) {
      path = join(path, part)
      let link: boolean
      try {
        link = lstatSync(path).isSymbolicLink()
      } catch {
        break
      }
      if (link) throw new HarnessError('path-escape', `${relative(dir, path).replace(/\\/gu, '/')} is a link; Harness Forge does not follow links in what it fetches`)
    }
  }
}

/** Bytes and entries under a directory (`.git` included), stopping once past the limits. */
export function treeSize(directory: string, limits: TreeLimits): { bytes: number; entries: number; over: boolean } {
  let bytes = 0
  let entries = 0
  const stack = [directory]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const path = join(dir, name)
      let stat
      try {
        stat = lstatSync(path)
      } catch {
        // Renamed or deleted while git or npm writes: counted on the next look.
        continue
      }
      entries += 1
      if (stat.isDirectory()) stack.push(path)
      else bytes += stat.size
      if (bytes > limits.maxBytes || entries > limits.maxEntries) return { bytes, entries, over: true }
    }
  }
  return { bytes, entries, over: false }
}

/** The single top-level directory of an unpacked zip ("the plugin root may be at the top of the zip or one directory down"). */
export function zipRoot(directory: string): string {
  const children = readdirSync(directory).filter(name => !name.startsWith('__MACOSX'))
  if (children.length !== 1) return directory
  const only = join(directory, children[0]!)
  return lstatSync(only).isDirectory() ? only : directory
}
