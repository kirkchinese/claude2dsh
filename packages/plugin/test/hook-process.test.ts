import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess, treeKillCommand } from '../src/hooks/process.js'

const temporary: string[] = []
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A hook (node) that starts a sleeping descendant, writes its pid to `pid`, and waits itself. */
function hookWithChild(): { root: string; file: string; args: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'harness-forge-hook-process-'))
  temporary.push(root)
  const script = join(root, 'hook.js')
  writeFileSync(script, `
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' })
writeFileSync(${JSON.stringify(join(root, 'pid'))}, String(child.pid))
setTimeout(() => {}, 60000)
`)
  return { root, file: process.execPath, args: [script] }
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) await new Promise(resolve => setTimeout(resolve, 25))
}

const pidOf = (root: string): number => Number(readFileSync(join(root, 'pid'), 'utf8'))

describe('runProcess cancellation', () => {
  it('a timeout ends the hook and the processes it started, and says it timed out', async () => {
    const hook = hookWithChild()
    const outcome = await runProcess({ file: hook.file, args: hook.args, cwd: hook.root, env: process.env, stdin: '', timeoutMs: 1500 })
    expect(outcome).toMatchObject({ timedOut: true, cancelled: false })
    expect(outcome.exitCode).toBeUndefined()
    const pid = pidOf(hook.root)
    await waitFor(() => !alive(pid))
    expect(alive(pid)).toBe(false)
  })

  it('an abort ends the whole tree and says it was cancelled', async () => {
    const hook = hookWithChild()
    const controller = new AbortController()
    const running = runProcess({ file: hook.file, args: hook.args, cwd: hook.root, env: process.env, stdin: '', signal: controller.signal })
    await waitFor(() => { try { return pidOf(hook.root) > 0 } catch { return false } })
    controller.abort()
    const outcome = await running
    expect(outcome).toMatchObject({ cancelled: true, timedOut: false })
    const pid = pidOf(hook.root)
    await waitFor(() => !alive(pid))
    expect(alive(pid)).toBe(false)
  })

  it('a hook that finishes by itself is left alone: its exit code is reported', async () => {
    const outcome = await runProcess({ file: process.execPath, args: ['-e', 'process.stdout.write("done"); process.exit(3)'], cwd: tmpdir(), env: process.env, stdin: '', timeoutMs: 10_000 })
    expect(outcome).toMatchObject({ exitCode: 3, stdout: 'done', timedOut: false, cancelled: false })
  })

  it('builds the Windows tree kill as taskkill /T /F and uses the process group elsewhere', () => {
    expect(treeKillCommand(4242, 'win32')).toEqual({ file: 'taskkill', args: ['/T', '/F', '/PID', '4242'] })
    expect(treeKillCommand(4242, 'linux')).toBeUndefined()
    expect(treeKillCommand(4242, 'darwin')).toBeUndefined()
  })
})

describe('runProcess stdin', () => {
  it('gives the hook its input on a stdin a synchronous read gets whole at once, then removes the file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-forge-hook-stdin-'))
    temporary.push(root)
    const script = join(root, 'hook.js')
    // As the codex plugin's hooks do: look at process.stdin (which makes a socket stdin non-blocking), then
    // read fd 0 synchronously. From a socket whose input the parent has not written yet that read fails with
    // EAGAIN; a file holds the whole input from the start.
    writeFileSync(script, "process.stdin.isTTY; const fs = require('node:fs'); const data = fs.readFileSync(0, 'utf8'); process.stdout.write(String(fs.fstatSync(0).isFile()) + data)\n")
    const stdinDir = join(root, 'stdin')
    for (const input of [JSON.stringify({ hook_event_name: 'SessionStart' }), JSON.stringify({ hook_event_name: 'Stop', padding: 'x'.repeat(4_000_000) })]) {
      const running = runProcess({ file: process.execPath, args: [script], cwd: root, env: process.env, stdin: input, stdinDir })
      // A busy parent (DSH at work) writes to a pipe late.
      const until = Date.now() + 300
      while (Date.now() < until) { /* busy */ }
      const outcome = await running
      expect(outcome.stderr).toBe('')
      expect(outcome.exitCode).toBe(0)
      expect(outcome.stdout).toBe(`true${input}`)
    }
    expect(readdirSync(stdinDir)).toEqual([])
    if (process.platform !== 'win32') expect(statSync(stdinDir).mode & 0o777).toBe(0o700)
  })

  it('reads an empty stdin as empty', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-forge-hook-stdin-'))
    temporary.push(root)
    const outcome = await runProcess({ file: process.execPath, args: ['-e', "process.stdout.write(String(require('node:fs').readFileSync(0).length))"], cwd: root, env: process.env, stdin: '' })
    expect(outcome).toMatchObject({ exitCode: 0, stdout: '0', stderr: '' })
  })
})
