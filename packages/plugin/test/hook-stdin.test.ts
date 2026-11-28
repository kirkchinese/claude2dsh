/**
 * The file that carries a hook's input on stdin: one descriptor creates,
 * writes and hands it over; it lives only in a private directory; nothing is
 * left behind when anything fails.
 */
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const FAIL = 'FAIL-WRITE-MARKER'
const opened: Array<{ path: string; flags: unknown }> = []
/** While set, removing a stdin file fails as Windows fails for a file a process holds open. */
const stuck = { on: false }

vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>()
  return {
    ...real,
    openSync: (path: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
      opened.push({ path: String(path), flags })
      return real.openSync(path, flags, mode)
    },
    // A write that stops part-way, through either way of writing the file.
    writeSync: (fd: number, buffer: NodeJS.ArrayBufferView, ...rest: unknown[]) => {
      if (Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength).includes(FAIL)) {
        real.writeSync(fd, Buffer.from('{"partial'))
        throw new Error('disk full')
      }
      return (real.writeSync as (...args: unknown[]) => number)(fd, buffer, ...rest)
    },
    unlinkSync: (path: fs.PathLike) => {
      if (stuck.on && String(path).endsWith('.json')) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
      real.unlinkSync(path)
    },
    writeFileSync: (path: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      if (String(data).includes(FAIL)) {
        real.writeFileSync(path, '{"partial', options)
        throw new Error('disk full')
      }
      real.writeFileSync(path, data, options)
    },
  }
})

const { removeWithRetries, runProcess } = await import('../src/hooks/process.js')

const temporary: string[] = []
afterEach(() => {
  opened.splice(0)
  stuck.on = false
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const dir = fs.mkdtempSync(join(tmpdir(), 'harness-forge-hook-stdin-'))
  temporary.push(dir)
  return dir
}

const echo = { file: process.execPath, args: ['-e', "process.stdout.write(require('node:fs').readFileSync(0, 'utf8'))"] }
const posix = process.platform !== 'win32'

describe('hook stdin file', () => {
  it('creates, writes and passes one descriptor, never opening the file again by path', async () => {
    const dir = join(root(), 'stdin')
    const outcome = await runProcess({ ...echo, cwd: tmpdir(), env: process.env, stdin: '{"a":1}', stdinDir: dir })
    expect(outcome).toMatchObject({ exitCode: 0, stdout: '{"a":1}' })
    const mine = opened.filter(entry => entry.path.startsWith(dir))
    expect(mine).toEqual([{ path: expect.stringContaining(dir), flags: 'wx+' }])
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it.skipIf(!posix)('makes the directory private and refuses one that is a symbolic link', async () => {
    const base = root()
    const own = join(base, 'own')
    fs.mkdirSync(own, { mode: 0o755 })
    fs.chmodSync(own, 0o755)
    expect(await runProcess({ ...echo, cwd: base, env: process.env, stdin: 'x', stdinDir: own })).toMatchObject({ exitCode: 0, stdout: 'x' })
    expect(fs.statSync(own).mode & 0o777).toBe(0o700)

    const target = join(base, 'target')
    fs.mkdirSync(target, { mode: 0o755 })
    fs.chmodSync(target, 0o755)
    const link = join(base, 'link')
    fs.symlinkSync(target, link)
    // The input still arrives (through a pipe); nothing is written where the link points, and its mode is untouched.
    expect(await runProcess({ ...echo, cwd: base, env: process.env, stdin: 'y', stdinDir: link })).toMatchObject({ exitCode: 0, stdout: 'y' })
    expect(opened.filter(entry => entry.path.startsWith(link) || entry.path.startsWith(target))).toEqual([])
    expect(fs.statSync(target).mode & 0o777).toBe(0o755)
    expect(fs.readdirSync(target)).toEqual([])
  })

  it('leaves nothing behind when the write stops part-way, and still delivers the input', async () => {
    const dir = join(root(), 'stdin')
    const input = `{"note":"${FAIL}"}`
    const outcome = await runProcess({ ...echo, cwd: tmpdir(), env: process.env, stdin: input, stdinDir: dir })
    expect(outcome).toMatchObject({ exitCode: 0, stdout: input })
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('leaves nothing behind when the process cannot start', async () => {
    const dir = join(root(), 'stdin')
    const outcome = await runProcess({ file: 'no\0such', args: [], cwd: tmpdir(), env: process.env, stdin: '{}', stdinDir: dir })
    expect(outcome.startError).toBeDefined()
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('retries removing a file a bounded number of times', async () => {
    let calls = 0
    expect(await removeWithRetries('x', 5, 1, () => ++calls === 3)).toBe(true)
    expect(calls).toBe(3)
    calls = 0
    expect(await removeWithRetries('x', 5, 1, () => { calls++; return false })).toBe(false)
    expect(calls).toBe(5)
  })

  it.skipIf(!posix)('refuses a folder reached through a symbolic link below the data root', async () => {
    const base = root()
    const data = join(base, 'data')
    const target = join(base, 'elsewhere')
    fs.mkdirSync(data)
    fs.mkdirSync(target)
    fs.symlinkSync(target, join(data, 'link'))
    const outcome = await runProcess({ ...echo, cwd: base, env: process.env, stdin: 'z', stdinDir: join(data, 'link', 'stdin'), stdinRoot: data })
    expect(outcome).toMatchObject({ exitCode: 0, stdout: 'z' })
    expect(opened.filter(entry => entry.path.startsWith(data) || entry.path.startsWith(target))).toEqual([])
  })

  it.skipIf(!posix)('refuses a data root that is itself a symbolic link', async () => {
    const base = root()
    const target = join(base, 'elsewhere')
    fs.mkdirSync(join(target, 'stdin'), { recursive: true })
    const data = join(base, 'data')
    fs.symlinkSync(target, data)
    const outcome = await runProcess({ ...echo, cwd: base, env: process.env, stdin: 'w', stdinDir: join(data, 'stdin'), stdinRoot: data })
    expect(outcome).toMatchObject({ exitCode: 0, stdout: 'w' })
    expect(opened.filter(entry => entry.path.startsWith(data) || entry.path.startsWith(target))).toEqual([])
  })

  it('reports a stdin file it cannot remove on every way out, after bounded retries', async () => {
    stuck.on = true
    const run = async (spec: { file: string; args: string[]; stdin: string }): Promise<string[]> => {
      const dir = join(root(), 'stdin')
      const left: string[] = []
      await runProcess({ ...spec, cwd: tmpdir(), env: process.env, stdinDir: dir, onLeftover: path => left.push(path) })
      for (let wait = 0; wait < 100 && left.length === 0; wait++) await new Promise(done => setTimeout(done, 50))
      expect(left.every(path => path.startsWith(dir))).toBe(true)
      return left
    }
    const [ran, partial, failed] = await Promise.all([
      run({ ...echo, stdin: '{}' }),
      run({ ...echo, stdin: `{"note":"${FAIL}"}` }),
      run({ file: 'no\0such', args: [], stdin: '{}' }),
    ])
    expect(ran).toHaveLength(1)
    expect(partial).toHaveLength(1)
    expect(failed).toHaveLength(1)
  })
})
