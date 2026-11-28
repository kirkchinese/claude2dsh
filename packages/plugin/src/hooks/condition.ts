/**
 * A handler's `if` field: one permission rule (`Bash(git *)`, `Edit(src/**)`,
 * `WebFetch(domain:example.com)`, `mcp__server__tool`, a bare tool name)
 * matched against the tool name and its input together.
 *
 * - Shell rules match each subcommand (after stripping `VAR=value`), commands
 *   inside `$(…)` and backticks; when the input cannot be read, or a
 *   subcommand expands something at run time where it could still become
 *   what the rule names, the hook runs.
 * - File rules follow gitignore semantics, anchored as Claude Code anchors
 *   them (see `pathRuleMatches`): a pattern without `/` matches the file name
 *   at any depth under the working directory, `./x` only `<cwd>/x`, `src/**` only under `<cwd>/src`
 *   in an allow rule, `//abs` an absolute path, `~/x` the home directory and
 *   `/x` the directory of the settings source.
 *   `Edit` rules cover every file-writing tool and `Read` rules every reader.
 * @module @kirkchinese/harness-forge
 */
import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, posix, resolve, win32 } from 'node:path'
import { linksReachNewShare, reachesNewShare, SYMLINK_HOPS, type LinkReader } from '@kirkchinese/harness-forge-core'
import { Glob, wildcard } from './glob.js'
import { powershellCommand } from './powershell-aliases.js'
import { shellCommands } from './shell-commands.js'
import { isShellTool, type ForeignTool } from './vocabulary.js'

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch'])
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'NotebookRead'])

/** How a permission rule is used, which file rules depend on. */
export interface RuleUse {
  /** Where a `/path` file rule anchors: the directory of the settings source that defines it (default: the working directory). */
  readonly root?: string
  /** A deny or ask rule: `dir/**` matches at any depth, and a pattern naming a directory everything in it. */
  readonly restricts?: boolean
  /**
   * Which path a file rule matches: the path as `spelled`, or its `real` path
   * (see `realPathOf`; anchors resolved alike). Unset: a restricting answer
   * (`unknown` true) matches either, an approving one only both.
   */
  readonly path?: 'spelled' | 'real'
}

/** Whether a call is a file call that `Read(...)`/`Edit(...)` rules match by path. */
export function isFileCall(tool: ForeignTool): boolean {
  const path = tool.input['file_path'] ?? tool.input['path']
  return typeof path === 'string' && tool.aliases.some(alias => WRITE_TOOLS.has(alias) || READ_TOOLS.has(alias))
}

/**
 * Whether `rule` selects this tool call.
 * @param cwd - the session's working directory, for relative file rules.
 * @param unknown - the answer when a wildcard or what it is matched against is
 *   too large to match within budget: true (the default) for a hook's `if` (the
 *   hook runs) and for deny and ask rules, false for allow rules.
 * @param use - how a permission rule is used, for file rules (see `RuleUse`).
 */
export function conditionMatches(rule: string, tool: ForeignTool, cwd: string, unknown = true, use: RuleUse = {}): boolean {
  const match = /^\s*([A-Za-z0-9_\-:.*]+?)\s*(?:\((.*)\))?\s*$/su.exec(rule)
  if (match === null) return false
  const name = match[1] ?? ''
  const specifier = match[2]
  if (name.startsWith('mcp__')) return mcpRuleMatches(name, specifier, tool.name)
  if (!ruleNamesTool(name, tool)) return false
  if (specifier === undefined || specifier === '' || specifier === '*') return true
  if (isShellTool(tool.dshName)) return shellRuleMatches(specifier, String(tool.input['command'] ?? ''), unknown, shellOf(tool))
  if (name === 'WebFetch' && specifier.startsWith('domain:')) return domainMatches(specifier.slice('domain:'.length), String(tool.input['url'] ?? ''), unknown)
  const path = tool.input['file_path'] ?? tool.input['path']
  if (typeof path === 'string' && (WRITE_TOOLS.has(name) || READ_TOOLS.has(name))) return fileRuleMatches(specifier, path, cwd, unknown, use)
  const subject = tool.input['subagent_type'] ?? tool.input['skill'] ?? tool.input['query'] ?? tool.input['url'] ?? tool.input['pattern'] ?? ''
  return glob(specifier, true).match(String(subject)) ?? unknown
}

