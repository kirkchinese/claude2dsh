import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import type * as Fs from 'node:fs'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** The file that turns into a FIFO once it has been listed, and what the listing saw. */
const swap: { path?: string } = {}

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof Fs>()
  return {
    ...fs,
    // Listed as the regular file it is, then replaced by a FIFO before it is opened.
    lstatSync: ((path: string, ...rest: unknown[]) => {
      const stat = (fs.lstatSync as (...args: unknown[]) => Fs.Stats)(path, ...rest)
      if (path === swap.path) {
        fs.rmSync(path)
        execFileSync('mkfifo', [path])
      }
      return stat
    }) as typeof fs.lstatSync,
  }
})

const { copyTree } = await import('../src/forge/remote/archive.js')

/**
 * How long the helper waits before opening the FIFO for writing, which is what
 * releases a reader blocked in its open: a copy that waits for it takes at
 * least this long, one that does not returns well before.
 */
const WRITER_DELAY_MS = 3000

const temporary: string[] = []
const helpers: ChildProcess[] = []
afterEach(() => {
  for (const helper of helpers.splice(0)) helper.kill('SIGKILL')
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete swap.path
})

describe('copying a folder on this computer', () => {
  it.skipIf(process.platform === 'win32')('skips a listed file replaced by a FIFO instead of blocking on it (POSIX: Windows keeps named pipes out of folders)', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-forge-fifo-'))
    temporary.push(root)
    const source = join(root, 'plugin')
    const dest = join(root, 'copy')
    mkdirSync(source)
    writeFileSync(join(source, 'kept.txt'), 'kept')
    writeFileSync(join(source, 'swapped.txt'), 'listed as a file')
    swap.path = join(source, 'swapped.txt')
    // Releases a reader that blocked, so a failing copy fails rather than hangs the run.
    helpers.push(spawn('sh', ['-c', `sleep ${String(WRITER_DELAY_MS / 1000)}; exec 3>"$1"`, 'sh', swap.path], { stdio: 'ignore' }))
    const started = Date.now()
    const skipped = copyTree(source, dest)
    expect(Date.now() - started).toBeLessThan(WRITER_DELAY_MS)
    expect(skipped).toEqual(['swapped.txt'])
    expect(readdirSync(dest)).toEqual(['kept.txt'])
  }, WRITER_DELAY_MS * 2)
})
