/**
 * Run one hook process the way Claude Code does: JSON on stdin, output read
 * until shortly after the process itself exits (a background child that
 * keeps the pipes open does not hold the hook), an optional timeout, and
 * cancellation through a signal. A timeout or cancellation ends the hook's
 * whole process tree, not only the process that was started.
 * @module @kirkchinese/harness-forge
 */
import { spawn } from 'node:child_process'
import { messageOf } from '../shared/util.js'

/** One process to run. */
export interface ProcessSpec {
  readonly file: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly stdin: string
  /** Undefined runs without a timeout. */
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

/** What one run produced. */
export interface ProcessOutcome {
  /** Exit code; undefined when the process could not start, timed out or was cancelled. */
  readonly exitCode?: number
  /** Why the process could not start. */
  readonly startError?: string
  readonly timedOut: boolean
  readonly cancelled: boolean
  readonly stdout: string
  readonly stderr: string
  /** The process exited while something it started still held its output open. */
  readonly suspectCapture: boolean
  readonly durationMs: number
}

const OUTPUT_LIMIT = 8 * 1024 * 1024
/** How long output is still read after the process exits. */
const DRAIN_MS = 250

/** The command that ends a process and everything it started on Windows (`taskkill /T /F`). */
export function treeKillCommand(pid: number, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } | undefined {
  return platform === 'win32' ? { file: 'taskkill', args: ['/T', '/F', '/PID', String(pid)] } : undefined
}

/**
 * End a spawned process and its descendants. On POSIX the process leads its own
 * group (it was spawned `detached`), so the group is killed; on Windows
 * `taskkill /T /F` walks the tree.
 */
export function killProcessTree(child: ReturnType<typeof spawn>, platform: NodeJS.Platform = process.platform): void {
  const pid = child.pid
  if (pid === undefined) {
    child.kill('SIGKILL')
    return
  }
  const windows = treeKillCommand(pid, platform)
  if (windows !== undefined) {
    try {
      const killer = spawn(windows.file, windows.args, { stdio: 'ignore', windowsHide: true })
      killer.on('error', () => { child.kill('SIGKILL') })
      killer.unref()
    } catch {
      child.kill('SIGKILL')
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

/** Spawn without a shell and collect the outcome. Never rejects. */
export function runProcess(spec: ProcessSpec): Promise<ProcessOutcome> {
  const started = performance.now()
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let cancelled = false
    let settled = false
    let exitCode: number | undefined
    let stdoutOpen = true
    let stderrOpen = true
    let drainTimer: NodeJS.Timeout | undefined
    let child: ReturnType<typeof spawn>
    try {
      // Detached on POSIX: the hook leads its own process group, which a timeout or cancellation kills whole.
      child = spawn(spec.file, [...spec.args], { cwd: spec.cwd, env: spec.env, windowsHide: true, stdio: 'pipe', detached: process.platform !== 'win32' })
    } catch (error: unknown) {
      resolve({ startError: messageOf(error), timedOut: false, cancelled: false, stdout: '', stderr: '', suspectCapture: false, durationMs: 0 })
      return
    }
    const finish = (suspectCapture: boolean, startError?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(drainTimer)
      spec.signal?.removeEventListener('abort', onAbort)
      if (suspectCapture || timedOut || cancelled) {
        child.stdout?.destroy()
        child.stderr?.destroy()
        child.stdin?.destroy()
      }
      resolve({
        ...(exitCode !== undefined && !timedOut && !cancelled ? { exitCode } : {}),
        ...(startError !== undefined ? { startError } : {}),
        timedOut,
        cancelled,
        stdout,
        stderr,
        suspectCapture,
        durationMs: Math.round(performance.now() - started),
      })
    }
    const timer = spec.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
        timedOut = true
        killProcessTree(child)
        finish(false)
      }, spec.timeoutMs)
    const onAbort = (): void => {
      cancelled = true
      killProcessTree(child)
      finish(false)
    }
    spec.signal?.addEventListener('abort', onAbort, { once: true })
    if (spec.signal?.aborted === true) onAbort()
    const closed = (): void => {
      if (exitCode !== undefined && !stdoutOpen && !stderrOpen) finish(false)
    }
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { if (stdout.length < OUTPUT_LIMIT) stdout += chunk })
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { if (stderr.length < OUTPUT_LIMIT) stderr += chunk })
    child.stdout?.on('close', () => { stdoutOpen = false; closed() })
    child.stderr?.on('close', () => { stderrOpen = false; closed() })
    child.on('error', (error) => { finish(false, messageOf(error)) })
    child.on('exit', (code, signal) => {
      // The process has finished: a timeout that fires while its output drains is not the hook's.
      clearTimeout(timer)
      exitCode = code ?? (signal !== null ? 128 : undefined)
      if (!stdoutOpen && !stderrOpen) {
        finish(false)
        return
      }
      drainTimer = setTimeout(() => { finish(stdoutOpen || stderrOpen) }, DRAIN_MS)
    })
    child.stdin?.on('error', () => {
      // A hook that exits without reading stdin closes the pipe early.
    })
    child.stdin?.end(spec.stdin)
  })
}

