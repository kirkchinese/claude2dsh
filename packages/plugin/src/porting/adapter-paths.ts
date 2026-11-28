/**
 * The `paths` check of `harness_verify_port`: the brief's data access rules,
 * read from an adapter's source. It looks for what an adapter must not do,
 * however the path is spelled (a literal, `join`/`resolve` parts, a template,
 * a concatenation, a constant):
 *
 * - `dsh-home`: a `.dsh` path segment, i.e. the DSH home derived from the
 *   user's home directory, in an adapter that never reads `$DSH_HOME`; and
 *   any literal home of one user (`/home/<user>/.dsh`), which is never right.
 * - `running-profile`: a path in the DSH `profiles/` directory in an adapter
 *   that never takes the running profile from `profileContext`,
 *   `$DSH_PROFILE` or `$DSH_PROFILE_DIR`.
 * - `profiles-listing`: the `profiles/` directory itself (or a glob over it)
 *   handed to a directory listing: `readdir`, `opendir`, `glob` and their
 *   variants, or a function of the same file whose body calls one. Values
 *   are followed through variables of the same file.
 *
 * Comments are skipped, so a source that documents the default `~/.dsh`
 * passes; `join(home, 'profiles', name)` names one profile, not the
 * directory, so the brief's documented fallback passes.
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
/** Longest literal quoted in a finding, so a long template does not swamp the detail. */
const QUOTED_LIMIT = 60

/** The home of one user written into the code, on Linux, macOS or Windows: never the running user's for sure. */
const USER_HOME = /(?:\/home|\/Users|[A-Za-z]:[/\\]{1,2}Users)[/\\]{1,2}[^/\\'"`\s<>]+[/\\]{1,2}\.dsh\b|\/root[/\\]{1,2}\.dsh\b/u
/** Path separators in a literal's unescaped content. */
const SEPARATORS = /[/\\]+/u
/** The DSH home's directory name under the user's home. */
const DSH_SEGMENT = '.dsh'
/** The directory holding every profile under the DSH home. */
const PROFILES_SEGMENT = 'profiles'
/** Names whose use means the adapter resolves the DSH home at run time. */
const HOME_NAMES = new Set(['DSH_HOME'])
/** Names whose use means the adapter takes the running profile from DSH. */
const PROFILE_NAMES = new Set(['profileContext', 'DSH_PROFILE', 'DSH_PROFILE_DIR'])
/** Node and npm calls that list a directory (`fs.promises.readdir` ends in `readdir`). */
const LISTING_CALLS = new Set(['readdir', 'readdirSync', 'opendir', 'opendirSync', 'glob', 'globSync'])
/** Calls that build a path from parts: `path.join`, `path.resolve`, `posix.join`… */
const PATH_CALLS = new Set(['join', 'resolve', 'normalize'])
/** Words before `(` that are not a call. */
const NOT_CALLEES = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'await', 'new', 'of', 'in', 'yield'])
/** Tokens that carry an expression on to the next line. */
const CONTINUES = new Set(['+', '=', '(', ',', '?', ':', '|', '&', '.', '[', '{'])

/** The rule a finding breaks. */
export type PathRule = 'dsh-home' | 'running-profile' | 'profiles-listing'
/** Rules in the order findings on one line are named. */
const RULE_ORDER: readonly PathRule[] = ['dsh-home', 'running-profile', 'profiles-listing']

