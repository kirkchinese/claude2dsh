/**
 * Render a Claude Code command or skill body as Claude Code does before the
 * model sees it: argument placeholders, path variables, inline `` !`cmd` ``
 * and fenced ```` ```! ```` shell injection, and `@file` attachments.
 *
 * The template's structure is fixed before any value goes in: shell lines and
 * `@file` references are found in the body as written, so an argument (or a
 * command's output) is always data and never becomes a shell line or an
 * attachment. Inside a shell line a value reaches the shell only through an
 * environment variable, referenced only where that reference provably stays
 * data; a placeholder anywhere else keeps the line from running (a visible note
 * says so), unlike Claude Code, which splices the text in. An `@file` reference
 * attaches a file only where the template may reach (see `attach`); anything
 * else gets a visible note.
 * @module @kirkchinese/harness-forge
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { isInside, realOrLexical, workspaceRootOf } from '@kirkchinese/harness-forge-core'
import type { ForeignShell } from '../hooks/shell.js'

/** Everything a body may reference. */
export interface RenderContext {
  /** Raw text after the command name; empty for a model-loaded skill. */
  readonly rawArguments: string
  /** Names from the `arguments` frontmatter, mapped to positions in order. */
  readonly argumentNames: readonly string[]
  readonly cwd: string
  readonly pluginRoot?: string
  readonly dataDir?: string
  readonly skillDir?: string
  readonly sessionId?: string
  readonly shell: ForeignShell
  /** `bash` (default) or `powershell`, from the `shell` frontmatter key. */
  readonly shellKind?: string
  readonly signal?: AbortSignal
  /** The home directory whose `.claude` `@file` references may read (tests). */
  readonly home?: string
  /**
   * Whose template this is, for what `@file` may attach: `user` (the person's
   * own assets: the workspace, the template's directory and `~/.claude`),
   * `plugin` (default: the plugin and the workspace) or `project` (the workspace only).
   */
  readonly scope?: 'user' | 'project' | 'plugin'
  /** Set when no shell line of this body may run (the workspace is not trusted): why, shown in place of each. */
  readonly refuseShell?: string
}

/** What stands in place of a shell line that did not run. */
function shellNote(reason: string): string {
  return `[Harness Forge: this shell command was not run: ${reason}]`
}

/** The rendered prompt plus files referenced with `@`. */
export interface RenderedBody {
  readonly text: string
  readonly files: ReadonlyArray<{ readonly path: string; readonly content: string }>
  /** Shell commands that ran, for evidence. */
  readonly commands: number
}

const COMMAND_TIMEOUT_MS = 120_000
const FILE_LIMIT = 256 * 1024

/** `\$`, a path variable, `$ARGUMENTS[n]`, `$ARGUMENTS`, `$n` or `$name`. */
const PLACEHOLDER = /\\\$|\$\{(CLAUDE_SKILL_DIR|CLAUDE_PROJECT_DIR|CLAUDE_SESSION_ID|CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA)\}|\$ARGUMENTS\[(\d+)\]|\$ARGUMENTS\b|\$(\d+)|\$([A-Za-z_][A-Za-z0-9_-]*)/gu

/** One piece of a template: prose, or a shell line with what stood before it. */
type Segment = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'shell'; readonly command: string; readonly lead: string }