function ruleNamesTool(name: string, tool: ForeignTool): boolean {
  if (tool.aliases.includes(name)) return true
  if (name === 'Edit') return tool.aliases.some(alias => WRITE_TOOLS.has(alias))
  if (name === 'Read') return tool.aliases.some(alias => READ_TOOLS.has(alias))
  return false
}

function mcpRuleMatches(name: string, specifier: string | undefined, toolName: string): boolean {
  if (specifier !== undefined && specifier !== '' && specifier !== '*') return false
  if (name === toolName) return true
  const server = name.endsWith('__*') ? name.slice(0, -1) : `${name}__`
  return name.split('__').length === 2 || name.endsWith('__*') ? toolName.startsWith(server) : false
}

/**
 * Shell rule: any subcommand matches; unreadable input runs the hook. The rule
 * and each subcommand are compared as the words the shell reads (quotes and
 * escapes removed, blanks collapsed). A subcommand with a word the shell
 * would expand, or whose syntax the word reader does not read, matches with
 * `unknown` when its words before that one agree with the rule's words.
 * Only the argv is compared: redirections (`> out`, `2>&1`, `<<< x`) are set
 * apart on both sides, so `git status > out` is `git status` to a rule. What a
 * redirection reads or writes is checked against file rules instead (see
 * `redirectFiles` and `ruleVerdict`).
 */
function shellRuleMatches(specifier: string, command: string, unknown: boolean, shell: Shell): boolean {
  const parsed = shellCommands(command, shell)
  if (parsed === undefined) return true
  // PowerShell: the command word on both sides as its cmdlet, through every alias for a restricting answer and
  // only this platform's for an approving one (see `powershellCommand`).
  const canonical = (word: string): string => shell === 'powershell' ? powershellCommand(word, unknown ? 'all' : 'here') : word
  const rule = shellRule(specifier, shell, canonical)
  if (rule === undefined) return unknown
  return parsed.commands.some((sub) => {
    const read = shellWords(sub, false, shell)?.words
    if (read === undefined) return unknown
    const words = read.map((word, index) => index === 0 && !word.dynamic ? { ...word, text: canonical(word.text) } : word)
    const dynamicAt = words.findIndex(word => word.dynamic)
    if (dynamicAt === -1) return rule.pattern.match(words.map(word => word.text).join(WORD_BREAK)) ?? unknown
    return unknown && couldExpandInto(rule, words, dynamicAt)
  })
}

/** What stands between two words when a rule is matched against a command's words: no word holds it (one that does is dynamic). */
const WORD_BREAK = '\u0000'

/** A shell rule read into words: `prefix` for the legacy `:*` suffix. */
interface ShellRule {
  readonly words: readonly string[]
  readonly prefix: boolean
  readonly pattern: Glob
}

/**
 * `git *` matches `git` and `git <anything>` when that `*` is the rule's only
 * wildcard; `prefix:*` is the legacy prefix form; any other `*` stands for
 * any text, across words. Undefined when the rule's quotes do not close.
 */
function shellRule(specifier: string, shell: Shell, canonical: (command: string) => string): ShellRule | undefined {
  const trimmed = specifier.trim()
  if (Glob.tooLong(trimmed)) return { words: [], prefix: false, pattern: Glob.refused() }
  const prefix = trimmed.endsWith(':*')
  const read = shellWords(prefix ? trimmed.slice(0, -2) : trimmed, true, shell)
  if (read === undefined) return undefined
  // The command word, unless a wildcard stands in it, read as the command it names.
  const words = read.words.map((word, index) => index === 0 && !/[*?]/u.test(word.text) ? canonical(word.text) : word.text)
  const wildcards = words.filter(word => /[*?]/u.test(word)).length
  const trailingStar = !prefix && words.at(-1) === '*' && wildcards === 1
  const pattern = new Glob()
  ;(trailingStar ? words.slice(0, -1) : words).forEach((word, index) => {
    if (index > 0) pattern.literal(WORD_BREAK)
    for (const char of word) {
      if (char === '*') pattern.many()
      else if (char === '?') pattern.one()
      else pattern.literal(char)
    }
  })
  if (prefix || trailingStar) pattern.optional(rest => rest.literal(WORD_BREAK).many())
  return { words, prefix, pattern }
}

