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
 * @module @kirkchinese/harness-forge-core
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { claudeExternalImportsApproved, workspaceRootOf } from './trust.js'

/** How deep `@path` imports nest (Claude Code's limit). */
export const MAX_IMPORT_DEPTH = 5

/** The default cap on the text one rendering carries. */
export const DEFAULT_INSTRUCTION_BYTES = 65_536

/** A source file larger than this is not read. */
const MAX_SOURCE_BYTES = 1_048_576

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
  /** Files that exist but were not used, with the reason. */
  readonly skipped: readonly { readonly path: string; readonly reason: string }[]
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

function readSource(path: string): string | undefined {
  try {
    if (statSync(path).size > MAX_SOURCE_BYTES) return undefined
    const text = readFileSync(path, 'utf8')
    return text.includes('\0') ? undefined : text
  } catch {
    return undefined
  }
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
  const seen = new Set<string>()
  const external = claudeExternalImportsApproved(workspaceRootOf(cwd), home)
  const allowedFor = (trusted: boolean, path: string): boolean => trusted || external || within(workspace, path)

  const visit = (path: string, source: Source, depth: number, importedBy: string | undefined, kind: InstructionKind): void => {
    const real = realPath(path)
    if (!isFileAt(path)) return
    if (importedBy === undefined && source.within !== undefined && !within(source.within, real)) {
      skipped.push({ path, reason: 'a link to a file outside the workspace' })
      return
    }
    if (seen.has(real)) return
    seen.add(real)
    if (importedBy !== undefined && !allowedFor(source.trusted, real)) {
      skipped.push({ path, reason: 'an import outside the workspace' })
      return
    }
    const content = readSource(path)
    if (content === undefined) {
      skipped.push({ path, reason: 'unreadable, binary, or larger than 1 MiB' })
      return
    }
    const bytes = Buffer.byteLength(content)
    if (source.hostLoaded && importedBy === undefined) hostFiles.push({ path, bytes })
    else if (content.trim().length > 0) files.push({ path, kind, content, bytes, ...(importedBy !== undefined ? { importedBy } : {}) })
    if (!source.imports) return
    if (depth >= MAX_IMPORT_DEPTH) {
      if (importPaths(content).length > 0) skipped.push({ path, reason: `imports nest deeper than ${String(MAX_IMPORT_DEPTH)} levels` })
      return
    }
    for (const reference of importPaths(content)) {
      if (reference.startsWith('~') && !reference.startsWith('~/')) continue
      // "see @notes.md." names notes.md: a trailing sentence mark is not part of the path unless the file has it.
      const target = [reference, reference.replace(/[.,;:!?)\]]+$/u, '')]
        .filter(candidate => candidate.length > 0)
        .map(candidate => candidate.startsWith('~/') ? join(home, candidate.slice(2)) : resolve(dirname(path), candidate))
        .find(isFileAt)
      if (target !== undefined) visit(target, source, depth + 1, path, 'import')
    }
  }
  for (const source of sources) visit(source.path, source, 0, undefined, source.kind)
  return { files, hostFiles, skipped, root }
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
 */
export function renderInstructions(files: readonly InstructionFile[], maxBytes = DEFAULT_INSTRUCTION_BYTES): RenderedInstructions {
  if (files.length === 0) return { text: '', included: [], omitted: [], truncated: [] }
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
    text: `${PREAMBLE}\n\n${kept.map(item => item.text).join('\n\n')}${note}`,
    included: kept.map(item => ({ path: item.file.path, bytes: item.file.bytes })),
    omitted,
    truncated,
  }
}
