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
import { isInside, linksReachNewShare, reachesNewShare, realOrLexical, stripTrailing, workspaceRootOf } from '@kirkchinese/harness-forge-core'
import { redirectFiles } from '../hooks/condition.js'
import { powershellCommand } from '../hooks/powershell-aliases.js'
import { powershellAmpersand } from '../hooks/shell-commands.js'
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
  // A scan in one pass: the equivalent pattern reads to the end of the body from every unclosed fence.
  const segments: Segment[] = []
  const breaks = /[\n\r\u2028\u2029]/u
  const lineStart = (at: number): boolean => at === 0 || breaks.test(body[at - 1] ?? '')
  let cursor = 0
  /** Fences cannot close at or after this index (a search from there found no closing line). */
  let unclosedFrom = body.length + 1
  let tick = -1
  let newline = -1
  const take = (at: number, end: number, segment: Segment): number => {
    segments.push({ kind: 'text', text: body.slice(cursor, at) }, segment)
    cursor = end
    return end
  }
  for (let at = 0; at < body.length;) {
    if (lineStart(at) && body.startsWith('```!', at)) {
      const fence = fenceAt(body, at, unclosedFrom)
      if (fence !== undefined && 'unclosedFrom' in fence) unclosedFrom = fence.unclosedFrom
      else if (fence !== undefined) {
        at = take(at, fence.end, { kind: 'shell', command: fence.command, lead: '' })
        continue
      }
    }
    const bang = lineStart(at) && body[at] === '!' ? at : /\s/u.test(body[at] ?? '') && body[at + 1] === '!' ? at + 1 : -1
    if (bang !== -1 && body[bang + 1] === '`') {
      if (tick < bang + 2) tick = body.indexOf('`', bang + 2)
      if (newline < bang + 2) newline = body.indexOf('\n', bang + 2)
      if (tick > bang + 2 && (newline === -1 || tick < newline)) {
        at = take(at, tick + 1, { kind: 'shell', command: body.slice(bang + 2, tick), lead: body.slice(at, bang) })
        continue
      }
    }
    at++
  }
  segments.push({ kind: 'text', text: body.slice(cursor) })
  return segments
}

/**
 * The fenced ```` ```! ```` block opening at `at`: the opener line, its body,
 * and a closing line of three backticks and blanks.
 */
