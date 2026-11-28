/**
 * The instruction files of Claude Code (and Codex's global one), found and
 * read the way those harnesses do, for the part DSH's own instruction loader
 * (`@deepseek-ai/dsh-agent-instructions`) does not cover:
 *
 * - `~/.claude/CLAUDE.md` (user), `CLAUDE.md`, `.claude/CLAUDE.md` and
 *   `CLAUDE.local.md` of every directory from the repository root down to the
 *   working directory (the nearest `.git` marks the root; without one, up to the
 *   home directory when the working directory is inside it, else the working
 *   directory alone), and Codex's `~/.codex/AGENTS.override.md` / `AGENTS.md`;
 * - `@path` imports of the Claude Code files: relative to the importing file,
 *   `~/`-relative or absolute, at most {@link MAX_IMPORT_DEPTH} levels deep, each
 *   file once, and never inside a code fence or an inline code span.
 *
 * A file the host injects verbatim (`hostLoads`: DSH reads `CLAUDE.md` and
 * `CLAUDE.local.md` from its project root to the working directory) is not
 * returned, but its imports are: DSH leaves `@path` lines as they are.
 *
 * Finding files and trusting their imports are separate: files are found from
 * the repository root (or up to the home directory) down, but a project file
 * (any `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md`) imports only from
 * inside the workspace: the repository root, else the working directory, both
 * with symbolic links resolved. A cloned repository's `CLAUDE.md` must not be
 * able to pull `~/.ssh/id_rsa` or another project's files into a prompt. The
 * exception is a workspace whose external imports the person approved in
 * Claude Code (`projects[<workspace>].hasClaudeMdExternalIncludesApproved`).
 * A project file that is a symbolic link resolving outside the workspace is
 * skipped as well. Files the user wrote themselves (`~/.claude/CLAUDE.md`, `~/.codex`) may
 * import from anywhere.
 *
 * Each file is opened once, and what is checked is what is read: the
 * containment check uses the opened file's own real path (see `openFile`),
 * and the content comes from that descriptor. Reading runs for every
 * workspace, trusted or not, so one load reads at most
 * {@link INSTRUCTION_READ_BYTES} bytes (a binary file's included) while trying
 * at most {@link INSTRUCTION_PATHS_TRIED} paths (a missing one included), and
 * lists at most {@link INSTRUCTION_SKIPS_LISTED} files it did not use; past a
 * limit it stops, says so (`stopped`) and touches the filesystem no more.
 * @module @kirkchinese/harness-forge-core
 */
