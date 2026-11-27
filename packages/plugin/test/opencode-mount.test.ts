import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodeComponent, ForeignPlugin } from '@kirkchinese/harness-forge-core'

const fakeBun = vi.hoisted(() => ({ path: '' }))
vi.mock('../src/opencode/bun.js', () => ({ ensureBun: async () => fakeBun.path, ensureDependencies: async () => undefined }))

const { OpenCodeCore } = await import('../src/opencode/runtime/core.js')
const { PluginMounter } = await import('../src/opencode/runtime/mount.js')

const temporary: string[] = []
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

const component = { id: 'opencode:demo:code:plugin', kind: 'code', name: 'plugin', entryPath: '/demo/index.js' } as unknown as CodeComponent
const plugin = (root: string): ForeignPlugin => ({ id: 'opencode:demo', name: 'demo', root, source: 'opencode' }) as unknown as ForeignPlugin

function setup(registry?: { register(definition: Record<string, unknown>): () => void }, loadTimeoutMs?: number) {
  const root = mkdtempSync(join(tmpdir(), 'harness-forge-mount-'))
  temporary.push(root)
  const ctx = { get: (name: string) => (name === 'tools' ? registry : undefined) }
  const core = new OpenCodeCore(ctx as never, { dataRoot: root, observe: () => {}, directory: async () => root, rewrite: () => {}, agentName: () => undefined })
  const mounter = new PluginMounter(core, { listen: async () => undefined, base: 'http://127.0.0.1:1' } as never, loadTimeoutMs)
  return { root, core, mounter }
}

describe('mounting an OpenCode plugin', () => {
  it('fails the mount, without an unhandled error, when the Bun host cannot be spawned', async () => {
    const { root, core, mounter } = setup()
    fakeBun.path = join(root, 'no-such-bun')
    const unhandled: unknown[] = []
    const record = (error: unknown): void => { unhandled.push(error) }
    process.on('uncaughtException', record)
    try {
      await expect(mounter.mount(component, plugin(root))).rejects.toThrow(/could not run/u)
      await new Promise(resolve => setTimeout(resolve, 50))
    } finally {
      process.removeListener('uncaughtException', record)
    }
    expect(unhandled).toEqual([])
    expect(core.hosts.size).toBe(0)
    expect(core.waiting.size).toBe(0)
  })

  it.skipIf(process.platform === 'win32')('rolls back the process, the registrations and the host record when a tool cannot be registered', async () => {
    const registered: string[] = []
    const disposed: string[] = []
    const registry = {
      register: (definition: Record<string, unknown>) => {
        const name = String(definition['name'])
        // The first tool registers; the second and its renamed retry both throw.
        if (name.includes('boom')) throw new Error('registry refused')
        registered.push(name)
        return () => { disposed.push(name) }
      },
    }
    const { root, core, mounter } = setup(registry as never)
    const script = join(root, 'bun')
    writeFileSync(script, '#!/bin/sh\necho $$ > "$(dirname "$0")/pid"\nexec sleep 60\n')
    chmodSync(script, 0o755)
    fakeBun.path = script
    const mounting = mounter.mount(component, plugin(root))
    const answer = { port: 1, plugins: [], config: {}, tools: [{ name: 'fine' }, { name: 'boom' }] }
    for (let attempt = 0; attempt < 200 && core.waiting.size === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
    // The host is up once it has written its pid; only then does the mount hear from it.
    for (let attempt = 0; attempt < 400 && !existsSync(join(root, 'pid')); attempt++) await new Promise(resolve => setTimeout(resolve, 10))
    const waiting = [...core.waiting.values()]
    expect(waiting).toHaveLength(1)
    waiting[0]?.resolve(answer)
    await expect(mounting).rejects.toThrow(/registry refused/u)
    expect(registered).toEqual(['fine'])
    expect(disposed).toEqual(['fine'])
    expect(core.hosts.size).toBe(0)
    expect(core.waiting.size).toBe(0)
    const pid = Number(readFileSync(join(root, 'pid'), 'utf8').trim())
    let alive = true
    for (let attempt = 0; attempt < 100 && alive; attempt++) {
      try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 20)) } catch { alive = false }
    }
    expect(alive).toBe(false)
  })

  // The fake Bun is a shell script, so these two run on POSIX; the spawn-failure test above runs everywhere.
  it.skipIf(process.platform === 'win32')('stops the host and clears the record when loading takes too long', async () => {
    const { root, core, mounter } = setup(undefined, 100)
    fakeBun.path = join(root, 'bun')
    writeFileSync(fakeBun.path, '#!/bin/sh\nexec sleep 60\n')
    chmodSync(fakeBun.path, 0o755)
    await expect(mounter.mount(component, plugin(root))).rejects.toThrow(/did not finish loading/u)
    expect(core.hosts.size).toBe(0)
    expect(core.waiting.size).toBe(0)
  })
})