/**
 * Whether a command with a run-time expansion could become one the rule
 * names: its static words agree with the rule's, position by position, up to
 * the first expanding word or the first rule word with a wildcard. The
 * expansion may be empty, so `cat secret.txt $X` could be `cat secret.txt`.
 */
function couldExpandInto(rule: ShellRule, words: readonly ShellWord[], dynamicAt: number): boolean {
  for (let index = 0; index < dynamicAt; index++) {
    const ruleWord = rule.words[index]
    if (ruleWord === undefined) return rule.prefix
    if (/[*?]/u.test(ruleWord)) return true
    if (words[index]?.text !== ruleWord) return false
  }
  return true
}

/** One word as the shell reads it; `dynamic` when the shell would expand it, or it holds syntax the reader does not read. */
interface ShellWord {
  readonly text: string
  readonly dynamic: boolean
  /** Written with a quote or an escape somewhere: PowerShell's `'$null'` is a name, its `$null` the null variable. */
  readonly quoted: boolean
}

/** A file one redirection of a command reads or writes. */
export interface RedirectFile {
  readonly path: string
  readonly reads: boolean
  readonly writes: boolean
  /**
   * The path is known as written: not expanded at run time, not starting with
   * `~` and without a glob character, which Claude Code always asks about
   * (https://code.claude.com/docs/en/permissions#redirections).
   */
  readonly plain: boolean
}

/** The null device of bash (also Git Bash, which maps it on Windows), and of PowerShell where it is a device (not on Windows). */
const DEV_NULL = '/dev/null'
/** PowerShell's null target (https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_redirection). */
const POWERSHELL_NULL = /^\$null$/iu
/** Windows' null device, reserved in every folder whichever shell (bash, PowerShell, cmd) names it. */
const WINDOWS_NUL = /^nul$/iu

/** Whether a redirection target is the null device of `shell` on this platform: no file behind it. */
function nullDevice(target: ShellWord, shell: Shell): boolean {
  const windows = process.platform === 'win32'
  if (windows && WINDOWS_NUL.test(target.text)) return true
  // Only the bare variable: quoted, `'$null'` names a file of that name.
  if (shell === 'powershell') return (!target.quoted && POWERSHELL_NULL.test(target.text)) || (!windows && target.text === DEV_NULL)
  return target.text === DEV_NULL
}

/**
 * The files the redirections of one simple command of `shell` read or write;
 * undefined when its words cannot be read. Here-documents, here-strings,
 * descriptor copies and closes (`2>&1`, `<&3`, `>&-`) and the shell's null
 * device (see `nullDevice`) name no file.
 */