function fenceAt(body: string, at: number, unclosedFrom: number): { command: string; end: number } | { unclosedFrom: number } | undefined {
  let index = at + 4
  while (body[index] === ' ' || body[index] === '\t') index++
  if (body[index] === '\r') index++
  if (body[index] !== '\n') return undefined
  const start = index + 1
  if (start - 1 >= unclosedFrom) return undefined
  for (let search = start - 1; ;) {
    const close = body.indexOf('\n```', search)
    if (close === -1) return { unclosedFrom: start - 1 }
    let end = close + 4
    while (body[end] === ' ' || body[end] === '\t') end++
    if (end === body.length || /[\n\r\u2028\u2029]/u.test(body[end] ?? '')) {
      // The body ends before the `\r?\n` of the closing line, whose own line break stays outside the fence.
      if (close >= start) return { command: body.slice(start, close > start && body[close - 1] === '\r' ? close - 1 : close), end }
    }
    search = close + 1
  }
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
  // Every shell line is read before any runs: what one line writes, a later one may run (see `writesThenRuns`).
  type Prepared = { readonly refused: string } | { readonly line: Extract<ShellLine, { command: string }>; readonly values: Readonly<Record<string, string>> } | undefined
  const lines = segments.map((segment): Prepared => {
    if (segment.kind === 'text' || context.refuseShell !== undefined) return undefined
    const values: Record<string, string> = {}
    const line = shellCommand(segment.command, kind, (match, variable, indexed, short, name) => {
      const value = valueOf(match, variable, indexed, short, name)
      if (value === undefined) return undefined
      const key = `HF_ARG_${String(Object.keys(values).length)}`
      values[key] = value
      return key
    })
    if ('refused' in line) return { refused: `${line.refused}, where Harness Forge cannot pass it safely` }
    if (line.operands.some(key => values[key]?.startsWith('-') === true)) return { refused: 'a value starts with "-" where the program would read it as an option' }
    return { line, values }
  })
  const runs = lines.flatMap(entry => entry !== undefined && 'line' in entry ? [entry.line] : [])
  // The lines that run, in order, as one sequence; each line's constructs are its own.
  const bodySteps = runs.flatMap((line, at) => line.steps.map(step => ({ ...step, groups: step.groups.map(group => `${String(at)}:${group}`) })))
  const bodyRefused = runs.some(line => line.chosen) && writesThenRuns(bodySteps) ? WRITE_THEN_RUN : undefined
  let commands = 0
  let text = ''
  for (const [at, segment] of segments.entries()) {
    if (segment.kind === 'text') {
      text += substituteText(segment.text)
      continue
    }
    const entry = lines[at]
    const refused = context.refuseShell ?? (entry === undefined ? undefined : 'refused' in entry ? entry.refused : bodyRefused)
    if (refused !== undefined || entry === undefined || !('line' in entry)) {
      text += segment.lead + shellNote(refused ?? '')
      continue
    }
    commands += 1
    text += segment.lead + await execute(entry.line.command, kind, entry.values, context)
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

/**
 * A shell line ready to run, or why it may not run. `operands` names the
 * variables whose value starts a word where a program reads options: the
 * line may run only if none of those values starts with `-`.
 */
export type ShellLine = {
  readonly command: string
  readonly operands: readonly string[]
  /** Its simple commands, for the write-then-run check across the shell lines of one body. */
  readonly steps: readonly ShellStep[]
  /** It carries a value someone chose (an argument; not a path variable the host sets). */
  readonly chosen: boolean
} | { readonly refused: string }

/** Where a value stands: not allowed, as an argument, or as an operand that must not start with `-`. */
type Placement = 'refused' | 'argument' | 'operand'


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
/**
 * Programs whose purpose is to run a command, code, package, container, task or
 * file named by their arguments: no value anywhere on their line. Interpreters
 * and shells are recognised by {@link FAMILIES} however they are spelled; the
 * ones repeated here are only the exact names.
 */
/**
 * Wrappers that run the command given after their options, with other rights,
 * limits, timing or environment. Those in {@link WRAPPERS} are resolved to the
 * command they run where a line is checked for a program that reads code or
 * runs a package manager; any other one counts as both.
 */
const WRAPPING_RUNNERS = new Set(['env', 'sudo', 'doas', 'su', 'runuser', 'pkexec', 'sg', 'nohup', 'nice', 'ionice', 'chrt', 'taskset', 'numactl', 'cpulimit', 'prlimit', 'setpriv', 'timeout', 'time', 'chronic', 'stdbuf', 'unbuffer', 'rlwrap', 'setsid', 'chroot', 'unshare', 'nsenter', 'flock', 'fakeroot', 'faketime', 'firejail', 'bwrap', 'systemd-run', 'dbus-run-session', 'xvfb-run', 'caffeinate', 'strace', 'ltrace', 'valgrind', 'gdb', 'lldb', 'script', 'expect'])
const RUNNERS = new Set([
  ...WRAPPING_RUNNERS,
  // Watchers and benchmark tools that run a command again and again.
  'watch', 'watchexec', 'entr', 'nodemon', 'hyperfine',
  // Programs that build commands from their arguments or input, or run them elsewhere.
  'xargs', 'parallel', 'ssh',
  // Text tools with a programming language of their own.
  'sed', 'awk', 'gawk', 'mawk', 'nawk',
  // JavaScript package and TypeScript runners: they run a package or file they are given. (`npm`, `pnpm`, `yarn`: see PACKAGE_MANAGERS.)
  'npx', 'pnpx', 'bunx', 'corepack', 'tsx', 'ts-node', 'ts-node-esm', 'vite-node', 'esno',
  // Python package runners.
  'uvx',
  // Build and task runners: a value picks the makefile, the target or a variable a recipe expands.
  'make', 'gmake', 'bmake', 'just', 'task',
  // Build tools, test and task runners that run the project's build files, scripts or tasks, named by their arguments.
  'mvn', 'mvnw', 'gradle', 'gradlew', 'ant', 'sbt', 'rake', 'ninja', 'bazel', 'bazelisk', 'scons', 'meson', 'cmake', 'ctest', 'dotnet', 'msbuild', 'tox', 'nox', 'grunt', 'gulp', 'nx', 'turbo', 'lerna',
  // Tool version managers: they run the tool a version or an argument picks.
  'mise', 'asdf', 'volta', 'nvm', 'fnm', 'pyenv', 'rbenv', 'nodenv',
  // Interpreters and shells by exact name (FAMILIES covers every spelling).
  'sh', 'bash', 'dash', 'zsh', 'ksh', 'mksh', 'fish', 'csh', 'tcsh', 'busybox', 'pwsh', 'powershell', 'cmd', 'python', 'python2', 'python3', 'perl', 'ruby', 'node', 'deno', 'bun', 'php', 'lua', 'tclsh',
])
/** Docker's (and Podman's and nerdctl's) subcommands that list or inspect containers, images, volumes and networks. */
const CONTAINER_QUERIES: readonly string[] = [
  'ps', 'images', 'logs', 'inspect', 'top', 'port', 'stats', 'history', 'version', 'info', 'search',
  'container ls', 'container list', 'container ps', 'container inspect', 'container logs', 'container top', 'container port', 'container stats',
  'image ls', 'image list', 'image inspect', 'image history', 'volume ls', 'volume inspect', 'network ls', 'network inspect',
]
/**
 * Package managers and container or cluster tools, with the only subcommands
 * in which they take a value: each lists packages, metadata, containers or
 * resources and runs no package, lifecycle or build script, project task,
 * container or plugin named by its arguments (checked against each tool's
 * reference below). A subcommand of more than one word is written with
 * blanks. Every other subcommand (`install`, `add`, `run`, `exec`, `test`,
 * `build`, `x`, `dlx`, a script name …), a missing or dynamic one, and options
 * before it refuse a value anywhere on the line; in an allowed subcommand the
 * value must be an operand (see `packageOperand`).
 */
const PACKAGE_MANAGERS: Readonly<Record<string, readonly string[]>> = {
  // https://docs.npmjs.com/cli/commands (with aliases). Not `docs`, `bugs`, `repo`, `home` or `help`: they start the
  // configured browser or viewer, on a URL the package's metadata chooses.
  npm: ['view', 'info', 'show', 'v', 'search', 'find', 's', 'se', 'ls', 'list', 'la', 'll', 'outdated', 'explain', 'why'],
  // https://pnpm.io/cli/list, /cli/why, /cli/outdated. Any other word may run the project script of that name.
  pnpm: ['list', 'ls', 'll', 'la', 'why', 'outdated'],
  // https://yarnpkg.com/cli/info, /cli/why (also Yarn 1). Yarn 2+ runs a script or binary for any unknown word, `list` included.
  yarn: ['info', 'why'],
  // Bun is a JavaScript runtime as well (see FAMILIES): no subcommand takes a value.
  bun: [],
  // https://docs.astral.sh/uv/reference/cli/#uv-pip: these read the installed environment and build nothing.
  uv: ['pip show', 'pip list', 'pip freeze', 'pip tree'],
  // https://pip.pypa.io/en/stable/cli/: these read installed metadata; `download`, `wheel` and `install` may build.
  pip: ['show', 'list', 'freeze', 'check'],
  // https://pipx.pypa.io/stable/docs/
  pipx: ['list'],
  // https://python-poetry.org/docs/cli/
  poetry: ['show', 'search'],
  // https://doc.rust-lang.org/cargo/commands/: these read the registry or the lock file and run no build script.
  cargo: ['search', 'tree', 'info'],
  // https://pkg.go.dev/cmd/go: `go version FILE` reads a binary without running it.
  go: ['doc', 'list', 'version'],
  // https://guides.rubygems.org/command-reference/
  gem: ['list', 'search', 'info', 'contents', 'dependency'],
  // https://bundler.io/man/bundle-list.1.html, /bundle-info.1.html
  bundle: ['list', 'info'],
  // https://getcomposer.org/doc/03-cli.md
  composer: ['show', 'info', 'search', 'depends', 'why', 'prohibits', 'why-not', 'outdated', 'licenses'],
  // https://docs.docker.com/reference/cli/docker/ (Podman and nerdctl follow it): listing and inspecting only.
  docker: CONTAINER_QUERIES,
  podman: CONTAINER_QUERIES,
  nerdctl: CONTAINER_QUERIES,
  // https://kubernetes.io/docs/reference/kubectl/: reading resources only; an unknown word runs a `kubectl-*` plugin.
  kubectl: ['get', 'describe', 'logs', 'explain', 'version', 'api-resources', 'api-versions', 'top', 'config view'],
  // https://docs.conda.io/projects/conda/en/stable/commands/index.html
  conda: ['list', 'search', 'info'],
  mamba: ['list', 'search', 'info'],
  micromamba: ['list', 'search', 'info'],
  // Homebrew evaluates a formula's Ruby code (tapping its repository first) to describe it; PDM, Hatch, Rye and
  // pixi run project scripts by name: none takes a value.
  brew: [],
  pdm: [],
  hatch: [],
  rye: [],
  pixi: [],
  // https://manpages.debian.org/apt-cache, /apt: queries of the package lists.
  'apt-cache': ['show', 'search', 'policy', 'depends', 'rdepends', 'showpkg'],
  apt: ['show', 'search', 'list', 'policy'],
  'apt-get': [],
  // https://dnf.readthedocs.io/en/latest/command_ref.html
  dnf: ['info', 'list', 'search'],
  yum: ['info', 'list', 'search'],
  // Their queries are options (`pacman -Q`), which no value may follow.
  pacman: [],
  apk: [],
  zypper: [],
}
/**
 * A wrapper whose documented synopsis is `<name> [options] [operands] <command> [arguments]`: it runs the
 * command after its options, so the command is what reads a stream or runs a package manager.
 */
interface Wrapper {
  /** Options that take no value, exactly as written. */
  readonly flags: readonly string[]
  /** Options that take a value: the next word, or attached (`-n5`, `--adjustment=5`). */
  readonly valued: readonly string[]
  /** Fixed operands between the options and the command (`timeout`'s duration). */
  readonly operands?: number
  /** `NAME=value` words may follow the options (`env`). */
  readonly assignments?: boolean
  /** A bash builtin, not a program: only bash has it. */
  readonly builtin?: boolean
}
/**
 * The wrappers resolved to the command they run. Any other option, a combined
 * one (`-cl`) or a dynamic word makes the wrapper unresolvable, and an
 * unresolvable wrapper (as every other one in {@link RUNNERS}, `sudo` and the
 * like) counts as a program that reads code and runs packages.
 */
const WRAPPERS: Readonly<Record<string, Wrapper>> = {
  // https://www.gnu.org/software/bash/manual/bash.html#Bash-Builtins: `command [-pVv] command [arguments]`
  // (`-v`/`-V` only describe, so they are left unresolved), `builtin [shell-builtin [args]]`,
  // `exec [-cl] [-a name] [command [arguments]]`.
  command: { flags: ['-p'], valued: [], builtin: true },
  builtin: { flags: [], valued: [], builtin: true },
  exec: { flags: ['-c', '-l'], valued: ['-a'], builtin: true },
  // https://www.gnu.org/software/coreutils/manual/html_node/env-invocation.html (`-S` splits a string: unresolved).
  env: { flags: ['-', '-i', '--ignore-environment', '-0', '--null', '-v', '--debug'], valued: ['-u', '--unset', '-C', '--chdir', '-a', '--argv0'], assignments: true },
  // https://www.gnu.org/software/coreutils/manual/html_node/nice-invocation.html, /nohup-invocation.html,
  // /timeout-invocation.html and /stdbuf-invocation.html.
  nice: { flags: [], valued: ['-n', '--adjustment'] },
  nohup: { flags: [], valued: [] },
  timeout: { flags: ['--preserve-status', '--foreground', '-v', '--verbose'], valued: ['-s', '--signal', '-k', '--kill-after'], operands: 1 },
  stdbuf: { flags: [], valued: ['-i', '--input', '-o', '--output', '-e', '--error'] },
  // bash's `time [-p]` (https://www.gnu.org/software/bash/manual/bash.html#Pipelines) and GNU time
  // (https://www.gnu.org/software/time/manual/time.html#Invoking-time).
  time: { flags: ['-p', '--portability', '-a', '--append', '-q', '--quiet', '-v', '--verbose'], valued: ['-f', '--format', '-o', '--output'] },
  // util-linux setsid(1): https://man7.org/linux/man-pages/man1/setsid.1.html
  setsid: { flags: ['-c', '--ctty', '-f', '--fork', '-w', '--wait'], valued: [] },
}
/** `sed` and `awk`: the program is an argument; it comes from a stream only through `-f` (`--file`, gawk's `-E`/`--exec`). */
const PROGRAM_FILE_OPTION = /^(?:-[fE]|--file|--exec)(?:=?(.*))?$/u
/** A path that names standard input, or a process substitution. */
const STDIN_PATH = /^(?:-|\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0|<\()$/u
/** PowerShell runners whose script block is fixed and whose pipeline input is data. */
const POWERSHELL_PIPELINE_BLOCKS = new Set(['foreach-object', 'where-object'])
/** PowerShell cmdlets that run, load or define code they are given; an alias is read as its cmdlet (see `programName`). */
const POWERSHELL_RUNNERS = new Set(['.', 'invoke-expression', 'invoke-command', 'start-process', 'start-job', 'start-threadjob', 'invoke-item', 'add-type', 'new-module', 'import-module', 'foreach-object', 'where-object', 'set-variable', 'new-variable', 'set-item', 'new-item', 'invoke-history'])
/** A `test` / `[` operator whose operand stays a plain string or file name (not `-v`, `-a`, `-o`, `!`). */
const TEST_OPERATOR = /^(?:-[bcdefghknprsStuwxzGLNO]|-(?:eq|ne|lt|le|gt|ge|nt|ot|ef)|==?|!=)$/u
/** A line that defines a function or alias, whose body may run its arguments. */
const DEFINES = { bash: /\bfunction\s|[\w.:-]\s*\(\s*\)|\balias\b/u, powershell: /\b(?:function|filter|workflow)\s|\b(?:set|new)-alias\b|\b(?:sal|nal)\b|\b(?:function|alias):/iu }

/** Path variables the host sets: never user or model input. */
const HOST_VARIABLE = /\$\{(?:CLAUDE_SKILL_DIR|CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA)\}/gu
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/u

/**
 * A word that stays exactly one word: plain characters and quotes around
 * text that expands nothing, with host path variables anywhere in it. No
 * `$`, glob, brace or splat that could make it vanish or split.
 */
function fixedWord(word: string): boolean {
  return /^(?:[\w./:+%=~-]|"[^"$`\\]*"|'[^']*')+$/u.test(word.replace(HOST_VARIABLE, ''))
}

/** A word as the shell reads it, without its quotes (and, in bash, its escapes). */
function unquote(word: string, kind: 'bash' | 'powershell' = 'bash'): string {
  return word.replace(kind === 'bash' ? /["'\\]/gu : /["'`]/gu, '')
}

/** A program's file name as a rule knows it: base name, lower case, no Windows executable extension. */
function programName(word: string, kind: 'bash' | 'powershell'): string {
  const plain = unquote(word, kind)
  // A bare PowerShell name may be an alias: read it as its cmdlet, through every alias PowerShell defines anywhere.
  if (kind === 'powershell' && /^[^/\\.]+$/u.test(plain)) return powershellCommand(plain, 'all')
  return basename(kind === 'powershell' ? plain.replace(/\\/gu, '/') : plain).toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/u, '')
}

/**
 * A script interpreter whose documented invocation is `<name> [options] <script> [arguments]`:
 * it reads no option after the script, and every later word reaches the script as an argument.
 */
interface Interpreter {
  /** The options that may stand before the script, exactly as written. */
  readonly options: readonly string[]
  /** Words in the script's place that the interpreter reads as something else. */
  readonly notScript?: readonly string[]
}

const NO_OPTIONS: Interpreter = { options: [] }
const INTERPRETERS: Readonly<Record<string, Interpreter>> = {
  // https://nodejs.org/api/cli.html#synopsis: `node [options] [V8 options] [<program-entry-point> | -e "script" | -] [--] [arguments]`;
  // `node inspect …` starts the debugger. The options listed take no value and load no code.
  node: { options: ['--no-warnings', '--no-deprecation', '--enable-source-maps', '--trace-warnings', '--trace-uncaught'], notScript: ['inspect'] },
  // https://docs.python.org/3/using/cmdline.html#interface-options: the script "terminates the list of options consumed by the
  // interpreter, all consecutive arguments will end up in sys.argv". The options listed take no value; PyPy takes CPython's.
  python: { options: ['-B', '-E', '-I', '-P', '-q', '-s', '-S', '-u'] },
  // https://www.gnu.org/software/bash/manual/bash.html#Invoking-Bash, https://pubs.opengroup.org/onlinepubs/9799919799/utilities/sh.html
  // and https://zsh.sourceforge.io/Doc/Release/Invocation.html: the first argument after the options names the script and the
  // rest become its positional parameters. No options: `-s`, `-c`, `-i`, `-o` and the like change what runs.
  bash: NO_OPTIONS,
  sh: NO_OPTIONS,
  zsh: NO_OPTIONS,
  // https://perldoc.perl.org/perlrun#SYNOPSIS and https://docs.ruby-lang.org/en/master/ruby/options_md.html: the words after the
  // program file are its @ARGV / ARGV. No options, so `-s` (which reads them as switches) cannot occur.
  perl: NO_OPTIONS,
  ruby: NO_OPTIONS,
}
/**
 * Every interpreter, script host and shell, by root name, and the family it
 * belongs to. Only the families in {@link INTERPRETERS} take a value, in their
 * verified form; every other family takes none anywhere on its line (`java`
 * runs the class or `-jar` it is given, the rest run code or files likewise).
 */
const FAMILIES: Readonly<Record<string, string>> = {
  python: 'python', py: 'python', pypy: 'python',
  node: 'node', nodejs: 'node', bun: 'bun', deno: 'deno',
  perl: 'perl', ruby: 'ruby', irb: 'irb',
  php: 'php', lua: 'lua', luajit: 'luajit', rscript: 'r', r: 'r', osascript: 'osascript', tclsh: 'tclsh', wish: 'wish',
  jshell: 'jshell', jrunscript: 'jrunscript', groovy: 'groovy', java: 'java',
  awk: 'awk', gawk: 'awk', mawk: 'awk', nawk: 'awk',
  bash: 'bash', sh: 'sh', zsh: 'zsh', dash: 'dash', ksh: 'ksh', mksh: 'mksh', fish: 'fish', csh: 'csh', tcsh: 'tcsh', ash: 'ash', busybox: 'busybox',
  pwsh: 'pwsh', powershell: 'powershell', cmd: 'cmd', wscript: 'wscript', cscript: 'cscript', mshta: 'mshta',
  // Windows programs that start a shell or run the command, file or library they are given.
  wsl: 'wsl', wt: 'wt', runas: 'runas', rundll32: 'rundll32', regsvr32: 'regsvr32', forfiles: 'forfiles', msiexec: 'msiexec',
}
/** Families with a Windows GUI variant named with a trailing `w` (`pythonw`, `pyw`, `javaw`, `rubyw`). */
const GUI_VARIANTS = new Set(['python', 'java', 'ruby'])
/** Roots long enough to recognise by prefix and a version (`python3-dbg`, `luajit-2.1`); shorter ones (`r`, `py`, `sh`) only exactly or with a version. */
const PREFIX_ROOTS = Object.keys(FAMILIES).filter(root => root.length >= 4).sort((left, right) => right.length - left.length)
/** bash's `source file [arguments]` and `. file [arguments]` (https://www.gnu.org/software/bash/manual/bash.html#Bourne-Shell-Builtins). */
const SOURCE: Interpreter = NO_OPTIONS

/** `python3.12` → `python`, `bash-5` → `bash`: a name without trailing digits, dots and dashes. */
function withoutVersion(name: string): string {
  let end = name.length
  while (end > 0 && /[\d.-]/u.test(name[end - 1] ?? '')) end--
  return name.slice(0, end)
}

/**
 * The interpreter, script host or shell family a program's file name (see
 * `programName`) stands for, however it is spelled: a root exactly, with a
 * version (`python3.12`, `bash5`, `r4.3`), a longer root followed by a version
 * and more (`python3-dbg`), or a GUI variant (`pythonw`, `python3.12w`, `pyw`).
 */
function programFamily(name: string): string | undefined {
  const plain = (candidate: string): string | undefined => {
    const bare = withoutVersion(candidate)
    if (Object.hasOwn(FAMILIES, candidate)) return FAMILIES[candidate]
    if (bare !== candidate && Object.hasOwn(FAMILIES, bare)) return FAMILIES[bare]
    const root = PREFIX_ROOTS.find(prefix => candidate.startsWith(prefix) && /[\d._-]/u.test(candidate[prefix.length] ?? ''))
    return root === undefined ? undefined : FAMILIES[root]
  }
  const family = plain(name)
  if (family !== undefined || !name.endsWith('w')) return family
  const gui = plain(name.slice(0, -1))
  return gui !== undefined && GUI_VARIANTS.has(gui) ? gui : undefined
}

/**
 * Whether a value may stand in the word `current` after `words[from…]`, the
 * arguments of an interpreter: only after the script, a fixed word (which may
 * hold a host path variable) after none but the allowed options. A host path
 * variable may also stand in the script itself.
 */
function interpreterAllows(spec: Interpreter, words: readonly string[], from: number, current: string, host: boolean, kind: 'bash' | 'powershell'): boolean {
  let index = from
  for (; index < words.length; index++) {
    const word = words[index] ?? ''
    if (!fixedWord(word)) return false
    const plain = unquote(word, kind)
    if (!/^[-+]/u.test(plain)) break
    if (!spec.options.includes(plain)) return false
  }
  if (index < words.length) {
    const script = unquote(words[index] ?? '', kind)
    return script.length > 0 && spec.notScript?.includes(script) !== true
  }
  // The value would stand in the script (or in an option before it): only a host path may.
  return host && !/^[-+]/u.test(unquote(current, kind))
}

function isRunner(command: string): boolean {
  return RUNNERS.has(command) || RUNNERS.has(withoutVersion(command))
}

/** The {@link PACKAGE_MANAGERS} entry of a program's file name (`pip3.12` is `pip`), if it is one. */
function packageManager(command: string): readonly string[] | undefined {
  if (Object.hasOwn(PACKAGE_MANAGERS, command)) return PACKAGE_MANAGERS[command]
  const bare = withoutVersion(command)
  return Object.hasOwn(PACKAGE_MANAGERS, bare) ? PACKAGE_MANAGERS[bare] : undefined
}

/**
 * How many words after the package manager at `words[at]` make up an allowed
 * subcommand: fixed words right after the program, exactly as listed.
 * Undefined when they make up none (a subcommand that runs code, a missing or
 * dynamic one, or an option first).
 */
function allowedSubcommand(allowed: readonly string[], words: readonly string[], at: number, kind: 'bash' | 'powershell'): number | undefined {
  const matches = (path: readonly string[]): boolean => path.every((part, index) => {
    const word = words[at + 1 + index]
    return word !== undefined && fixedWord(word) && unquote(word, kind) === part
  })
  return allowed.map(path => path.split(' ')).find(matches)?.length
}

/**
 * Where a value may stand on a package manager's line: only after an allowed
 * subcommand, as an operand. Unless a `--` before it ends the options, the
 * word must not start as an option (`--pkg=$1`) nor follow one (`--userconfig
 * "$1"`, `--python "$1"`: options that choose a configuration, interpreter or
 * credential program), and when the value starts the word it must not start
 * with `-` itself, which only the value knows (`operand`).
 */
function packageOperand(allowed: readonly string[], words: readonly string[], at: number, current: string, kind: 'bash' | 'powershell'): Placement {
  const length = allowedSubcommand(allowed, words, at, kind)
  const operands = at + 1 + (length ?? 0)
  if (length === undefined || words.length < operands) return 'refused'
  if (words.slice(operands).some(word => unquote(word, kind) === '--')) return 'argument'
  const before = unquote(current, kind)
  if (before.startsWith('-')) return 'refused'
  if (words.length > operands && unquote(words.at(-1) ?? '', kind).startsWith('-')) return 'refused'
  return before === '' ? 'operand' : 'argument'
}

/** The index of a simple command's program in its words, after assignments (bash) or the call operator (PowerShell). */
function programAt(words: readonly string[], kind: 'bash' | 'powershell'): number {
  let at = kind === 'powershell' && words[0] === '&' ? 1 : 0
  while (kind === 'bash' && at < words.length && ASSIGNMENT.test(words[at] ?? '')) at++
  return at
}

/** Where the command a {@link WRAPPERS} wrapper at `words[at]` runs starts, or undefined when its words cannot be read. */
function afterWrapper(wrapper: Wrapper, words: readonly string[], at: number, kind: 'bash' | 'powershell'): number | undefined {
  let index = at + 1
  for (; index < words.length; index++) {
    const word = words[index] ?? ''
    if (!fixedWord(word)) return undefined
    const plain = unquote(word, kind)
    if (plain === '--') {
      index++
      break
    }
    if (!plain.startsWith('-') || plain === '-' && !wrapper.flags.includes('-')) break
    if (wrapper.flags.includes(plain)) continue
    const option = wrapper.valued.find(name => plain === name || plain.startsWith(name.startsWith('--') ? `${name}=` : name))
    if (option === undefined) return undefined
    if (plain === option) index++
  }
  for (let operand = 0; operand < (wrapper.operands ?? 0); operand++, index++) {
    if (!fixedWord(words[index] ?? '$')) return undefined
  }
  while (wrapper.assignments === true && index < words.length && ASSIGNMENT.test(words[index] ?? '')) {
    if (!fixedWord(words[index] ?? '')) return undefined
    index++
  }
  return index > words.length ? undefined : index
}

/**
 * The index of the program a simple command runs: after assignments, the
 * PowerShell call operator and every {@link WRAPPERS} wrapper (`command sh`,
 * `env X=1 nice -n 5 sh` run `sh`). `words.length` when it runs none
 * (`env` alone); undefined when a wrapper cannot be resolved.
 */
function commandAt(words: readonly string[], kind: 'bash' | 'powershell'): number | undefined {
  let at: number | undefined = programAt(words, kind)
  while (at !== undefined && at < words.length) {
    const name = words[at] ?? ''
    const program = fixedWord(name) ? programName(name, kind) : ''
    const wrapper = Object.hasOwn(WRAPPERS, program) ? WRAPPERS[program] : undefined
    if (wrapper === undefined || (wrapper.builtin === true && kind !== 'bash')) return at
    at = afterWrapper(wrapper, words, at, kind)
  }
  return at
}

/**
 * Whether a simple command may run a package manager's code: a package
 * manager outside its allowed subcommands, an unresolvable wrapper, or a
 * program named at run time (which could be either).
 */
function runsPackageCode(words: readonly string[], kind: 'bash' | 'powershell'): boolean {
  const at = commandAt(words, kind)
  if (at === undefined) return true
  const name = words[at]
  if (name === undefined) return false
  if (namedAtRunTime(name)) return true
  const program = programName(name, kind)
  if (WRAPPING_RUNNERS.has(program)) return true
  const allowed = packageManager(program)
  return allowed !== undefined && allowedSubcommand(allowed, words, at, kind) === undefined
}

/** Whether a program word expands at run time (`$TOOL`, `` `which npm` ``), so that it could name any program. */
function namedAtRunTime(word: string): boolean {
  return /[$`]/u.test(word.replace(HOST_VARIABLE, ''))
}

/**
 * Whether a simple command may read code from a stream (a pipe, standard
 * input, a process substitution): an interpreter or shell not in its verified
 * fixed-script form (see `interpreterAllows`), `source`/`.`, `sed`/`awk` with a
 * program file that is a stream, any other runner (which may start one), a
 * package manager outside its allowed subcommands, and PowerShell's runners
 * but `ForEach-Object`/`Where-Object`. The program is the one wrappers run
 * (see `commandAt`); an unresolvable wrapper or a dynamic program counts.
 */
function readsCode(words: readonly string[], kind: 'bash' | 'powershell'): boolean {
  const at = commandAt(words, kind)
  // A wrapper that cannot be resolved, or a program named at run time, may be anything.
  if (at === undefined) return true
  const name = words[at]
  if (name === undefined) return false
  if (namedAtRunTime(name)) return true
  const command = programName(name, kind)
  const fixedScript = (spec: Interpreter): boolean => fixedWord(name) && interpreterAllows(spec, words, at + 1, '', false, kind)
    && !words.slice(at + 1).some(word => STDIN_PATH.test(unquote(word, kind)))
  if (kind === 'bash' && (name === '.' || name === 'source')) return !fixedScript(SOURCE)
  if (command === 'sed' || programFamily(command) === 'awk') {
    return words.some((word, index) => {
      const option = PROGRAM_FILE_OPTION.exec(unquote(word, kind))
      if (option === null) return false
      const attached = option[1] !== undefined && option[1] !== ''
      const file = attached ? word : words[index + 1] ?? '-'
      return !fixedWord(file) || STDIN_PATH.test(attached ? option[1] ?? '' : unquote(file, kind))
    })
  }
  const family = programFamily(command)
  if (family !== undefined) {
    const interpreter = INTERPRETERS[family]
    return interpreter === undefined || !fixedScript(interpreter)
  }
  if (isRunner(command) || runsPackageCode(words.slice(at), kind)) return true
  return kind === 'powershell' && POWERSHELL_RUNNERS.has(command) && !POWERSHELL_PIPELINE_BLOCKS.has(command)
}

/**
 * Whether a value may stand in the word `current` being read after `words`
 * (the words of the current simple command so far): only as an argument of a
 * command named by a plain word, not as the command itself or an assignment,
 * and not of a builtin or program that runs, evaluates or names what it is
 * given; for a script interpreter, only after its script (see
 * `interpreterAllows`); for a package manager, only as an operand of an
 * allowed subcommand (see `packageOperand`). A host path variable (`host`) may
 * also name the command, or an interpreter's script.
 */
function argumentOf(words: readonly string[], current: string, kind: 'bash' | 'powershell', host: boolean): Placement {
  const placement = argumentPlacement(words, current, kind, host)
  return typeof placement === 'string' ? placement : placement ? 'argument' : 'refused'
}

function argumentPlacement(words: readonly string[], current: string, kind: 'bash' | 'powershell', host: boolean): boolean | Placement {
  // PowerShell runs a command named by a string through the call operator `&`.
  const call = kind === 'powershell' && words[0] === '&' ? 1 : 0
  let at = call
  while (kind === 'bash' && at < words.length && ASSIGNMENT.test(words[at] ?? '')) at++
  const name = words[at]
  if (name === undefined) return host && (kind === 'bash' ? !ASSIGNMENT.test(current) : call === 1)
  if (name.startsWith('-')) return false
  const hostName = fixedWord(name) && name.replace(HOST_VARIABLE, '') !== name
  const command = programName(name, kind)
  if (kind === 'bash' && (name === '.' || name === 'source')) return interpreterAllows(SOURCE, words, at + 1, current, host, kind)
  // An interpreter, script host or shell, however spelled: only a verified form takes a value; nothing falls back to the rules below.
  const family = programFamily(command)
  if (family !== undefined) {
    const interpreter = INTERPRETERS[family]
    return interpreter !== undefined && fixedWord(name) && interpreterAllows(interpreter, words, at + 1, current, host, kind)
  }
  if (isRunner(command)) return false
  const allowed = packageManager(command)
  if (allowed !== undefined) return packageOperand(allowed, words, at, current, kind)
  if (kind === 'powershell') {
    return (/^[\w./\\:+@,-]+$/u.test(name) || hostName) && !POWERSHELL_RUNNERS.has(command)
      && !words.some((arg, index) => index > at && /^-(?:c|command|e|ec|encodedcommand|sb|scriptblock|cwa|commandwithargs)$/iu.test(arg))
  }
  if (!/^[\w./:+@,-]+$|^\[$/u.test(name) && !hostName) return false
  if ((command === 'find' && words.some((arg, index) => index > at && /^-(?:exec|execdir|ok|okdir)$/u.test(arg)))) return false
  if (!BASH_BUILTINS.has(name)) return true
  switch (name) {
    case 'echo': case 'cd': case 'pushd': case 'pwd': case 'true': case 'false': case ':': return true
    // `printf -v NAME` evaluates NAME; so would a value standing as the format.
    case 'printf': return words.length > at + 1 && !words.slice(at + 1).includes('-v')
    case 'test': case '[': return words.length > at + 1 && TEST_OPERATOR.test(words.at(-1) ?? '')
    default: return false
  }
}

/** Whether any argument may match `option` once unquoted: a dynamic argument may be anything, so it may. */
function anyArgument(args: readonly string[], option: RegExp, kind: 'bash' | 'powershell'): boolean {
  return args.some(arg => !fixedWord(arg) || option.test(unquote(arg, kind)))
}

/**
 * Programs known to write files, by file name, with the arguments that make
 * them write (a dynamic argument counts, since it could be one). Ordinary
 * programs may write files in ways this list does not know: a documented
 * residual. Output redirections are found separately (see `writesFile`).
 */
const FILE_WRITERS: Readonly<Record<string, (args: readonly string[], kind: 'bash' | 'powershell') => boolean>> = {
  // Their purpose is to write or link a file they are given.
  tee: () => true, cp: () => true, mv: () => true, ln: () => true, install: () => true, rsync: () => true, unzip: () => true, patch: () => true,
  // wget saves what it fetches unless told to print it; any form counts.
  wget: () => true,
  // `dd of=FILE`; `sed -i`/`--in-place` and `perl -i` (also in a cluster such as `-pi`) edit in place.
  dd: (args, kind) => anyArgument(args, /^of=/u, kind),
  sed: (args, kind) => anyArgument(args, /^(?:-[^-]*i|--in-place)/u, kind),
  perl: (args, kind) => anyArgument(args, /^-[^-]*i/u, kind),
  // `curl -o FILE`, `-O` (the remote name), also in a cluster (`-sSLo`).
  curl: (args, kind) => anyArgument(args, /^(?:-[^-]*[oO]|--output|--remote-name)/u, kind),
  // `tar -x`/`x…` (the first argument may be the bare option cluster), `--extract`, `--get`.
  tar: (args, kind) => anyArgument(args.slice(0, 1), /^-?[A-Za-z]*x/u, kind) || anyArgument(args, /^(?:-[^-]*x|--extract|--get)/u, kind),
  // PowerShell's writers and their aliases (https://learn.microsoft.com/powershell/module/microsoft.powershell.management/,
  // /microsoft.powershell.utility/ and /bitstransfer/): content and output cmdlets, copying, moving and renaming
  // (a written file renamed to a script), creating an item (`New-Item -Value`), archives, downloads and exports.
  // Aliases (`sc`, `cpi`, `mi`, `iwr` …) are read as these cmdlets (see `programName`).
  'tee-object': () => true, 'out-file': () => true, 'set-content': () => true, 'add-content': () => true,
  'copy-item': () => true, 'move-item': () => true, 'rename-item': () => true, 'new-item': () => true,
  'expand-archive': () => true, 'invoke-webrequest': () => true, 'start-bitstransfer': () => true,
  'invoke-restmethod': (args, kind) => anyArgument(args, /^-outf/iu, kind),
  'export-csv': () => true, 'export-clixml': () => true, 'export-alias': () => true,
  'export-formatdata': () => true, 'export-pssession': () => true, 'export-console': () => true, 'export-binarymilog': () => true,
}

/**
 * Whether a simple command may write a file: an output redirection to a file
 * (not the shell's null device or a descriptor copy), a {@link FILE_WRITERS} program, an
 * unresolvable wrapper or a program named at run time.
 */
function writesFile(words: readonly string[], kind: 'bash' | 'powershell'): boolean {
  const redirected = redirectFiles(words.join(' '), kind)
  if (redirected === undefined || redirected.some(file => file.writes)) return true
  const at = commandAt(words, kind)
  if (at === undefined) return true
  const name = words[at]
  if (name === undefined) return false
  if (namedAtRunTime(name)) return true
  const program = programName(name, kind)
  return Object.hasOwn(FILE_WRITERS, program) && FILE_WRITERS[program]!(words.slice(at + 1), kind)
}

/** A command or process substitution, whose commands are not classified one by one: it may run anything. */
const SUBSTITUTION = /\$\(|`|^[<>]\(/u

/**
 * Whether a simple command may run code from a file: an interpreter, script
 * host or shell, `source`/`.`/`eval`, a program named by a path (`./x`,
 * `dir/x`) or at run time, any runner, `find … -exec`, a PowerShell runner, a
 * command or process substitution, or an unresolvable wrapper.
 */
function executesFile(words: readonly string[], kind: 'bash' | 'powershell'): boolean {
  if (words.some(word => SUBSTITUTION.test(word))) return true
  const at = commandAt(words, kind)
  if (at === undefined) return true
  const name = words[at]
  if (name === undefined) return false
  if (namedAtRunTime(name)) return true
  const plain = unquote(name, kind)
  if (['.', 'source', 'eval'].includes(plain) || /[/\\]/u.test(plain)) return true
  const command = programName(name, kind)
  if (programFamily(command) !== undefined || isRunner(command)) return true
  if (command === 'find' && words.some((arg, index) => index > at && /^-(?:exec|execdir|ok|okdir)$/u.test(arg))) return true
  return kind === 'powershell' && POWERSHELL_RUNNERS.has(command)
}

/** One simple command of a shell text, as the write-then-run check sees it. */
export interface ShellStep {
  readonly writes: boolean
  readonly executes: boolean
  /**
   * Constructs whose commands run in an order not known statically: its pipeline and the outermost loop,
   * conditional, subshell or group it stands in. Constructs nest, so two commands share one exactly when they
   * share the outermost: a fixed number of groups per command, whatever the nesting depth.
   */
  readonly groups: readonly string[]
  /** Run in the background: concurrently with every later command. */
  readonly background: boolean
}

/**
 * Whether a command that runs a file comes after one that writes a file, in
 * the order the steps are given: later, inside a common pipeline, loop,
 * conditional, subshell or group, or concurrently with it (in the background).
 * A value written there could then run as code.
 */
export function writesThenRuns(steps: readonly ShellStep[]): boolean {
  // One pass, indexing what each check needs: the first writer, how many write, and per group who writes and runs.
  let firstWriter: number | undefined
  let writers = 0
  const backgroundRunners: boolean[] = []
  const groups = new Map<string, { writers: number; runners: number; both: number }>()
  for (const [at, step] of steps.entries()) {
    const writes = step.writes
    const executes = step.executes
    if (writes) {
      firstWriter ??= at
      writers++
    }
    if (executes) {
      // Later than a write by another step.
      if (firstWriter !== undefined && firstWriter < at) return true
      if (step.background) backgroundRunners.push(writes)
    }
    if (!writes && !executes) continue
    for (const group of step.groups) {
      const tally = groups.get(group) ?? { writers: 0, runners: 0, both: 0 }
      if (writes) tally.writers++
      if (executes) tally.runners++
      if (writes && executes) tally.both++
      groups.set(group, tally)
    }
  }
  // In the background, concurrently with another step's write.
  if (backgroundRunners.some(alsoWrites => writers > (alsoWrites ? 1 : 0))) return true
  // In a common group with another step's write: unless the only writer is the only runner.
  for (const tally of groups.values()) {
    if (tally.writers > 0 && tally.runners > 0 && !(tally.writers === 1 && tally.runners === 1 && tally.both === 1)) return true
  }
  return false
}

/** bash keywords that open a construct whose commands run in an order not known statically, and the one closing each. */
const BASH_CONSTRUCTS: Readonly<Record<string, string>> = { while: 'done', until: 'done', for: 'done', select: 'done', if: 'fi', case: 'esac', '{': '}' }
/** PowerShell loop keywords: a text with one has its commands in no static order. */
const POWERSHELL_LOOPS = /^(?:while|for|foreach|do|until)$/iu

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
  const defines = DEFINES[kind].test(command)
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
  // Open constructs whose commands run in no static order (see `ShellStep`), innermost last, and the word or
  // character that closes each; a counter names them.
  const constructs: Array<{ readonly id: string; readonly close: string }> = []
  let constructCount = 0
  const open = (close: string): void => {
    constructs.push({ id: `c${String(constructCount++)}`, close })
  }
  const close = (closer: string): void => {
    const at = constructs.map(construct => construct.close).lastIndexOf(closer)
    if (at !== -1) constructs.splice(at)
  }
  let loops = false
  const endWord = (): void => {
    if (wordAt === undefined) return
    const word = command.slice(wordAt, index)
    if (words.length === 0 && kind === 'bash') {
      if (Object.hasOwn(BASH_CONSTRUCTS, word)) open(BASH_CONSTRUCTS[word]!)
      else if (Object.values(BASH_CONSTRUCTS).includes(word)) close(word)
    }
    if (words.length === 0 && kind === 'powershell' && POWERSHELL_LOOPS.test(word)) loops = true
    if (!(kind === 'bash' && words.length === 0 && BASH_PREFIXES.has(word))) words.push(word)
    wordAt = undefined
  }
  // Every simple command of the line, and whether anything on it feeds a program through a stream: a pipe, a
  // process substitution or an input redirection. A value anywhere on such a line may reach that program.
  const lineCommands: string[][] = []
  // Each simple command with the constructs it stands in, for the write-then-run check; pipelines are numbered.
  const steps: Array<{ readonly words: readonly string[]; readonly groups: readonly string[]; readonly pipeline: number }> = []
  let pipeline = 0
  const backgrounded = new Set<number>()
  let streams = false
  let valued = false
  // A value someone chose (an argument), not a path the host sets: what a written file could carry into code.
  let chosen = false
  const operands: string[] = []
  const endCommand = (char: string, next: string): void => {
    endWord()
    const previous = command[index - 1] ?? ''
    // `<(…)` and `>(…)`: the `<` or `>` before the parenthesis was read as a word; mark it as a process substitution.
    if (kind === 'bash' && char === '(' && (previous === '<' || previous === '>')) {
      if (words.at(-1) === previous) words[words.length - 1] = `${previous}(`
      streams = true
    }
    const pipe = (char === '|' && next !== '|' && previous !== '|') || (char === '&' && previous === '|')
    if (pipe) streams = true
    if (words.some(word => /^\d*<(?!<)/u.test(word))) streams = true
    lineCommands.push(words)
    // A lone `&` after a command (not `&&`, `|&` or part of a redirection) runs the pipeline before it in the
    // background: bash's job control and PowerShell 7's background operator alike.
    const background = char === '&' && next !== '&' && previous !== '&' && previous !== '|'
    steps.push({ words, groups: [`p${String(pipeline)}`, ...constructs.slice(0, 1).map(construct => construct.id)], pipeline })
    if (background) backgrounded.add(pipeline)
    if (!pipe) pipeline++
    if (char === '(' || (kind === 'powershell' && char === '{')) open(char === '(' ? ')' : '}')
    else if (char === ')' || (kind === 'powershell' && char === '}')) close(char)
    words = []
  }
  const separates = (char: string, next: string): boolean => {
    const previous = command[index - 1] ?? ''
    if (/[\n;()]/u.test(char)) return true
    // PowerShell: `&` before a command is the call operator; after one (something already read), PowerShell 7's
    // background operator (https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_operators#background-operator-).
    if (kind === 'powershell') return /[{}|]/u.test(char) || (char === '&' && (next === '&' || previous === '&' || powershellAmpersand(previous, next, words.length > 0 || wordAt !== undefined) === 'background'))
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
      else if (separates(char, next)) endCommand(char, next)
      else wordAt ??= index
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
          const host = match[1] !== undefined && match[1] !== 'CLAUDE_SESSION_ID'
          const placement = argumentOf(words, wordAt === undefined ? '' : command.slice(wordAt, index), kind, host)
          if (placement === 'refused' || defines) return { refused: 'an argument or path variable stands where it is not plainly an argument of a command' }
          if (placement === 'operand') operands.push(key)
          out += kind === 'powershell' ? `\${env:${key}}` : frame === undefined ? `"\${${key}}"` : `\${${key}}`
          valued = true
          if (!host) chosen = true
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
    } else if (kind === 'bash' && command.startsWith('let', index) && !/\w/u.test(command[index + 3] ?? '') && commandStart(command, index)) {
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
  endCommand('', '')
  if (valued && streams && lineCommands.some(words => readsCode(words, kind))) {
    return { refused: 'an argument or path variable is on a line where a program reads code from a pipe or a process substitution' }
  }
  if (valued && lineCommands.some(words => runsPackageCode(words, kind))) {
    return { refused: 'an argument or path variable is on a line where a package manager may run package or project code' }
  }
  const classified: ShellStep[] = steps.filter(step => step.words.length > 0).map(step => ({
    writes: writesFile(step.words, kind),
    executes: executesFile(step.words, kind),
    groups: loops ? ['loop', ...step.groups] : step.groups,
    background: backgrounded.has(step.pipeline),
  }))
  if (chosen && writesThenRuns(classified)) return { refused: WRITE_THEN_RUN }
  return { command: out, operands, steps: classified, chosen }
}

/** Why a value is refused where a file written earlier may run (a shell line, or every shell line of a body). */
const WRITE_THEN_RUN = 'a value could reach code through a file written earlier in this command'

/** Whether only blanks stand between `index` and the start of a command (the line start or `;`, `&`, `|`, `(`). */
function commandStart(command: string, index: number): boolean {
  let at = index
  while (at > 0 && (command[at - 1] === ' ' || command[at - 1] === '\t')) at--
  return at === 0 || ';&|(\n'.includes(command[at - 1] ?? '')
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
    const raw = stripTrailing(match[1] ?? '', '.,;:')
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
    // On a network share the workspace is not on, or through a link to one: refused untouched, since on Windows
    // even a stat signs in to that server.
    if (reachesNewShare(reference, context.cwd) || linksReachNewShare(path, context.cwd)) {
      refused.push(reference)
      continue
    }
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