/** Split a body into prose and shell lines, as written: a fenced ```! block, or an inline !`cmd` at line start or after whitespace. */
function segmentsOf(body: string): Segment[] {
  const segments: Segment[] = []
  let cursor = 0
  for (const match of body.matchAll(/^```!\s*\r?\n([\s\S]*?)\r?\n```[ \t]*$|(^|\s)!`([^`\n]+)`/gmu)) {
    segments.push({ kind: 'text', text: body.slice(cursor, match.index) })
    segments.push(match[1] !== undefined ? { kind: 'shell', command: match[1], lead: '' } : { kind: 'shell', command: match[3] ?? '', lead: match[2] ?? '' })
    cursor = (match.index ?? 0) + match[0].length
  }
  segments.push({ kind: 'text', text: body.slice(cursor) })
  return segments
}

/** Render one body. */
export async function renderBody(body: string, context: RenderContext): Promise<RenderedBody> {
  const args = splitArguments(context.rawArguments)
  let consumed = false
  /** The value a placeholder stands for; undefined leaves it as written. */
  const valueOf = (match: string, variable: string | undefined, indexed: string | undefined, short: string | undefined, name: string | undefined): string | undefined => {
    if (variable !== undefined) return pathVariable(variable, context)
    if (match === '$ARGUMENTS') {
      consumed = true
      return context.rawArguments.trim()
    }
    const index = indexed ?? short
    if (index !== undefined) {
      const value = args[Number(index)]
      if (value === undefined) return undefined
      consumed = true
      return value
    }
    if (name !== undefined) {
      const position = context.argumentNames.indexOf(name)
      if (position === -1) return undefined
      consumed = true
      return args[position] ?? ''
    }
    return undefined
  }
  const substituteText = (text: string): string => text
    .replace(PLACEHOLDER, (match, variable: string | undefined, indexed: string | undefined, short: string | undefined, name: string | undefined) => {
      if (match === '\\$') return '\\$'
      return valueOf(match, variable, indexed, short, name) ?? match
    })
    .replace(/\\\$(?=\d|ARGUMENTS|[A-Za-z_])/gu, '$')

  const segments = segmentsOf(body)
  const references = segments.flatMap(segment => segment.kind === 'text' ? fileReferences(segment.text, context) : [])
  const kind = context.shellKind === 'powershell' ? 'powershell' : context.shell.defaultKind
  let commands = 0
  let text = ''
  for (const segment of segments) {
    if (segment.kind === 'text') {
      text += substituteText(segment.text)
      continue
    }
    if (context.refuseShell !== undefined) {
      text += segment.lead + shellNote(context.refuseShell)
      continue
    }
    const values: Record<string, string> = {}
    const line = shellCommand(segment.command, kind, (match, variable, indexed, short, name) => {
      const value = valueOf(match, variable, indexed, short, name)
      if (value === undefined) return undefined
      const key = `HF_ARG_${String(Object.keys(values).length)}`
      values[key] = value
      return key
    })
    if ('refused' in line) {
      text += segment.lead + shellNote(`${line.refused}, where Harness Forge cannot pass it safely`)
      continue
    }
    commands += 1
    text += segment.lead + await execute(line.command, kind, values, context)
  }
  const withArguments = !consumed && context.rawArguments.trim().length > 0
    ? `${text.trimEnd()}\n\nARGUMENTS: ${context.rawArguments.trim()}`
    : text
  const attached = attach(references, context)
  const allowed = { user: 'the workspace and ~/.claude', project: 'the workspace', plugin: 'the plugin and the workspace' }[context.scope ?? 'plugin']
  const notes = attached.refused.map(reference => `[Harness Forge: @${reference} was not attached: it is outside ${allowed}]`)
  return { text: [withArguments.trim(), ...notes].join('\n\n').trim(), files: attached.files, commands }
}

/**
 * A Codex custom prompt with its arguments, as Codex expands it: `$1`…`$9`
 * are the positional arguments, `$ARGUMENTS` all of them, `$NAME` the value
 * of `NAME=value`, `$$` a literal `$`. Codex runs no commands and attaches
 * no files from a prompt body.
 */
export function renderCodexPrompt(body: string, rawArguments: string): RenderedBody {
  const words = splitArguments(rawArguments)
  const named = new Map<string, string>()
  const positional: string[] = []
  for (const word of words) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/su.exec(word)
    if (match !== null) named.set(match[1] ?? '', match[2] ?? '')
    else positional.push(word)
  }
  const text = body.replace(/\$\$|\$ARGUMENTS\b|\$([1-9])|\$([A-Z][A-Z0-9_]*)/gu, (match, digit: string | undefined, name: string | undefined) => {
    if (match === '$$') return '$'
    if (match === '$ARGUMENTS') return positional.join(' ')
    if (digit !== undefined) return positional[Number(digit) - 1] ?? ''
    if (name !== undefined) return named.get(name) ?? match
    return match
  })
  return { text: text.trim(), files: [], commands: 0 }
}

/** Shell-style split: quotes group words; backslash escapes the next char. */
export function splitArguments(raw: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let started = false
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index] ?? ''
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else if (char === '\\' && quote === '"' && index + 1 < raw.length) current += raw[++index] ?? ''
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/u.test(char)) {
      if (started) args.push(current)
      current = ''
      started = false
    } else {
      if (char === '\\' && index + 1 < raw.length) current += raw[++index] ?? ''
      else current += char
      started = true
    }
  }
  if (started) args.push(current)
  return args
}

function pathVariable(name: string, context: RenderContext): string | undefined {
  const posix = (path: string | undefined): string | undefined => path?.replace(/\\/gu, '/')
  switch (name) {
    case 'CLAUDE_SKILL_DIR': return posix(context.skillDir)
    case 'CLAUDE_PROJECT_DIR': return posix(context.cwd)
    case 'CLAUDE_SESSION_ID': return context.sessionId
    case 'CLAUDE_PLUGIN_ROOT': return posix(context.pluginRoot)
    case 'CLAUDE_PLUGIN_DATA': return posix(context.dataDir)
    default: return undefined
  }
}

/** The environment variable that will hold a placeholder's value, or undefined to leave the placeholder as written. */
type ValueOf = (match: string, variable: string | undefined, indexed: string | undefined, short: string | undefined, name: string | undefined) => string | undefined

/** A shell line ready to run, or why it may not run. */
export type ShellLine = { readonly command: string } | { readonly refused: string }

/** Where a scan stands inside a shell line, innermost last. */
interface Frame {
  readonly kind: 'dq' | 'sq' | 'ansi' | 'backtick' | 'subst' | 'param' | 'comment' | 'heredoc' | 'arith' | 'cond' | 'herestring' | 'block-comment'
  /** Open parentheses of a `$(…)`; the delimiter of a here-document (undefined: it never ends); the closing mark of a here-string. */
  depth?: number
  readonly end?: string
  readonly strip?: boolean
}

const WHERE: Record<Frame['kind'], string> = {
  dq: 'double quotes',
  sq: 'single quotes',
  ansi: "ANSI-C quotes ($'…')",
  backtick: 'backticks',
  subst: 'a nested command or subexpression',
  param: 'a parameter expansion',
  comment: 'a comment',
  heredoc: 'a here-document',
  arith: 'an arithmetic expression',
  cond: 'a [[ ]] test',
  herestring: 'a here-string',
  'block-comment': 'a comment',
}

/** Words after which bash still expects a command name. */
const BASH_PREFIXES = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'fi', 'done', 'esac'])
/** bash builtins and keywords: none may take a value, apart from those in `argumentOf`. */
const BASH_BUILTINS = new Set(['.', ':', '[', 'alias', 'bg', 'bind', 'break', 'builtin', 'caller', 'case', 'cd', 'command', 'compgen', 'complete', 'compopt', 'continue', 'coproc', 'declare', 'dirs', 'disown', 'echo', 'enable', 'eval', 'exec', 'exit', 'export', 'false', 'fc', 'fg', 'for', 'function', 'getopts', 'hash', 'help', 'history', 'jobs', 'kill', 'let', 'local', 'logout', 'mapfile', 'popd', 'printf', 'pushd', 'pwd', 'read', 'readarray', 'readonly', 'return', 'select', 'set', 'shift', 'shopt', 'source', 'suspend', 'test', 'time', 'times', 'trap', 'true', 'type', 'typeset', 'ulimit', 'umask', 'unalias', 'unset', 'wait'])
/** Programs that run a command or code they are given. */
const RUNNERS = new Set(['env', 'sudo', 'doas', 'su', 'xargs', 'nohup', 'nice', 'ionice', 'timeout', 'stdbuf', 'setsid', 'chroot', 'unshare', 'nsenter', 'flock', 'watch', 'strace', 'ltrace', 'parallel', 'ssh', 'sed', 'awk', 'gawk', 'mawk', 'nawk', 'sh', 'bash', 'dash', 'zsh', 'ksh', 'mksh', 'fish', 'csh', 'tcsh', 'busybox', 'pwsh', 'powershell', 'cmd', 'python', 'python2', 'python3', 'perl', 'ruby', 'node', 'deno', 'bun', 'php', 'lua', 'tclsh', 'expect', 'script'])
/** PowerShell commands (and aliases) that run, load or define code they are given. */
const POWERSHELL_RUNNERS = new Set(['.', 'iex', 'invoke-expression', 'icm', 'invoke-command', 'saps', 'start', 'start-process', 'sajb', 'start-job', 'start-threadjob', 'ii', 'invoke-item', 'add-type', 'nmo', 'new-module', 'ipmo', 'import-module', 'foreach-object', 'where-object', 'sv', 'set-variable', 'nv', 'new-variable', 'si', 'set-item', 'ni', 'new-item'])
/** A `test` / `[` operator whose operand stays a plain string or file name (not `-v`, `-a`, `-o`, `!`). */
const TEST_OPERATOR = /^(?:-[bcdefghknprsStuwxzGLNO]|-(?:eq|ne|lt|le|gt|ge|nt|ot|ef)|==?|!=)$/u
/** A line that defines a function or alias, whose body may run its arguments. */
const DEFINES = { bash: /\bfunction\s|[\w.:-]\s*\(\s*\)|\balias\b/u, powershell: /\b(?:function|filter|workflow)\s|\b(?:set|new)-alias\b|\b(?:sal|nal)\b|\b(?:function|alias):/iu }

/**
 * Whether a value may stand in the word being read after `words` (the words
 * of the current simple command so far): only as an argument of a command
 * named by a plain word, not as the command itself or an assignment, and not
 * of a builtin or program that runs, evaluates or names what it is given.
 */
function argumentOf(words: readonly string[], kind: 'bash' | 'powershell'): boolean {
  const at = words.findIndex(word => kind === 'powershell' || !/^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/u.test(word))
  const name = words[at]
  if (at === -1 || name === undefined || name.startsWith('-')) return false
  const args = words.slice(at + 1)
  if (kind === 'powershell') {
    const command = basename(name.replace(/\\/gu, '/')).toLowerCase().replace(/\.exe$/u, '')
    return /^[\w./\\:+@,-]+$/u.test(name) && !POWERSHELL_RUNNERS.has(command) && !RUNNERS.has(command)
      && !args.some(arg => /^-(?:c|command|e|ec|encodedcommand|sb|scriptblock|cwa|commandwithargs)$/iu.test(arg))
  }
  if (!/^[\w./:+@,-]+$|^\[$/u.test(name)) return false
  const command = basename(name)
  if (RUNNERS.has(command) || (command === 'find' && args.some(arg => /^-(?:exec|execdir|ok|okdir)$/u.test(arg)))) return false
  if (!BASH_BUILTINS.has(name)) return true
  switch (name) {
    case 'echo': case 'cd': case 'pushd': case 'pwd': case 'true': case 'false': case ':': return true
    // `printf -v NAME` evaluates NAME; so would a value standing as the format.
    case 'printf': return args.length > 0 && !args.includes('-v')
    case 'test': case '[': return TEST_OPERATOR.test(args.at(-1) ?? '')
    default: return false
  }
}

/**
 * A shell line with each placeholder replaced by a reference to an
 * environment variable holding its value. Values never enter the source: a
 * reference is written only where it provably stays one word of data (bash:
 * unquoted or inside plain double quotes; PowerShell: outside quotes or inside
 * plain double quotes), and only in an argument of a simple command that does
 * not run it (see `argumentOf`), in a line that defines no function or alias.
 * A placeholder anywhere else (single or ANSI-C quotes, here-documents and
 * here-strings, backticks, `$(…)`, parameter expansions, arithmetic, `[[ ]]`,
 * comments, the command position, an assignment, the arguments of `eval` and
 * the like) makes the whole line refused. `\$` stays as written, for the shell.
 */
export function shellCommand(command: string, kind: 'bash' | 'powershell', value: ValueOf): ShellLine {
  const stack: Frame[] = []
  const heredocs: Frame[] = []
  const placeholder = new RegExp(PLACEHOLDER.source, 'uy')
  const single = kind === 'powershell' ? /['\u2018\u2019\u201A\u201B]/u : /'/u
  const double = kind === 'powershell' ? /["\u201C\u201D\u201E]/u : /"/u
  const escape = kind === 'bash' ? '\\' : '`'
  let out = ''
  let index = 0
  const take = (count: number): void => {
    out += command.slice(index, index + count)
    index += count
  }
  const wordStart = (): boolean => index === 0 || /[\s;&|(<>]/u.test(command[index - 1] ?? '')
  const lineStart = (): boolean => index === 0 || command[index - 1] === '\n'
  // The words of the current simple command, read at the top level only.
  let words: string[] = []
  let wordAt: number | undefined
  const endWord = (): void => {
    if (wordAt === undefined) return
    const word = command.slice(wordAt, index)
    if (!(kind === 'bash' && words.length === 0 && BASH_PREFIXES.has(word))) words.push(word)
    wordAt = undefined
  }
  const separates = (char: string, next: string): boolean => {
    const previous = command[index - 1] ?? ''
    if (/[\n;()]/u.test(char)) return true
    if (kind === 'powershell') return /[{}|]/u.test(char) || (char === '&' && (next === '&' || previous === '&'))
    return (char === '|' && previous !== '>') || (char === '&' && !/[<>]/u.test(previous) && next !== '>')
  }
  while (index < command.length) {
    const frame = stack.at(-1)
    const char = command[index] ?? ''
    const next = command[index + 1] ?? ''
    // A here-document (bash) or here-string (PowerShell) body ends at its own line.
    if ((frame?.kind === 'heredoc' || frame?.kind === 'herestring') && lineStart()) {
      const end = command.indexOf('\n', index)
      const line = command.slice(index, end === -1 ? command.length : end)
      const closes = frame.kind === 'heredoc' ? frame.end !== undefined && (frame.strip === true ? line.replace(/^\t+/u, '') : line) === frame.end : line.startsWith(frame.end ?? '\0')
      if (closes) {
        stack.pop()
        take(frame.kind === 'heredoc' ? line.length : (frame.end ?? '').length)
        continue
      }
    }
    if (stack.length === 0) {
      if (/[ \t\r]/u.test(char)) endWord()
      else if (separates(char, next)) {
        endWord()
        words = []
      } else wordAt ??= index
    }
    if (char === '$' || char === '\\') {
      placeholder.lastIndex = index
      const match = placeholder.exec(command)
      if (match !== null && match[0] === '\\$') {
        take(2)
        continue
      }
      if (match !== null) {
        const key = value(match[0], match[1], match[2], match[3], match[4])
        if (key !== undefined) {
          if (frame !== undefined && !(stack.length === 1 && frame.kind === 'dq')) return { refused: `an argument or path variable stands inside ${WHERE[frame.kind]}` }
          if (!argumentOf(words, kind) || DEFINES[kind].test(command)) return { refused: 'an argument or path variable stands where it is not plainly an argument of a command' }
          out += kind === 'powershell' ? `\${env:${key}}` : frame === undefined ? `"\${${key}}"` : `\${${key}}`
          index += match[0].length
          continue
        }
      }
    }
    if (frame?.kind === 'heredoc' || frame?.kind === 'herestring') {
      take(1)
      continue
    }
    if (frame?.kind === 'comment') {
      // The line break ends the comment and is read again as code.
      if (char === '\n') stack.pop()
      else take(1)
      continue
    }
    if (frame?.kind === 'block-comment') {
      if (char === '#' && next === '>') {
        stack.pop()
        take(2)
      } else take(1)
      continue
    }
    if (frame?.kind === 'sq') {
      if (kind === 'powershell' && single.test(char) && single.test(next)) take(2)
      else {
        if (single.test(char)) stack.pop()
        take(1)
      }
      continue
    }
    if (frame?.kind === 'ansi' || frame?.kind === 'backtick' || frame?.kind === 'param') {
      if (char === '\\' && index + 1 < command.length) take(2)
      else {
        const closes = frame.kind === 'ansi' ? char === "'" : frame.kind === 'backtick' ? char === '`' : char === '}'
        if (closes) stack.pop()
        else if (frame.kind === 'param' && char === '$' && next === '{') stack.push({ kind: 'param' })
        take(closes || !(char === '$' && next === '{') ? 1 : 2)
      }
      continue
    }
    if (char === escape && index + 1 < command.length) {
      take(2)
      continue
    }
    if (frame?.kind === 'dq') {
      if (double.test(char)) {
        if (kind === 'powershell' && double.test(next)) take(2)
        else {
          stack.pop()
          take(1)
        }
      } else if (char === '$' && next === '(') {
        stack.push({ kind: 'subst', depth: 0 })
        take(2)
      } else if (char === '$' && next === '{') {
        stack.push({ kind: 'param' })
        take(2)
      } else if (kind === 'bash' && char === '`') {
        stack.push({ kind: 'backtick' })
        take(1)
      } else take(1)
      continue
    }
    if ((frame?.kind === 'arith' || frame?.kind === 'cond') && frame.end !== undefined && command.startsWith(frame.end, index)) {
      stack.pop()
      // A `let` ends at a separator, read again as code.
      if (!/^[;&|\n]$/u.test(frame.end)) take(frame.end.length)
      continue
    }
    // Code: the top level, a `$(…)`, an arithmetic expression or a `[[ ]]` test.
    if (char === '\n' && heredocs.length > 0) {
      take(1)
      stack.push(...heredocs.splice(0).reverse())
      continue
    }
    if (kind === 'powershell' && char === '@' && (single.test(next) || double.test(next)) && /^[ \t]*\r?\n/u.test(command.slice(index + 2))) {
      stack.push({ kind: 'herestring', end: single.test(next) ? `'@` : `"@` })
      take(2)
      continue
    }
    if (kind === 'powershell' && char === '<' && next === '#') {
      stack.push({ kind: 'block-comment' })
      take(2)
      continue
    }
    if (kind === 'bash' && char === '$' && next === "'") {
      stack.push({ kind: 'ansi' })
      take(2)
      continue
    }
    if (char === '$' && (next === '(' || next === '{' || (kind === 'bash' && next === '['))) {
      stack.push(next === '(' ? { kind: 'subst', depth: 0 } : next === '{' ? { kind: 'param' } : { kind: 'arith', end: ']' })
      take(2)
      continue
    }
    if (single.test(char)) stack.push({ kind: 'sq' })
    else if (double.test(char)) stack.push({ kind: 'dq' })
    else if (kind === 'bash' && char === '`') stack.push({ kind: 'backtick' })
    else if (char === '#' && wordStart()) stack.push({ kind: 'comment' })
    else if (kind === 'bash' && wordStart() && char === '(' && next === '(') {
      stack.push({ kind: 'arith', end: '))' })
      take(2)
      continue
    } else if (kind === 'bash' && wordStart() && char === '[' && next === '[') {
      stack.push({ kind: 'cond', end: ']]' })
      take(2)
      continue
    } else if (kind === 'bash' && /(?:^|[;&|(\n])[ \t]*$/u.test(command.slice(0, index)) && /^let\b/u.test(command.slice(index))) {
      // `let` evaluates its arguments as arithmetic, to the end of the command (undefined: the end of the line).
      const end = /[;&|\n]/u.exec(command.slice(index))?.[0]
      stack.push({ kind: 'arith', ...(end !== undefined ? { end } : {}) })
    } else if (kind === 'bash' && char === '<' && next === '<' && command[index + 2] !== '<') {
      // A here-document: its body starts after this line and ends at the delimiter.
      const operator = /^<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z0-9_.-]+))/u.exec(command.slice(index))
      heredocs.push({ kind: 'heredoc', strip: operator?.[1] === '-', ...(operator !== null ? { end: operator[2] ?? operator[3] ?? operator[4] ?? '' } : {}) })
      take(operator?.[0].length ?? 2)
      continue
    } else if (kind === 'bash' && char === '<' && next === '<') {
      take(3)
      continue
    } else if (frame?.kind === 'subst' && char === '(') frame.depth = (frame.depth ?? 0) + 1
    else if (frame?.kind === 'subst' && char === ')') {
      if ((frame.depth ?? 0) === 0) stack.pop()
      else frame.depth = (frame.depth ?? 0) - 1
    }
    take(1)
  }
  return { command: out }
}