import { closeSync, constants, existsSync, fstatSync, openSync, readlinkSync, readSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { claudeExternalImportsApproved, workspaceRootOf } from './trust.js'
import { linksReachNewShare, reachesNewShare } from './paths.js'
import { stripTrailing } from './text.js'

/** How deep `@path` imports nest (Claude Code's limit). */
export const MAX_IMPORT_DEPTH = 5

/** The default cap on the text one rendering carries. */
export const DEFAULT_INSTRUCTION_BYTES = 65_536

/** A source file larger than this is not read. */
const MAX_SOURCE_BYTES = 1_048_576

/**
 * The bytes one load reads from all its files together: a rendering keeps at
 * most {@link DEFAULT_INSTRUCTION_BYTES} (64 KiB), so 4 MiB leaves room for
 * four maximal files or hundreds of ordinary ones, while a cloned repository
 * full of permitted imports cannot make each session start read gigabytes.
 */
export const INSTRUCTION_READ_BYTES = 4 * 1_048_576

/**
 * The paths one load tries: every candidate path costs one, whether it is
 * missing, refused, binary or read. Real setups try a few paths per directory
 * and a handful of imports; 256 is far beyond that, and bounds the filesystem
 * work a crafted import graph (thousands of missing imports included) can
 * cause on every prompt.
 */
export const INSTRUCTION_PATHS_TRIED = 256

/**
 * The unused files one load lists with their reasons (`skipped`); the rest are
 * only counted (`skippedUnlisted`). 32 names every problem a real setup has
 * and keeps the diagnostics small when a crafted file imports thousands.
 */
export const INSTRUCTION_SKIPS_LISTED = 32

export type InstructionKind = 'user' | 'codex' | 'project' | 'local' | 'import'

/** One instruction file to add to a prompt. */
export interface InstructionFile {
  readonly path: string
  readonly kind: InstructionKind
  readonly content: string
  /** The size of the file's text in UTF-8 bytes. */
  readonly bytes: number
  /** The file that imported this one. */
  readonly importedBy?: string
}

export interface InstructionOptions {
  readonly cwd: string
  readonly home: string
  /** Codex's home (`$CODEX_HOME`); its global instructions are read when given. */
  readonly codexHome?: string
  /** Names of the files the host already injects verbatim, in its project root's directories down to `cwd`. */
  readonly hostLoads?: readonly string[]
  /** Skip the Codex global file (another part of Harness Forge mounts it). */
  readonly skipCodex?: boolean
}

export interface InstructionSet {
  /** The files to inject, broad to specific (later ones take precedence). */
  readonly files: readonly InstructionFile[]
  /** Files the host injects itself; read only for their imports. */
  readonly hostFiles: readonly { readonly path: string; readonly bytes: number }[]
  /** Files that exist but were not used, with the reason: at most {@link INSTRUCTION_SKIPS_LISTED}. */
  readonly skipped: readonly { readonly path: string; readonly reason: string }[]
  /** How many more files were not used than `skipped` lists. */
  readonly skippedUnlisted: number
  /** Set when reading stopped at a limit: a note saying so, for the prompt and the workbench. */
  readonly stopped?: string
  /** The directory the project's files are read down from. */
  readonly root: string
}

interface Source {
  readonly path: string
  readonly kind: Exclude<InstructionKind, 'import'>
  readonly hostLoaded: boolean
  readonly imports: boolean
  /** Imports may come from anywhere: the user wrote the file. */
  readonly trusted: boolean
  /** A project file must resolve inside this directory (a symbolic link may not lead out of the project). */
  readonly within?: string
}

function isFileAt(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Whether `path` is `parent` or inside it. */
function within(parent: string, path: string): boolean {
  const rel = relative(parent, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** The nearest directory from `cwd` up that holds a `.git`. */
export function findRepositoryRoot(cwd: string): string | undefined {
  for (let current = resolve(cwd); ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return current
    if (dirname(current) === current) return undefined
  }
}

/** The directories whose files apply to `cwd`, broad to specific. */
export function instructionDirectories(cwd: string, home: string): { readonly directories: string[]; readonly repository: string | undefined } {
  const start = resolve(cwd)
  const repository = findRepositoryRoot(start)
  const stop = repository ?? (within(resolve(home), start) ? resolve(home) : start)
  const directories: string[] = []
  for (let current = start; ; current = dirname(current)) {
    directories.unshift(current)
    if (current === stop || dirname(current) === current) break
  }
  return { directories, repository }
}

/** `text` with fenced code blocks and inline code spans blanked, so an `@name` inside them is not an import. */
function withoutCode(text: string): string {
  const lines: string[] = []
  let fence: { readonly char: string; readonly length: number } | undefined
  for (const line of text.split(/\r?\n/u)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1]
    if (fence !== undefined) {
      if (marker !== undefined && marker[0] === fence.char && marker.length >= fence.length && line.trim() === marker) fence = undefined
      lines.push('')
    } else if (marker !== undefined) {
      fence = { char: marker[0]!, length: marker.length }
      lines.push('')
    } else {
      lines.push(line.replace(/`[^`\n]*`/gu, ''))
    }
  }
  return lines.join('\n')
}

/** The `@path` references of a Claude Code file, in order of appearance. */
export function importPaths(text: string): string[] {
  const found: string[] = []
  for (const match of withoutCode(text).matchAll(/(?:^|\s)@((?:[^\s\\]|\\ )+)/gu)) {
    const raw = match[1]!.replaceAll('\\ ', ' ')
    const withoutFragment = raw.includes('#') ? raw.slice(0, raw.indexOf('#')) : raw
    if (withoutFragment.length > 0) found.push(withoutFragment)
  }
  return found
}

/** An open regular file: its descriptor, its real path, its identity and its size. */
interface OpenFile {
  readonly fd: number
  readonly real: string
  readonly identity: string
  readonly size: number
}

/** `O_NOFOLLOW` where the platform has it (not Windows): the last part of the path must not be a link. */
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0
/** `O_NONBLOCK` where the platform has it: a FIFO swapped in after the check does not hold the open. */
const NO_BLOCK = constants.O_NONBLOCK ?? 0

/**
 * Open the regular file `path` resolves to, once: the real path is opened
 * without following a link in its last part, and the real path reported is
 * the opened file's own (Linux: `/proc/self/fd`; elsewhere the real path,
 * accepted only if it still names the file opened, by device and inode).
 * Undefined when there is no such file, or it changed while being opened.
 *
 * Residual risk without `/proc` (macOS, Windows): the real path and the
 * identity check are separate path operations, so a local process running at
 * the same time that swaps a parent directory for a link between them could
 * make a file outside the allowed place pass as the one inside it. Failing
 * closed there would stop instruction files from loading on those systems, so
 * the gap is documented (docs/user/compatibility.md, next to the hook input
 * file note) instead.
 */
function openFile(path: string): OpenFile | undefined {
  let fd: number
  try {
    const resolved = realpathSync(path)
    if (!statSync(resolved).isFile()) return undefined
    fd = openSync(resolved, constants.O_RDONLY | NO_FOLLOW | NO_BLOCK)
  } catch {
    return undefined
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Error('not a regular file')
    const identity = `${String(stat.dev)}:${String(stat.ino)}`
    let real: string
    try {
      real = readlinkSync(`/proc/self/fd/${String(fd)}`)
    } catch {
      real = realpathSync(path)
      const named = statSync(real)
      if (`${String(named.dev)}:${String(named.ino)}` !== identity) throw new Error('the file changed while it was opened')
    }
    return { fd, real, identity, size: stat.size }
  } catch {
    closeSync(fd)
    return undefined
  }
}

/**
 * Up to `limit` bytes of an open file: the bytes read, whatever they were,
 * and the text, undefined when it is binary or longer than `limit`.
 */
function readOpen(file: OpenFile, limit: number): { text: string | undefined; bytes: number } {
  const buffer = Buffer.alloc(Math.min(file.size, limit) + 1)
  let length = 0
  for (;;) {
    const count = readSync(file.fd, buffer, length, buffer.length - length, length)
    if (count === 0) break
    length += count
    if (length === buffer.length) return { text: undefined, bytes: length }
  }
  const text = buffer.subarray(0, length).toString('utf8')
  return { text: text.includes('\0') ? undefined : text, bytes: length }
}

function realPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** Find and read the instruction files that apply to a working directory. */
export function loadInstructions(options: InstructionOptions): InstructionSet {
  const home = resolve(options.home)
  const cwd = resolve(options.cwd)
  const { directories, repository } = instructionDirectories(cwd, home)
  const root = directories[0] ?? cwd
  // DSH's project root: the repository, else the working directory itself.
  const hostRoot = repository ?? cwd
  const hostNames = new Set(options.hostLoads ?? [])

  // A project file imports from inside the workspace only (unless the person approved external imports in Claude Code).
  const workspace = realPath(repository ?? cwd)
  const sources: Source[] = []
  if (options.codexHome !== undefined && options.skipCodex !== true) {
    const codex = [join(options.codexHome, 'AGENTS.override.md'), join(options.codexHome, 'AGENTS.md')].find(isFileAt)
    if (codex !== undefined) sources.push({ path: codex, kind: 'codex', hostLoaded: false, imports: false, trusted: true })
  }
  sources.push({ path: join(home, '.claude', 'CLAUDE.md'), kind: 'user', hostLoaded: false, imports: true, trusted: true })
  for (const directory of directories) {
    const hosted = within(hostRoot, directory)
    // A file found above the workspace (no repository, up to the home directory) must stay inside its own directory.
    const real = realPath(directory)
    const inside = within(workspace, real) ? workspace : real
    for (const [parts, kind] of [[['CLAUDE.md'], 'project'], [['.claude', 'CLAUDE.md'], 'project'], [['CLAUDE.local.md'], 'local']] as const) {
      const name = parts.at(-1)!
      sources.push({ path: join(directory, ...parts), kind, hostLoaded: parts.length === 1 && hosted && hostNames.has(name), imports: true, trusted: false, within: inside })
    }
  }

  const files: InstructionFile[] = []
  const hostFiles: { path: string; bytes: number }[] = []
  const skipped: { path: string; reason: string }[] = []
  let skippedUnlisted = 0
  const skip = (path: string, reason: string): void => {
    if (skipped.length < INSTRUCTION_SKIPS_LISTED) skipped.push({ path, reason })
    else skippedUnlisted++
  }
  const seen = new Set<string>()
  const external = claudeExternalImportsApproved(workspaceRootOf(cwd), home)
  const allowedFor = (trusted: boolean, path: string): boolean => trusted || external || within(workspace, path)
  let tried = 0
  let read = 0
  let stopped: string | undefined
  const stop = (limit: string, path: string): void => {
    stopped = `Harness Forge stopped reading instruction files at ${path}: ${limit}. Files after it, and their imports, were not read.`
  }
  /** Charge one path about to be tried; false, before any filesystem work, once the budget is spent. */
  const attempt = (path: string): boolean => {
    if (stopped !== undefined) return false
    if (tried >= INSTRUCTION_PATHS_TRIED) {
      stop(`more than ${String(INSTRUCTION_PATHS_TRIED)} paths tried`, path)
      return false
    }
    tried++
    return true
  }

  /** Whether a file at its real path may be used: a source must stay where it was found, an import inside the workspace. */
  const refusal = (real: string, source: Source, importedBy: string | undefined): string | undefined => {
    if (importedBy === undefined && source.within !== undefined && !within(source.within, real)) return 'a link to a file outside the workspace'
    if (importedBy !== undefined && !allowedFor(source.trusted, real)) return 'an import outside the workspace'
    return undefined
  }

  /** Use the first of `candidates` that is a file; each one tried is charged, missing or not. */
  /**
   * Whether a project file's path, or a link on its way, leads to a network share the workspace is not on: on
   * Windows, touching it would sign in to that server, so nothing is opened, resolved or even stat'ed there
   * (`linksReachNewShare` reads links with `lstat` and `readlink` only). The user's own files are theirs to point
   * anywhere.
   */
  const offShare = (path: string, source: Source): boolean => !source.trusted && linksReachNewShare(path, workspace)
  const visit = (candidates: readonly string[], source: Source, depth: number, importedBy: string | undefined, kind: InstructionKind): void => {
    let path: string | undefined
    for (const candidate of candidates) {
      if (!attempt(candidate)) return
      if (offShare(candidate, source)) {
        skip(candidate, importedBy === undefined ? 'a link to a file outside the workspace' : 'an import outside the workspace')
        return
      }
      if (isFileAt(candidate)) {
        path = candidate
        break
      }
    }
    if (path === undefined) return
    // Refuse what is plainly out of bounds before opening it; the opened file is checked again below.
    const before = refusal(realPath(path), source, importedBy)
    if (before !== undefined) {
      skip(path, before)
      return
    }
    const file = openFile(path)
    if (file === undefined) return
    let content: string
    try {
      const after = refusal(file.real, source, importedBy)
      if (after !== undefined) {
        skip(path, after)
        return
      }
      if (seen.has(file.identity)) return
      seen.add(file.identity)
      if (file.size > MAX_SOURCE_BYTES) {
        skip(path, 'unreadable, binary, or larger than 1 MiB')
        return
      }
      if (read + file.size > INSTRUCTION_READ_BYTES) {
        stop(`more than ${String(INSTRUCTION_READ_BYTES)} bytes in all`, path)
        return
      }
      const text = readOpen(file, Math.min(MAX_SOURCE_BYTES, INSTRUCTION_READ_BYTES - read))
      // What was read counts, text or not.
      read += text.bytes
      if (text.text === undefined) {
        skip(path, 'unreadable, binary, or larger than 1 MiB')
        return
      }
      content = text.text
    } finally {
      closeSync(file.fd)
    }
    const bytes = Buffer.byteLength(content)
    if (source.hostLoaded && importedBy === undefined) hostFiles.push({ path, bytes })
    else if (content.trim().length > 0) files.push({ path, kind, content, bytes, ...(importedBy !== undefined ? { importedBy } : {}) })
    if (!source.imports) return
    if (depth >= MAX_IMPORT_DEPTH) {
      if (importPaths(content).length > 0) skip(path, `imports nest deeper than ${String(MAX_IMPORT_DEPTH)} levels`)
      return
    }
    for (const reference of importPaths(content)) {
      if (stopped !== undefined) return
      if (reference.startsWith('~') && !reference.startsWith('~/')) continue
      // A share named as written (`//server/share/x`, `\\\\server\\share\\x`): refused before it is resolved or touched.
      if (!source.trusted && reachesNewShare(reference, workspace)) {
        skip(reference, 'an import outside the workspace')
        continue
      }
      // "see @notes.md." names notes.md: a trailing sentence mark is not part of the path unless the file has it.
      const candidates = [...new Set([reference, stripTrailing(reference, '.,;:!?)]')])]
        .filter(candidate => candidate.length > 0)
        .map(candidate => candidate.startsWith('~/') ? join(home, candidate.slice(2)) : resolve(dirname(path), candidate))
      visit(candidates, source, depth + 1, path, 'import')
    }
  }
  for (const source of sources) visit([source.path], source, 0, undefined, source.kind)
  return { files, hostFiles, skipped, skippedUnlisted, root, ...(stopped !== undefined ? { stopped } : {}) }
}

const DESCRIPTIONS: Record<InstructionKind, string> = {
  user: "user's private global instructions for all projects",
  codex: 'Codex global instructions',
  project: 'project instructions, checked into the codebase',
  local: "user's private project instructions, not checked in",
  import: 'imported instructions',
}

export interface RenderedInstructions {
  /** The prompt text; empty when there is nothing to add. */
  readonly text: string
  readonly included: readonly { readonly path: string; readonly bytes: number }[]
  readonly omitted: readonly string[]
  readonly truncated: readonly string[]
}

const PREAMBLE = 'The following instruction files apply to this work. Follow them; a later file is more specific than an earlier one and takes precedence over it. They do not override the system prompt or what the user asks directly.'

/** Cut `text` to `bytes` UTF-8 bytes without splitting a character. */
function cut(text: string, bytes: number): string {
  const slice = Buffer.from(text).subarray(0, Math.max(0, bytes)).toString('utf8')
  return slice.endsWith('\uFFFD') ? slice.slice(0, -1) : slice
}

/**
 * Frame the files as prompt text under a byte budget. When they do not fit, the
 * broadest files are left out first and the last one is cut; a note names both.
 * @param stopped - the note of a load that stopped at a limit (`InstructionSet.stopped`), added at the end.
 */
export function renderInstructions(files: readonly InstructionFile[], maxBytes = DEFAULT_INSTRUCTION_BYTES, stopped?: string): RenderedInstructions {
  if (files.length === 0) return { text: stopped === undefined ? '' : `[${stopped}]`, included: [], omitted: [], truncated: [] }
  const block = (file: InstructionFile, content: string): string => {
    const label = file.kind === 'import' ? `imported by ${file.importedBy ?? 'an instruction file'}` : DESCRIPTIONS[file.kind]
    return `Contents of ${file.path} (${label}):\n\n${content.trim()}`
  }
  const size = (text: string): number => Buffer.byteLength(text)
  const blocks = files.map(file => ({ file, text: block(file, file.content) }))
  let start = 0
  let total = size(PREAMBLE) + blocks.reduce((sum, item) => sum + size(item.text) + 2, 0)
  while (total > maxBytes && start < blocks.length - 1) total -= size(blocks[start++]!.text) + 2
  const kept = blocks.slice(start)
  const omitted = blocks.slice(0, start).map(item => item.file.path)
  const truncated: string[] = []
  const last = kept.at(-1)
  if (last !== undefined && total > maxBytes) {
    const overhead = total - size(last.text)
    const room = Math.max(0, maxBytes - overhead - 200)
    const header = block(last.file, '').trimEnd()
    last.text = `${block(last.file, cut(last.file.content, Math.max(0, room - size(header))))}\n\n[truncated]`
    truncated.push(last.file.path)
  }
  const note = omitted.length + truncated.length === 0
    ? ''
    : `\n\n[Harness Forge: the instruction files exceed ${String(maxBytes)} bytes; ${omitted.length > 0 ? `left out: ${omitted.join(', ')}` : ''}${omitted.length > 0 && truncated.length > 0 ? '; ' : ''}${truncated.length > 0 ? `cut: ${truncated.join(', ')}` : ''}.]`
  return {
    text: `${PREAMBLE}\n\n${kept.map(item => item.text).join('\n\n')}${note}${stopped === undefined ? '' : `\n\n[${stopped}]`}`,
    included: kept.map(item => ({ path: item.file.path, bytes: item.file.bytes })),
    omitted,
    truncated,
  }
}