/** One place the source breaks a rule. */
export interface PathFinding {
  /** File relative to the adapter directory, with `/`. */
  readonly file: string
  readonly line: number
  readonly rule: PathRule
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

/** A word, a string or template literal, or one punctuation character. */
interface Token {
  readonly kind: 'id' | 'str' | 'punct'
  /** A word or punctuation as written; a literal's content, each `${…}` of a template as `\0`. */
  readonly text: string
  /** A literal as written, quotes included. */
  readonly raw: string
  /** The words inside a template's `${…}`. */
  readonly words?: readonly string[]
  readonly line: number
}

/** The tokens of comment-free source. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let line = 1
  let index = 0
  while (index < text.length) {
    const char = text[index]!
    if (char === '\n') { line++; index++; continue }
    if (/\s/u.test(char)) { index++; continue }
    const start = index
    const startLine = line
    if (char === '"' || char === "'" || char === '`') {
      let content = ''
      let expressions = ''
      index++
      while (index < text.length && text[index] !== char) {
        const c = text[index]!
        if (c === '\n') { line++; if (char !== '`') break }
        if (c === '\\') { content += c + (text[index + 1] ?? ''); index += 2; continue }
        if (char === '`' && c === '$' && text[index + 1] === '{') {
          let depth = 1
          index += 2
          while (index < text.length && depth > 0 && text[index] !== '`') {
            if (text[index] === '{') depth++
            else if (text[index] === '}') depth--
            else if (text[index] === '\n') line++
            if (depth > 0) expressions += text[index]
            index++
          }
          content += '\0'
          expressions += ' '
          continue
        }
        content += c
        index++
      }
      index++
      tokens.push({ kind: 'str', text: content, raw: text.slice(start, index), words: expressions.match(/[A-Za-z_$][\w$]*/gu) ?? [], line: startLine })
      continue
    }
    const word = /^[A-Za-z_$][\w$]*|^\d[\w.]*/u.exec(text.slice(index, index + 200))
    if (word !== null) {
      index += word[0].length
      tokens.push({ kind: 'id', text: word[0], raw: word[0], line: startLine })
      continue
    }
    index++
    tokens.push({ kind: 'punct', text: char, raw: char, line: startLine })
  }
  return tokens
}

const isPunct = (token: Token | undefined, text: string): boolean => token?.kind === 'punct' && token.text === text
/** A literal's content with its escapes resolved, so the `\\` of `'C:\\Users'` is one backslash and an escaped backtick is no separator. */
const unescaped = (content: string): string => content.replace(/\\(.)/gsu, '$1')
const segments = (content: string): string[] => unescaped(content).split(SEPARATORS).filter(part => part.length > 0)

/** The index of the token closing the bracket opened at `open`, or the end. */
function closing(tokens: readonly Token[], open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
  let depth = 0
  for (let index = open; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token.kind !== 'punct') continue
    if (pairs[token.text] !== undefined) depth++
    else if (token.text === ')' || token.text === ']' || token.text === '}') depth--
    if (depth === 0) return index
  }
  return tokens.length
}

/** A half-open range of token indexes. */
type Range = readonly [number, number]

/** The arguments of the call whose `(` is at `open`, as ranges split at top-level commas. */
function argumentsOf(tokens: readonly Token[], open: number): Range[] {
  const close = closing(tokens, open)
  const args: Range[] = []
  let start = open + 1
  for (let index = open + 1; index < close; index++) {
    const token = tokens[index]!
    if (token.kind === 'punct' && (token.text === '(' || token.text === '[' || token.text === '{')) { index = closing(tokens, index); continue }
    if (isPunct(token, ',')) { args.push([start, index]); start = index + 1 }
  }
  if (start < close) args.push([start, close])
  return args
}

/** Where the expression starting at `start` ends: a top-level `;` or `,`, a closing bracket, or a line that starts a new statement. */
function expressionEnd(tokens: readonly Token[], start: number): number {
  for (let index = start; index < tokens.length; index++) {
    let token = tokens[index]!
    if (token.kind === 'punct' && (token.text === '(' || token.text === '[' || token.text === '{')) {
      index = closing(tokens, index)
      if (index >= tokens.length) return tokens.length
      token = tokens[index]!
    } else if (token.kind === 'punct' && (token.text === ';' || token.text === ',' || token.text === ')' || token.text === ']' || token.text === '}')) {
      return index
    }
    const next = tokens[index + 1]
    if (next !== undefined && next.line > token.line && !CONTINUES.has(token.text) && !(next.kind === 'punct' && CONTINUES.has(next.text))) return index + 1
  }
  return tokens.length
}