async function execute(command: string, kind: 'bash' | 'powershell', values: Readonly<Record<string, string>>, context: RenderContext): Promise<string> {
  const result = await context.shell.runShell(command, kind, {
    cwd: context.cwd,
    timeoutMs: COMMAND_TIMEOUT_MS,
    env: {
      ...values,
      ...(context.pluginRoot !== undefined ? { CLAUDE_PLUGIN_ROOT: context.pluginRoot.replace(/\\/gu, '/') } : {}),
      ...(context.dataDir !== undefined ? { CLAUDE_PLUGIN_DATA: context.dataDir.replace(/\\/gu, '/') } : {}),
      CLAUDE_PROJECT_DIR: context.cwd.replace(/\\/gu, '/'),
    },
    ...(context.signal !== undefined ? { signal: context.signal } : {}),
  })
  if (result.startError !== undefined) return `[command failed: ${result.startError}]`
  // Claude Code merges stderr into stdout for injected commands.
  return `${result.stdout}${result.stderr}`.trimEnd()
}

/**
 * The `@path` references of a template's prose, with path variables expanded.
 * A reference built from an argument is not one: what the person typed stays text.
 */
function fileReferences(text: string, context: RenderContext): string[] {
  const found: string[] = []
  for (const match of text.matchAll(/(?:^|\s)@([^\s`'"()<>]+)/gmu)) {
    const raw = (match[1] ?? '').replace(/[.,;:]+$/u, '')
    if (!/[/\\.]/u.test(raw)) continue
    let fromArgument = false
    const reference = raw.replace(PLACEHOLDER, (whole, variable: string | undefined) => {
      if (variable !== undefined) return pathVariable(variable, context) ?? whole
      if (whole !== '\\$') fromArgument = true
      return whole
    })
    if (!fromArgument) found.push(reference)
  }
  return found
}

/**
 * Read the referenced files that lie where the template may reach; name the
 * others. A project's template reaches the workspace only; a plugin's its own
 * directory and the workspace; only the person's own templates reach `~/.claude`.
 */
function attach(references: readonly string[], context: RenderContext): { files: Array<{ path: string; content: string }>; refused: string[] } {
  const home = context.home ?? homedir()
  const scope = context.scope ?? 'plugin'
  const roots = [workspaceRootOf(context.cwd), ...scope === 'project' ? [] : [context.pluginRoot, context.skillDir], ...scope === 'user' ? [join(home, '.claude')] : []]
    .filter((root): root is string => root !== undefined)
    .map(realOrLexical)
  const files: Array<{ path: string; content: string }> = []
  const refused: string[] = []
  const seen = new Set<string>()
  for (const reference of references) {
    const path = reference.startsWith('~/') ? join(home, reference.slice(2)) : isAbsolute(reference) ? reference : resolve(context.cwd, reference)
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(path)
    } catch {
      continue // A missing file stays literal text, as in Claude Code.
    }
    const real = realOrLexical(path)
    if (seen.has(real) || !stat.isFile() || stat.size > FILE_LIMIT) continue
    seen.add(real)
    if (!roots.some(root => isInside(root, real))) {
      refused.push(reference)
      continue
    }
    try {
      files.push({ path: reference, content: readFileSync(real, 'utf8') })
    } catch {
      // Unreadable references stay as literal text, as in Claude Code.
    }
  }
  return { files, refused }
}

/** Append `@` attachments to a rendered prompt. */
export function withAttachments(rendered: RenderedBody): string {
  if (rendered.files.length === 0) return rendered.text
  return [rendered.text, ...rendered.files.map(file => `<file path="${file.path}">\n${file.content}\n</file>`)].join('\n\n')
}