export function redirectFiles(command: string, shell: Shell): RedirectFile[] | undefined {
  const read = shellWords(command, false, shell)
  if (read === undefined) return undefined
  return read.redirects.flatMap(({ operator, target }): RedirectFile[] => {
    // Without its descriptor or stream (`2`, PowerShell's `*`).
    const op = operator.replace(/^(?:\d+|\*)/u, '')
    if (op.startsWith('<<') || nullDevice(target, shell)) return []
    if ((op === '<&' || op === '>&') && /^(?:\d+-?|-)$/u.test(target.text)) return []
    const reads = op === '<' || op === '<>' || op === '<&'
    const writes = op !== '<' && op !== '<&'
    return [{ path: target.text, reads, writes, plain: !target.dynamic && !target.text.startsWith('~') && !/[*?[]/u.test(target.text) }]
  })
}

/** A redirection: its operator (`>`, `2>>`, `&>`, `<<<`, `>&` …) and the word after it. */
interface Redirect {
  readonly operator: string
  readonly target: ShellWord
}

/**
 * A redirection operator of bash (https://www.gnu.org/software/bash/manual/bash.html#Redirections),
 * longest first: `&>>`/`&>` (stdout and stderr), here-strings `<<<`, here-documents `<<-`/`<<`,
 * `<>` (read and write), descriptor copies `<&`/`>&`, `>>`, `>|` (despite noclobber), `<` and `>`.
 */
const REDIRECT_OPERATOR = /&>>|&>|<<<|<<-|<<|<>|<&|>>|>\||>&|<|>/uy
/**
 * PowerShell's redirection operators (https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_redirection),
 * after an optional stream (see {@link POWERSHELL_STREAM}): `>>`, `>&` (a merge, `2>&1`), `>`, and `<`, which
 * PowerShell 7 reserves and refuses to run; read as an input redirection, it can only make a rule match more.
 */
const POWERSHELL_REDIRECT_OPERATOR = />>|>&|>|</uy
/** The streams a PowerShell redirection names: success (1) to information (6), or `*` for all. */
const POWERSHELL_STREAM = /^(?:[1-6]|\*)$/u
/** A bash redirection's descriptor number. */
const BASH_DESCRIPTOR = /^\d+$/u

/** A shell whose words a command or rule is read as. */
export type Shell = 'bash' | 'powershell'

/** The shell that reads a shell call's command: PowerShell for DSH's `pwsh` tool, bash otherwise. */
export function shellOf(tool: ForeignTool): Shell {
  return tool.dshName === 'pwsh' ? 'powershell' : 'bash'
}

/**
 * The words of a command or a rule, in one pass over the text: blanks
 * separate words; single quotes, double quotes and backslashes quote and are
 * removed. In a command (not a `rule`) an unquoted `#` at a word's start
 * begins a comment, and a word is dynamic when it holds `$` or a backtick,
 * unquoted glob, brace or parenthesis characters, or {@link WORD_BREAK}.
 * An unquoted redirection, with the descriptor number before it and the
 * word after it, is set apart in `redirects` (a process substitution `<(…)`
 * stays a dynamic word). Undefined when a quote does not close or a
 * redirection has no word.
 */
function shellWords(text: string, rule: boolean, shell: Shell): { words: ShellWord[]; redirects: Redirect[] } | undefined {
  const operators = shell === 'powershell' ? POWERSHELL_REDIRECT_OPERATOR : REDIRECT_OPERATOR
  const descriptors = shell === 'powershell' ? POWERSHELL_STREAM : BASH_DESCRIPTOR
  // PowerShell matches without case (https://code.claude.com/docs/en/permissions#powershell).
  const fold = (word: string): string => shell === 'powershell' ? word.toLowerCase() : word
  const words: ShellWord[] = []
  const redirects: Redirect[] = []
  let current = ''
  let started = false
  let dynamic = false
  // The current word was written with a quote or an escape: it cannot be a descriptor number.
  let quoted = false
  // The operator whose target the next word is.
  let pending: string | undefined
  const end = (): void => {
    if (started) {
      const word = { text: current, dynamic: dynamic || current.includes(WORD_BREAK), quoted }
      if (pending !== undefined) redirects.push({ operator: pending, target: word })
      else words.push({ ...word, text: fold(word.text) })
      pending = undefined
    }
    current = ''
    started = false
    dynamic = false
    quoted = false
  }
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? ''
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      end()
      continue
    }
    if (char === '#' && !started && !rule) break
    operators.lastIndex = index
    const opens = char === '<' || char === '>' || (shell === 'bash' && char === '&')
    const operator = opens && text[index + 1] !== '(' ? operators.exec(text)?.[0] : undefined
    if (operator !== undefined && pending === undefined) {
      // `2>` (PowerShell also `*>`) names a descriptor; any other word before the operator is a word of its own.
      const descriptor = started && !quoted && descriptors.test(current) ? current : ''
      if (descriptor !== '') {
        // The descriptor is no word: what it set (PowerShell's `*` reads as a glob) goes with it.
        current = ''
        started = false
        dynamic = false
      } else end()
      pending = descriptor + operator
      index += operator.length - 1
      continue
    }
    started = true
    if (char === '\\') {
      quoted = true
      const next = text[index + 1]
      if (next === undefined) dynamic = true
      // A backslash-newline joins two lines and stands for nothing.
      else if (next !== '\n') current += next
      index++
    } else if (char === "'") {
      quoted = true
      const close = text.indexOf("'", index + 1)
      if (close === -1) return undefined
      current += text.slice(index + 1, close)
      index = close
    } else if (char === '"') {
      quoted = true
      let close = index + 1
      for (; close < text.length && text[close] !== '"'; close++) {
        const inner = text[close] ?? ''
        const next = text[close + 1] ?? ''
        if (inner === '\\' && (next === '$' || next === '`' || next === '"' || next === '\\' || next === '\n')) {
          if (next !== '\n') current += next
          close++
        } else {
          if (!rule && (inner === '$' || inner === '`')) dynamic = true
          current += inner
        }
      }
      if (close >= text.length) return undefined
      index = close
    } else {
      if (!rule && '$`*?[{()'.includes(char)) dynamic = true
      current += char
    }
  }
  end()
  return pending === undefined ? { words, redirects } : undefined
}

