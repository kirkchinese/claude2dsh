/**
 * Run one hook process the way Claude Code does: JSON on stdin, output read
 * until shortly after the process itself exits (a background child that
 * keeps the pipes open does not hold the hook), an optional timeout, and
 * cancellation through a signal. A timeout or cancellation ends the hook's
 * whole process tree, not only the process that was started.
 *
 * Stdin is a file holding the input, not a pipe, when one can be made (see
 * `stdinFile`): a hook that reads it synchronously at once (`readFileSync(0)`)
 * then always gets all of it, where a socket could answer EAGAIN before the
 * input has arrived. When no such file can be made, the input goes through a pipe.
 * @module @kirkchinese/harness-forge
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, unlinkSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { messageOf } from '../shared/util.js'

/** One process to run. */
export interface ProcessSpec {
  readonly file: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly stdin: string
  /** A private directory for the stdin file; default: one under the system temporary directory. */
  readonly stdinDir?: string
  /** The data root `stdinDir` lies in: no folder between them may be a symbolic link. */
  readonly stdinRoot?: string
  /** Told of a stdin file that could not be removed (default: a process warning). */
  readonly onLeftover?: (path: string) => void
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

let fallbackStdinDir: string | undefined

/**
 * Whether `dir` is a real directory of this user that no one else may enter,
 * making it so when it is this user's: neither it nor any folder between it
 * and `root` (when given) is a symbolic link.
 *
 * POSIX modes are not Windows ACLs: on Windows the mode only sets read-only,
 * and the directory and its files take the ACL inherited from where they lie,
 * Harness Forge's data folder in the user's profile directory, which only that
 * user (and the system and administrators) can reach. There, only the link
 * checks apply.
 */
function privateDirectory(dir: string, root: string | undefined): boolean {
  if (root !== undefined) {
    const top = resolve(root)
    for (let folder = resolve(dir); ; folder = dirname(folder)) {
      // Every folder from `dir` up to and including the data root itself.
      const link = lstatSync(folder)
      if (link.isSymbolicLink() || !link.isDirectory()) return false
      if (folder === top) break
      if (dirname(folder) === folder) return false // `dir` is not inside `root`.
    }
  }
  const stat = lstatSync(dir)
  if (stat.isSymbolicLink() || !stat.isDirectory()) return false
  if (process.platform === 'win32') return true
  if (stat.uid !== process.getuid?.()) return false
  if ((stat.mode & 0o777) !== 0o700) chmodSync(dir, 0o700)
  return (lstatSync(dir).mode & 0o777) === 0o700
}

/**
 * A new file holding `input`, in a directory checked by `privateDirectory`
 * (on POSIX: mode 0600 in a 0700 directory this user owns, so only this user
 * can read it; on Windows: no owner-only ACL is set, and the file takes the
 * ACL inherited from its folder, the user's profile by default), with a
 * descriptor positioned at its start: the same descriptor that created
 * the file is written (at explicit positions, leaving its offset at 0) and
 * becomes the child's stdin, so nothing is opened again by path.
 * @returns undefined when no such file can be made (the caller falls back to a pipe); nothing is left behind then.
 */
function stdinFile(input: string, dir: string | undefined, dataRoot: string | undefined, leftover: (path: string) => void): { fd: number; path: string } | undefined {
  let root: string
  try {
    if (dir !== undefined) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      root = dir
    } else {
      root = fallbackStdinDir ??= mkdtempSync(join(tmpdir(), 'harness-forge-stdin-'))
    }
    if (!privateDirectory(root, dir !== undefined ? dataRoot : undefined)) return undefined
  } catch {
    return undefined
  }
  const path = join(root, `${String(process.pid)}-${randomBytes(8).toString('hex')}.json`)
  let fd: number
  try {
    fd = openSync(path, 'wx+', 0o600)
  } catch {
    return undefined
  }
  try {
    const bytes = Buffer.from(input, 'utf8')
    for (let written = 0; written < bytes.length;) {
      const count = writeSync(fd, bytes, written, bytes.length - written, written)
      if (count <= 0) throw new Error('the stdin file took no bytes')
      written += count
    }
    return { fd, path }
  } catch {
    closeQuietly(fd)
    void discard(path, leftover)
    return undefined
  }
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd)
  } catch {
    // Already closed.
  }
}

function removeFile(path: string): boolean {
  try {
    unlinkSync(path)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

/**
 * Remove a file Windows still holds open (a child that has not let go of it),
 * trying again a bounded number of times.
 * @returns whether it is gone.
 */
export async function removeWithRetries(path: string, attempts = 10, delayMs = 200, remove: (path: string) => boolean = removeFile): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (remove(path)) return true
    await new Promise(resolve => setTimeout(resolve, delayMs).unref())
  }
  return false
}

/**
 * The one way a stdin file goes: removed now, else (after `after`, the child's
 * exit, for Windows, which keeps a file open in a process from being removed)
 * a bounded number of times more; one that stays is reported, not left silently.
 */
async function discard(path: string, leftover: (path: string) => void, after?: Promise<unknown>): Promise<void> {
  if (removeFile(path)) return
  if (after !== undefined) await after
  if (!await removeWithRetries(path)) leftover(path)
}

function warnLeftover(path: string): void {
  process.emitWarning(`harness-forge: could not remove the hook input file ${path}`)
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
    const leftover = spec.onLeftover ?? warnLeftover
    const input = stdinFile(spec.stdin, spec.stdinDir, spec.stdinRoot, leftover)
    try {
      // Detached on POSIX: the hook leads its own process group, which a timeout or cancellation kills whole.
      child = spawn(spec.file, [...spec.args], { cwd: spec.cwd, env: spec.env, windowsHide: true, stdio: [input?.fd ?? 'pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    } catch (error: unknown) {
      if (input !== undefined) {
        closeQuietly(input.fd)
        void discard(input.path, leftover)
      }
      resolve({ startError: messageOf(error), timedOut: false, cancelled: false, stdout: '', stderr: '', suspectCapture: false, durationMs: 0 })
      return
    }
    // The child holds its own handle now: ours is closed and the file removed.
    if (input !== undefined) {
      closeQuietly(input.fd)
      const started = child
      void discard(input.path, leftover, new Promise((done) => { started.once('exit', done); started.once('error', done) }))
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
    // Without a stdin file (none could be written), the input goes through a pipe.
    child.stdin?.on('error', () => {
      // A hook that exits without reading stdin closes the pipe early.
    })
    child.stdin?.end(spec.stdin)
  })
}