/** One source file, tokenized. */
interface Source {
  readonly file: string
  readonly tokens: readonly Token[]
}

/** The names a file uses: words, literals that are a whole name (`env['DSH_HOME']`, `ctx.get('profileContext')`), and words in templates. */
function namesOf(tokens: readonly Token[]): Set<string> {
  const names = new Set<string>()
  for (const token of tokens) {
    names.add(token.text)
    for (const word of token.words ?? []) names.add(word)
  }
  return names
}

/** What the whole adapter does, which decides whether a file's paths break a rule. */
interface AdapterFacts {
  readonly readsHome: boolean
  readonly takesProfile: boolean
  /** It touches DSH's data at all: a `.dsh` segment or `$DSH_HOME`, so a `profiles` segment is DSH's. */
  readonly touchesDsh: boolean
}

const isUrl = (token: Token): boolean => token.text.includes('://')
const hasDshSegment = (token: Token): boolean => token.kind === 'str' && !isUrl(token) && segments(token.text).includes(DSH_SEGMENT)

/** Reads one file's paths against the rules. */
class FileCheck {
  /** For each literal that is a whole argument of a path call: the call's arguments and its position. */
  private readonly pathArgs = new Map<number, { readonly args: readonly Range[]; readonly position: number }>()
  /** Variables of this file that hold the profiles directory. */
  private readonly profilesVars = new Set<string>()
  /** Functions of this file whose body lists a directory, with the call they make. */
  private readonly listers = new Map<string, string>()

  constructor(private readonly source: Source, private readonly facts: AdapterFacts) {
    const { tokens } = source
    tokens.forEach((token, index) => {
      if (!isPunct(token, '(') || !PATH_CALLS.has(tokens[index - 1]?.text ?? '')) return
      const args = argumentsOf(tokens, index)
      args.forEach(([start, end], position) => { if (end - start === 1) this.pathArgs.set(start, { args, position }) })
    })
    this.findListers()
    this.findProfilesVars()
  }

  /** Whether the literal at `index` is a path in DSH's profiles directory. */
  private inProfiles(index: number): boolean {
    const token = this.source.tokens[index]!
    if (!this.facts.touchesDsh || token.kind !== 'str' || isUrl(token) || !segments(token.text).includes(PROFILES_SEGMENT)) return false
    return SEPARATORS.test(unescaped(token.text)) || this.pathArgs.has(index)
  }

  /** Whether the literal at `index` ends at the profiles directory itself, or globs over it. */
  private profilesDirAt(index: number): boolean {
    if (!this.inProfiles(index)) return false
    const parts = segments(this.source.tokens[index]!.text)
    const after = parts.slice(parts.lastIndexOf(PROFILES_SEGMENT) + 1)
    if (after.some(part => part.includes('*'))) return true
    if (after.length > 0) return false
    const arg = this.pathArgs.get(index)
    if (arg !== undefined) {
      const next = arg.args[arg.position + 1]
      if (next === undefined) return true
      const first = this.source.tokens[next[0]]!
      return next[1] - next[0] === 1 && first.kind === 'str' && first.text.includes('*')
    }
    return !isPunct(this.source.tokens[index + 1], '+')
  }

