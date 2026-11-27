import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
