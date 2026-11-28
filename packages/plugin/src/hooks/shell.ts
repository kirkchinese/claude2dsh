/**
 * The shells foreign hooks and command `!` lines run in, located the way
 * Claude Code locates them: Git Bash on Windows (`CLAUDE_CODE_GIT_BASH_PATH`,
 * then next to `git.exe`, then the standard install directories), bash
 * elsewhere (`/bin/sh` without it); PowerShell 7 (`pwsh.exe`) before Windows
 * PowerShell. Processes inherit the user's environment, outside any model-tool
 * sandbox, apart from the `OTEL_*` exporter variables Claude Code strips from
 * every subprocess.
 * @module @kirkchinese/harness-forge
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { runProcess, type ProcessOutcome } from './process.js'

/** How one process runs. */
export interface RunOptions {
  readonly cwd: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly stdin?: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

/** The executors foreign code runs with. */
export interface ForeignShell {
  /** Git Bash, bash, or `/bin/sh` without it; undefined on Windows without Git Bash. */
  readonly bash?: string
  /** `pwsh.exe` when installed, else `powershell.exe` (`pwsh` elsewhere). */
  readonly powershell: string
  /** The shell a shell-form command uses when none is named. */
  readonly defaultKind: 'bash' | 'powershell'
  /** The environment foreign processes start from, with `extra` applied. */
  environment(extra?: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv
  /** Run a shell-form command line. */
  runShell(command: string, kind: 'bash' | 'powershell', options: RunOptions): Promise<ProcessOutcome>
  /** Spawn an executable directly with an argument vector (exec form). */
  runExec(file: string, args: readonly string[], options: RunOptions): Promise<ProcessOutcome>
}

/** Locate the POSIX shell foreign hooks expect. */
export function findPosixShell(env: NodeJS.ProcessEnv = process.env): { shell: string; pathPrefix: string[] } | undefined {
  if (process.platform !== 'win32') {
    // Claude Code runs hooks with bash; `/bin/sh` is dash on Debian and Ubuntu, which rejects bash syntax.
    const bash = ['/bin/bash', ...pathEntries(env).map(entry => join(entry, 'bash'))].find(candidate => existsSync(candidate))
    return { shell: bash ?? '/bin/sh', pathPrefix: [] }
  }
  const candidates: string[] = []
  const declared = env['CLAUDE_CODE_GIT_BASH_PATH']
  if (declared !== undefined && declared.length > 0) candidates.push(declared)
  for (const entry of pathEntries(env)) {
    if (existsSync(join(entry, 'git.exe'))) {
      const root = dirname(entry)
      candidates.push(join(root, 'bin', 'bash.exe'), join(dirname(root), 'bin', 'bash.exe'))
    }
  }
  for (const base of [env['ProgramFiles'], env['ProgramW6432'], env['ProgramFiles(x86)'], env['LOCALAPPDATA'] && join(env['LOCALAPPDATA'], 'Programs')]) {
    if (base !== undefined && base.length > 0) candidates.push(join(base, 'Git', 'bin', 'bash.exe'))
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const root = dirname(dirname(candidate))
    return { shell: candidate, pathPrefix: [join(root, 'usr', 'bin'), join(root, 'bin')] }
  }
  return undefined
}

/** PowerShell 7 when it is on PATH, else Windows PowerShell. */
export function findPowerShell(env: NodeJS.ProcessEnv = process.env): string {
  const name = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh'
  for (const entry of pathEntries(env)) {
    if (existsSync(join(entry, name))) return join(entry, name)
  }
  return process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
}

/**
 * Hook scripts call `python3`. On Windows that name is usually the Microsoft
 * Store placeholder while the real interpreter is `python`; a one-line shim
 * makes `python3` run it, so Python hooks work without changing the machine.
 * @returns the shim directory to put first on PATH, when one is needed.
 */
export function python3Shim(shimRoot: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (process.platform !== 'win32') return undefined
  const entries = pathEntries(env)
  const real = (name: string): boolean => entries.some(entry => !/WindowsApps/iu.test(entry) && existsSync(join(entry, name)))
  if (real('python3.exe') || !real('python.exe')) return undefined
  const dir = join(shimRoot, 'bin')
  const shim = join(dir, 'python3')
  if (!existsSync(shim)) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(shim, '#!/bin/sh\nexec python "$@"\n')
  }
  return dir
}

/**
 * Build the executors.
 * @param shimRoot - writable directory for command shims (see {@link python3Shim}) and the files that hold hook input.
 * @param onLeftover - told of a hook input file that could not be removed.
 */
export function createForeignShell(base: NodeJS.ProcessEnv = process.env, shimRoot?: string, onLeftover?: (path: string) => void): ForeignShell {
  const posix = findPosixShell(base)
  const powershell = findPowerShell(base)
  const shims = shimRoot === undefined ? undefined : python3Shim(shimRoot, base)
  const prefix = [...(shims !== undefined ? [shims] : []), ...(posix?.pathPrefix ?? [])]
  const environment = (extra: Readonly<Record<string, string | undefined>> = {}): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(base)) {
      if (!key.startsWith('OTEL_')) env[key] = value
    }
    if (prefix.length > 0) {
      const key = Object.keys(env).find(name => name.toUpperCase() === 'PATH') ?? 'PATH'
      env[key] = [...prefix, env[key] ?? ''].join(delimiter)
    }
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) delete env[key]
      else env[key] = value
    }
    return env
  }
  const run = (file: string, args: readonly string[], options: RunOptions): Promise<ProcessOutcome> => runProcess({
    file,
    args,
    cwd: options.cwd,
    env: environment(options.env),
    stdin: options.stdin ?? '',
    ...(shimRoot !== undefined ? { stdinDir: join(shimRoot, 'stdin'), stdinRoot: shimRoot } : {}),
    ...(onLeftover !== undefined ? { onLeftover } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  })
  return {
    ...(posix !== undefined ? { bash: posix.shell } : {}),
    powershell,
    defaultKind: posix !== undefined ? 'bash' : 'powershell',
    environment,
    runShell(command, kind, options) {
      if (kind === 'bash' && posix !== undefined) return run(posix.shell, ['-c', command], options)
      return run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], options)
    },
    runExec(file, args, options) {
      return run(file, args, options)
    },
  }
}

function pathEntries(env: NodeJS.ProcessEnv): string[] {
  return (env['PATH'] ?? env['Path'] ?? '').split(delimiter).filter(entry => entry.length > 0)
}