  /** Whether the tokens in `range` evaluate to the profiles directory. */
  private profilesDir([from, to]: Range): boolean {
    const { tokens } = this.source
    let start = from
    let end = to
    while (start < end && tokens[start]!.text === 'await') start++
    while (start < end && isPunct(tokens[start], '(') && closing(tokens, start) === end - 1) { start++; end-- }
    if (end - start === 1) {
      const token = tokens[start]!
      return token.kind === 'str' ? this.profilesDirAt(start) : this.profilesVars.has(token.text)
    }
    for (let index = start; index < end; index++) {
      const token = tokens[index]!
      // `a ?? b`, `a || b`: either side.
      if ((isPunct(token, '?') && isPunct(tokens[index + 1], '?')) || (isPunct(token, '|') && isPunct(tokens[index + 1], '|'))) {
        return this.profilesDir([start, index]) || this.profilesDir([index + 2, end])
      }
      if (token.kind === 'punct' && (token.text === '(' || token.text === '[' || token.text === '{')) index = closing(tokens, index)
    }
    // A path call spanning the range: the directory when its last part is.
    const open = tokens.findIndex((token, index) => index >= start && index < end && isPunct(token, '('))
    if (open > start && closing(tokens, open) === end - 1 && PATH_CALLS.has(tokens[open - 1]!.text)) {
      const args = argumentsOf(tokens, open)
      const last = args[args.length - 1]
      if (args.some(([s, e]) => e - s === 1 && this.profilesDirAt(s))) return true
      return last !== undefined && this.profilesDir(last)
    }
    // A concatenation ending at the directory.
    const last = tokens[end - 1]!
    return isPunct(tokens[end - 2], '+') && last.kind === 'str' && this.profilesDirAt(end - 1)
  }

  /** Variables assigned the profiles directory, followed through aliases until none is added. */
  private findProfilesVars(): void {
    const { tokens } = this.source
    const assignments: Array<{ readonly name: string; readonly value: Range }> = []
    tokens.forEach((token, index) => {
      const next = tokens[index + 1]
      if (token.kind !== 'id' || !isPunct(next, '=') || isPunct(tokens[index + 2], '=') || isPunct(tokens[index + 2], '>') || isPunct(tokens[index - 1], '.')) return
      assignments.push({ name: token.text, value: [index + 2, expressionEnd(tokens, index + 2)] })
    })
    let added = true
    while (added) {
      added = false
      for (const { name, value } of assignments) {
        if (!this.profilesVars.has(name) && this.profilesDir(value)) { this.profilesVars.add(name); added = true }
      }
    }
  }

  /** Functions of this file (`function f`, `const f = (…) =>`, `const f = function`) whose body lists a directory: one level deep. */
  private findListers(): void {
    const { tokens } = this.source
    tokens.forEach((token, index) => {
      let name: string | undefined
      let from = index + 1
      if (token.text === 'function' && tokens[index + 1]?.kind === 'id') { name = tokens[index + 1]!.text; from = index + 2 } else if (token.kind === 'id' && isPunct(tokens[index + 1], '=') && !isPunct(tokens[index + 2], '=') && !isPunct(tokens[index + 2], '>')) {
        let at = index + 2
        if (tokens[at]?.text === 'async') at++
        const head = tokens[at]
        const arrowAfter = head?.text === 'function' ? -1 : isPunct(head, '(') ? closing(tokens, at) + 1 : head?.kind === 'id' ? at + 1 : -1
        if (head?.text === 'function') { name = token.text; from = at + 1 } else if (arrowAfter > 0 && isPunct(tokens[arrowAfter], '=') && isPunct(tokens[arrowAfter + 1], '>')) {
          name = token.text
          const body = arrowAfter + 2
          const end = isPunct(tokens[body], '{') ? closing(tokens, body) : expressionEnd(tokens, body)
          this.addLister(name, body, end)
          return
        }
      }
      if (name === undefined) return
      const params = tokens.findIndex((item, at) => at >= from && isPunct(item, '('))
      if (params === -1) return
      const body = tokens.findIndex((item, at) => at > closing(tokens, params) && isPunct(item, '{'))
      if (body !== -1) this.addLister(name, body, closing(tokens, body))
    })
  }

  private addLister(name: string, from: number, to: number): void {
    if (LISTING_CALLS.has(name)) return
    for (let index = from; index < to; index++) {
      const token = this.source.tokens[index]!
      if (LISTING_CALLS.has(token.text) && isPunct(this.source.tokens[index + 1], '(')) { this.listers.set(name, token.text); return }
    }
  }