/**
 * `domain:example.com` is that host only, `*.example.com` any subdomain at
 * any depth but not the domain itself, `*` every host; any other `*` stays
 * between two dots. Case and a trailing dot are ignored.
 */
function domainMatches(domain: string, url: string, unknown: boolean): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/u, '')
    const wanted = domain.trim().toLowerCase().replace(/\.$/u, '')
    if (wanted === '*') return true
    if (wanted.startsWith('*.')) return host.endsWith(wanted.slice(1))
    return wildcard(wanted, char => char !== '.').match(host) ?? unknown
  } catch {
    return false
  }
}

/**
 * Whether a gitignore-style pattern, relative to the working directory,
 * matches a path as spelled (skill `paths`): no link is followed.
 */
export function pathPatternMatches(pattern: string, path: string, cwd: string): boolean {
  return pathRuleMatches(pattern, path, cwd, false, {}, spelled)
}

/** A path as spelled. */
const spelled = (path: string): string => path

/** The filesystem calls the resolver makes, and the platform whose paths it reads: the system's, or a test's. */
export interface RealPathSystem extends LinkReader {
  readonly platform: NodeJS.Platform
  realpath(path: string): string
}

const SYSTEM: RealPathSystem = {
  get platform() { return process.platform },
  lstat: lstatSync,
  readlink: readlinkSync,
  realpath: path => realpathSync.native(path),
}

/**
 * The real path of an absolute path, or undefined when it cannot be known (a
 * link loop, more than {@link SYMLINK_HOPS} links, a link or folder that
 * cannot be read, or, on Windows, a path or link that leads to a network share
 * or device `base` is not on). What exists is resolved by the system; a part
 * that does not exist yet is followed link by link (`readlink`), so a dangling
 * link leads where a write through it would create its file. The one resolver
 * file rules and redirection targets use; nothing else follows links.
 *
 * On Windows, opening, resolving or reading a link on `\\server\share` makes
 * the system connect to that server and sign in with the person's credentials,
 * and `realpath` follows links by itself. So before any call that could follow
 * one, `linksReachNewShare` walks the path with `lstat` and `readlink` only;
 * realpath runs only for a path that stays local (it is what expands a short
 * name such as `RUNNER~1`).
 * @param base - the working directory: a share it is on is not new.
 */
export function realPathOf(path: string, base: string, system: RealPathSystem = SYSTEM): string | undefined {
  return resolveReal(path, base, system, { hops: 0 })
}

function resolveReal(path: string, base: string, system: RealPathSystem, followed: { hops: number }): string | undefined {
  if (linksReachNewShare(path, base, system.platform, system)) return undefined
  const paths = system.platform === 'win32' ? win32 : posix
  try {
    return system.realpath(path)
  } catch (error: unknown) {
    // Only a missing part is followed by hand; a loop or an unreadable folder stays unknown.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined
  }
  const parent = paths.dirname(path)
  if (parent === path) return undefined
  const folder = resolveReal(parent, base, system, followed)
  if (folder === undefined) return undefined
  const candidate = paths.join(folder, paths.basename(path))
  try {
    if (!system.lstat(candidate).isSymbolicLink()) return undefined
  } catch (error: unknown) {
    // Nothing there: a write creates the file here.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? candidate : undefined
  }
  if (++followed.hops > SYMLINK_HOPS) return undefined
  let target: string
  try {
    target = system.readlink(candidate)
  } catch {
    return undefined
  }
  return resolveReal(paths.resolve(folder, target), base, system, followed)
}

