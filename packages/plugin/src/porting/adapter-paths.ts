/**
 * The `paths` check of `harness_verify_port`: the commonest way a generated
 * adapter breaks the brief's data access rules, read from its source. It
 * finds a DSH home written into the code (`~/.dsh`, `/home/<user>/.dsh`) and
 * a listing of a `profiles` directory. Comments are skipped, so a source that
 * documents the default `~/.dsh` beside `$DSH_HOME` passes; resolving the
 * running profile as `join(home, 'profiles', name)` passes too, since only a
 * listing reads other profiles.
 * @module @kirkchinese/harness-forge/porting
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'

/** Source files an adapter runs: JavaScript and TypeScript, as written and as built. */
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx'])
/** Directories that hold others' code or history, not the adapter's. */
const SKIPPED_DIRS = new Set(['node_modules', '.git'])
/** Most source files read: an adapter is a small package, and a link to a large tree must not stall the tool. */
const FILE_LIMIT = 500
/** Largest source file read, in bytes: bigger ones are bundles whose findings would be a dependency's. */
const SIZE_LIMIT = 1_000_000
/** Most findings named in the check's detail; the rest are counted. */
const SHOWN_LIMIT = 8

/** A DSH home written into the code: `~/.dsh`, or an absolute user home's `.dsh` on Linux, macOS or Windows. */
const HARD_CODED_HOME = /~[/\\]\.dsh\b|(?:\/home|\/Users|[A-Za-z]:[/\\]{1,2}Users)[/\\]{1,2}[^/\\'"`\s]+[/\\]{1,2}\.dsh\b/u
/** A directory listing whose argument names `profiles`: a path literal or a variable named for them. */
const PROFILES_LISTING = /\b(?:readdir|readdirSync|opendir|opendirSync|glob|globSync)\s*\([^;\n]*(?:['"`/\\]profiles\b|\w*profiles\w*)/iu

/** One place the source breaks a rule. */
export interface PathFinding {
  /** File relative to the adapter directory, with `/`. */
  readonly file: string
  readonly line: number
  readonly what: string
}

/** The source with comments blanked out (newlines kept), so findings name real code lines. */
export function withoutComments(source: string): string {
  let out = ''
  let quote: string | undefined
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!
    const next = source[index + 1]
    if (quote !== undefined) {
      out += char
      if (char === '\\') { out += next ?? ''; index++ } else if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; out += char; continue }
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index++
      out += '\n'
      continue
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2)
      const stop = end === -1 ? source.length : end + 2
      out += source.slice(index, stop).replace(/[^\n]/gu, ' ')
      index = stop - 1
      continue
    }
    out += char
  }
  return out
}

function sourcesUnder(dir: string, out: string[]): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= FILE_LIMIT) return
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) sourcesUnder(path, out)
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
      out.push(path)
    }
  }
}

/** Where an adapter's source hard-codes the DSH home or lists the profiles. */
export function hardCodedPaths(dir: string): PathFinding[] {
  const files: string[] = []
  sourcesUnder(dir, files)
  const findings: PathFinding[] = []
  for (const path of files) {
    let text: string
    try {
      if (statSync(path).size > SIZE_LIMIT) continue
      text = withoutComments(readFileSync(path, 'utf8'))
    } catch {
      continue
    }
    const file = relative(dir, path).split(sep).join('/')
    text.split('\n').forEach((line, index) => {
      const home = HARD_CODED_HOME.exec(line)
      if (home !== null) findings.push({ file, line: index + 1, what: `hard-codes the DSH home (${home[0]})` })
      if (PROFILES_LISTING.test(line)) findings.push({ file, line: index + 1, what: 'lists the profiles directory' })
    })
  }
  return findings
}

/** The check's detail for its findings. */
export function pathsDetail(findings: readonly PathFinding[]): string {
  if (findings.length === 0) return 'the source resolves DSH paths at run time: no hard-coded DSH home and no listing of profiles'
  const shown = findings.slice(0, SHOWN_LIMIT).map(item => `${item.file}:${item.line} ${item.what}`)
  const more = findings.length > SHOWN_LIMIT ? `; and ${findings.length - SHOWN_LIMIT} more` : ''
  return `${shown.join('; ')}${more}. Resolve the DSH home at run time from $DSH_HOME (default ~/.dsh under os.homedir()) and the profile from profileContext or $DSH_PROFILE_DIR; never read or list other profiles (the brief's data access rules)`
}