  findings(): PathFinding[] {
    const { tokens, file } = this.source
    const out: PathFinding[] = []
    const add = (line: number, rule: PathRule, what: string): void => { out.push({ file, line, rule, what }) }
    tokens.forEach((token, index) => {
      if (token.kind === 'str') {
        const quoted = token.raw.length > QUOTED_LIMIT ? `${token.raw.slice(0, QUOTED_LIMIT)}…` : token.raw
        const userHome = USER_HOME.exec(token.text)
        if (userHome !== null) add(token.line, 'dsh-home', `hard-codes one user's DSH home (${userHome[0]})`)
        else if (!this.facts.readsHome && hasDshSegment(token)) add(token.line, 'dsh-home', `builds the DSH home from the home directory (${quoted}) but the adapter never reads $DSH_HOME`)
        if (!this.facts.takesProfile && this.inProfiles(index)) add(token.line, 'running-profile', 'builds a path in profiles/ but the adapter never takes the running profile from profileContext, $DSH_PROFILE or $DSH_PROFILE_DIR')
        return
      }
      if (!isPunct(token, '(')) return
      const callee = tokens[index - 1]
      if (callee?.kind !== 'id' || NOT_CALLEES.has(callee.text) || tokens[index - 2]?.text === 'function') return
      const lists = LISTING_CALLS.has(callee.text) ? callee.text : this.listers.has(callee.text) ? `${callee.text}, which calls ${this.listers.get(callee.text)!}` : undefined
      if (lists !== undefined && argumentsOf(tokens, index).some(arg => this.profilesDir(arg))) add(callee.line, 'profiles-listing', `lists the profiles directory (${lists})`)
    })
    return out
  }
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

/** Where an adapter's source breaks the data access rules, by file, line and rule. */
export function hardCodedPaths(dir: string): PathFinding[] {
  const files: string[] = []
  sourcesUnder(dir, files)
  const sources: Source[] = []
  for (const path of files) {
    try {
      if (statSync(path).size > SIZE_LIMIT) continue
      sources.push({ file: relative(dir, path).split(sep).join('/'), tokens: tokenize(withoutComments(readFileSync(path, 'utf8'))) })
    } catch {
      continue
    }
  }
  const names = new Set(sources.flatMap(source => [...namesOf(source.tokens)]))
  const readsHome = [...HOME_NAMES].some(name => names.has(name))
  const facts: AdapterFacts = {
    readsHome,
    takesProfile: [...PROFILE_NAMES].some(name => names.has(name)),
    touchesDsh: readsHome || sources.some(source => source.tokens.some(hasDshSegment)),
  }
  const seen = new Set<string>()
  return sources
    .flatMap(source => new FileCheck(source, facts).findings())
    .filter(item => { const key = `${item.file}:${item.line}:${item.rule}`; if (seen.has(key)) return false; seen.add(key); return true })
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule))
}

/** The check's detail for its findings. */
export function pathsDetail(findings: readonly PathFinding[]): string {
  if (findings.length === 0) return 'the source resolves DSH paths at run time: the DSH home from $DSH_HOME, the profile from profileContext, $DSH_PROFILE or $DSH_PROFILE_DIR, and no listing of profiles/'
  const shown = findings.slice(0, SHOWN_LIMIT).map(item => `${item.file}:${item.line} [${item.rule}] ${item.what}`)
  const more = findings.length > SHOWN_LIMIT ? `; and ${findings.length - SHOWN_LIMIT} more` : ''
  return `${shown.join('; ')}${more}. Resolve the DSH home at run time as process.env.DSH_HOME, else join(os.homedir(), '.dsh'), and the profile from profileContext, $DSH_PROFILE or $DSH_PROFILE_DIR; never list profiles/ or read another profile (the brief's data access rules)`
}