/**
 * A `Read(...)`/`Edit(...)` rule, checked on the path as spelled and on its
 * real path (anchors resolved the same way), or on the one `use.path` names:
 * a restricting answer (`unknown` true: deny, ask, a hook's `if`) matches
 * when either does, so a link cannot hide a denied file; an approving one
 * (allow) only when both do, so a link inside an allowed folder cannot reach
 * a file outside it (`ruleVerdict` lets two allow rules cover the two paths).
 */
function fileRuleMatches(specifier: string, path: string, cwd: string, unknown: boolean, use: RuleUse): boolean {
  const real = (absolute: string): string | undefined => realPathOf(absolute, cwd)
  if (use.path !== undefined) return pathRuleMatches(specifier, path, cwd, unknown, use, use.path === 'real' ? real : spelled)
  const asSpelled = pathRuleMatches(specifier, path, cwd, unknown, use, spelled)
  if (asSpelled === unknown) return asSpelled
  // A path whose real form cannot be known matches a restricting rule and no approving one.
  return pathRuleMatches(specifier, path, cwd, unknown, use, real)
}

/**
 * A file rule, anchored as Claude Code anchors it
 * (https://code.claude.com/docs/en/permissions#how-path-patterns-match):
 * `//path` at the filesystem root, `~/path` at the home directory, `/path` at
 * `root` (the directory of the settings source; the working directory when
 * there is none), `path` and `./path` at the working directory. A rule
 * matches only files under its anchor. The docs apply gitignore semantics
 * (https://code.claude.com/docs/en/permissions#how-deep-a-pattern-matches):
 * a bare pattern without a `/` ("bare filenames ... match at any depth")
 * matches at any depth below its anchor, and so does a bare single-directory
 * `dir/**` in a deny or ask rule (`restricts`); any other slash anchors, the
 * leading one of `./x` too (https://git-scm.com/docs/gitignore#_pattern_format:
 * a separator at the beginning or middle makes the pattern relative to its
 * base), so `./x` is `<cwd>/x` only. In a deny or ask rule a pattern that
 * matches a directory also matches everything in it, as in gitignore.
 */
function pathRuleMatches(specifier: string, path: string, cwd: string, unknown: boolean, { root, restricts = false }: RuleUse, locate: (absolute: string) => string | undefined): boolean {
  const located = locate(isAbsolute(path) ? resolve(path) : resolve(cwd, path))
  // Where a path or an anchor cannot be known, the answer is `unknown`: a restricting rule matches, an approving one does not.
  if (located === undefined) return unknown
  const target = rulePath(located)
  let unresolved = false
  const anchor = (directory: string): string => {
    const real = locate(resolve(directory))
    if (real === undefined) unresolved = true
    return rulePath(real ?? directory)
  }
  let pattern = specifier.trim()
  let base: string
  // A bare relative pattern (no leading `./`, `/`, `~/` or `//`): the only form that may match below its anchor.
  let bare = false
  if (pattern.startsWith('//')) {
    base = '/'
    pattern = pattern.slice(2)
  } else if (pattern.startsWith('~/')) {
    base = anchor(homedir())
    pattern = pattern.slice(2)
  } else if (pattern.startsWith('/')) {
    base = anchor(root ?? cwd)
    pattern = pattern.slice(1)
  } else if (pattern.startsWith('./')) {
    // `./x` contains a slash, so gitignore anchors it: `<cwd>/x` only, never `<cwd>/sub/x`.
    base = anchor(cwd)
    pattern = pattern.slice(2)
  } else {
    base = anchor(cwd)
    bare = true
  }
  if (process.platform === 'win32') pattern = pattern.toLowerCase()
  pattern = pattern.replace(/\/+$/u, '')
  // An anchored rule's literal folders (before the last part or the first wildcard) are resolved as the path is, so
  // `//etc/hosts` also covers macOS's `/private/etc/hosts`, and a Windows short name its long one.
  if (!bare && locate !== spelled) {
    const parts = pattern.split('/')
    const literal = parts.findIndex(part => /[*?[]/u.test(part))
    const folders = Math.min(literal === -1 ? parts.length - 1 : literal, parts.length - 1)
    const prefix = nativePath(`${base.endsWith('/') ? base : `${base}/`}${parts.slice(0, folders).join('/')}`)
    // A rule's folders on a share stay as written: nothing local resolves onto one (such a path is unknown), and
    // resolving them would connect to it.
    if (folders > 0 && !reachesNewShare(prefix, cwd)) {
      const real = locate(prefix)
      if (real === undefined) unresolved = true
      else {
        base = rulePath(real)
        pattern = parts.slice(folders).join('/')
      }
    }
  }
  if (unresolved) return unknown
  const rel = below(base, target)
  if (rel === undefined) return false
  const anyDepth = bare && (!pattern.includes('/') || (restricts && /^[^/]+\/\*\*$/u.test(pattern)))
  const compiled = glob(anyDepth ? `**/${pattern}` : pattern, false)
  // The path and, for a deny or ask rule, each directory above it.
  const candidates = restricts ? [...[...rel.matchAll(/\//gu)].map(slash => rel.slice(0, slash.index)), rel] : [rel]
  return candidates.some(candidate => compiled.match(candidate) ?? unknown)
}

/** A path in the form rules match (on Windows see `windowsRulePath`). */
function rulePath(path: string): string {
  return process.platform === 'win32' ? windowsRulePath(path) : path
}

/** A path in rule form back to one the system resolves (on Windows see `windowsNativePath`). */
function nativePath(path: string): string {
  return process.platform === 'win32' ? windowsNativePath(path) : path
}

/** Windows' long-path prefixes: `\\?\UNC\server\share` and `\\?\C:\…`. */
const WINDOWS_LONG_UNC = /^\\\\\?\\UNC\\/iu
const WINDOWS_LONG = /^\\\\\?\\/u

/**
 * A Windows path in the form rules match, as Claude Code writes them
 * (https://code.claude.com/docs/en/permissions#where-a-pattern-anchors: "`C:\Users\alice` becomes `/c/Users/alice`"):
 * either separator becomes `/`, the long-path prefix goes, a drive `C:` becomes `/c` and a share `\\server` stays
 * `//server`. The whole path is compared without case, as Windows' file systems compare names by default, so the
 * rule, the working directory and every path, spelled or real, go through this one function.
 */
export function windowsRulePath(path: string): string {
  return path.replace(WINDOWS_LONG_UNC, '\\\\').replace(WINDOWS_LONG, '').replace(/\\/gu, '/').toLowerCase().replace(/^([a-z]):/u, '/$1')
}

/** A rule-form Windows path (`/c/users/x`, `//server/share/x`) as Windows names it (`c:\users\x`). */
export function windowsNativePath(path: string): string {
  const drive = /^\/([a-z])(?:\/(.*))?$/u.exec(path)
  if (drive !== null) return `${drive[1] ?? ''}:\\${(drive[2] ?? '').replace(/\//gu, '\\')}`
  return path.replace(/\//gu, '\\')
}

/** `target` relative to `base` (both from `rulePath`), or undefined when it lies outside. */
function below(base: string, target: string): string | undefined {
  if (target === base) return ''
  const prefix = base.endsWith('/') ? base : `${base}/`
  return target.startsWith(prefix) ? target.slice(prefix.length) : undefined
}

/** A glob. In shell rules `*` spans anything; in path rules it stays within a segment. */
function glob(pattern: string, shell: boolean): Glob {
  if (Glob.tooLong(pattern)) return Glob.refused()
  const segment = (char: string): boolean => shell || char !== '/'
  const result = new Glob()
  const chars = [...pattern]
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index] ?? ''
    if (char === '*') {
      if (chars[index + 1] === '*') {
        index++
        if (chars[index + 1] === '/') {
          index++
          result.optional(dirs => dirs.many().literal('/'))
        } else {
          result.many()
        }
      } else {
        result.many(segment)
      }
    } else if (char === '?') {
      result.one(segment)
    } else {
      result.literal(char)
    }
  }
  return result
}
