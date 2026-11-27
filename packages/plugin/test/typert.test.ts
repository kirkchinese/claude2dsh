import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { HarnessRemoteService, REMOTE_METHODS } from '../src/workbench/remote.js'
import { TYPERT_REMOTE } from '../src/client/typert.js'

/** A Remote service over a stand-in shared service (its rows' APIs in `rows`), without a Cordis context. */
function remoteOver(forge: Record<string, unknown>, rows: Record<string, unknown> = {}): HarnessRemoteService {
  const remote = Object.create(HarnessRemoteService.prototype) as HarnessRemoteService
  Object.defineProperty(remote, 'forge', { value: { lookup: (name: string) => rows[name], ...forge } })
  Object.defineProperty(remote, 'adapterSurfaces', { value: new Map() })
  Object.defineProperty(remote, 'adapterListeners', { value: new Map() })
  return remote
}

describe('harnessCompat Remote namespace', () => {
  it('marks every workbench method on the Host, streams included, and the client mounts the same endpoints', () => {
    const markers = remoteMethods(Object.create(HarnessRemoteService.prototype) as object)
    expect(markers.map(marker => marker.exportName ?? marker.method).sort()).toEqual(REMOTE_METHODS.map(([method]) => method).sort())
    expect(markers.find(marker => marker.method === 'modSurfaces')?.mode).toBe('stream')
    // The browser's namespace service (dsh-api-gateway client) owns these names; a method named so does not mount.
    const reserved = ['ctx', 'empty', 'invokeRemote', 'methods', 'name', 'namespace', 'has', 'install', 'installDirect', 'installScoped', 'remove', 'assertMethodAvailable', 'constructor']
    expect(REMOTE_METHODS.map(([method]) => method).filter(method => reserved.includes(method))).toEqual([])
    expect(Object.keys(TYPERT_REMOTE.methods).sort()).toEqual(REMOTE_METHODS.map(([method]) => `harnessCompat/${method}`).sort())
    for (const [method, , takesRequest] of REMOTE_METHODS) {
      expect(TYPERT_REMOTE.methods[`harnessCompat/${method}`]!.parameters.length).toBe(takesRequest ? 1 : 0)
    }
  })

  it('serves every method the workbench calls', () => {
    // A method missing from both lists mounts nowhere, and the page's call fails (the session repair once did).
    const dir = join(import.meta.dirname, '..', 'src', 'client')
    const called = new Set<string>()
    for (const file of readdirSync(dir).filter(name => /\.tsx?$/u.test(name))) {
      for (const match of readFileSync(join(dir, file), 'utf8').matchAll(/\bcall(?:<[^>]*>)?\(\s*'([A-Za-z]+)'/gu)) called.add(match[1]!)
    }
    expect(called.size).toBeGreaterThan(10)
    const served = new Set(REMOTE_METHODS.map(([method]) => method))
    expect([...called].filter(method => !served.has(method))).toEqual([])
  })

  it('answers contextStatus from the context row, and as inactive while that row is off', async () => {
    const status = { active: false, yieldingTo: 'recollect', files: [] }
    await expect(remoteOver({}, { context: { status: () => status } }).contextStatus()).resolves.toEqual(status)
    await expect(remoteOver({}).contextStatus()).resolves.toEqual({ active: false, files: [] })
  })

  it('turns a failure into a RemoteError whose message is the reason', async () => {
    const remote = remoteOver({ uninstall: async () => false, install: () => { throw new Error('no plugin.json under C:/x') } })
    await expect(remote.removePlugin({ id: 'gone' })).rejects.toMatchObject({ isDSHRemoteError: true, code: 'harness-forge/failed', message: 'no installed plugin gone' })
    await expect(remote.installPlugin({ path: 'C:/x' })).rejects.toMatchObject({ code: 'harness-forge/failed', message: 'no plugin.json under C:/x', details: { operation: 'installPlugin' } })
    await expect(remote.installPlugin({})).rejects.toMatchObject({ message: 'path is required' })
    // A method of a row that is off names the row.
    await expect(remote.signIns()).rejects.toMatchObject({ code: 'harness-forge/failed', message: 'the Harness Forge mcp row is off; turn it on in Plugin Manager' })
  })

  it('switches one part off and on through the shared service', async () => {
    const calls: unknown[][] = []
    const remote = remoteOver({ setPartEnabled: async (...args: unknown[]) => { calls.push(args); return true } })
    await expect(remote.setPartEnabled({ pluginId: 'claude-code:p', componentId: 'skill:a', enabled: false })).resolves.toEqual({ changed: true })
    expect(calls).toEqual([['claude-code:p', 'skill:a', false]])
    await expect(remote.setPartEnabled({ pluginId: 'claude-code:p', componentId: 'skill:a' })).rejects.toMatchObject({ message: 'enabled must be true or false' })
    await expect(remote.setPartEnabled({ componentId: 'skill:a', enabled: true })).rejects.toMatchObject({ message: 'pluginId is required' })
  })

  it('streams a session\'s mod drawings until the reader stops, then lets go of the watch', async () => {
    let listener: ((snapshot: unknown) => void) | undefined
    let stopped = false
    const remote = remoteOver({}, {
      mods: { watch: (_session: string, next: (snapshot: unknown) => void) => { listener = next; next({ generation: 1 }); return () => { stopped = true } } },
    })
    const abort = new AbortController()
    const seen: unknown[] = []
    for await (const snapshot of remote.modSurfaces({ session: 's' }, abort.signal)) {
      seen.push(snapshot)
      if (seen.length === 1) setTimeout(() => { listener?.({ generation: 2 }) }, 5)
      if (seen.length === 2) abort.abort()
    }
    expect(seen).toEqual([{ generation: 1 }, { generation: 2 }])
    expect(stopped).toBe(true)
  })

  it('streams an adapter\'s surface: what it reads now, then again whenever it changes for that session', async () => {
    const remote = remoteOver({})
    let count = 0
    const surface = remote.registerAdapterSurface('demo-statusline', { read: (session: string) => ({ lines: [`${session} #${String(++count)}`], at: count }) })
    const abort = new AbortController()
    const seen: unknown[] = []
    for await (const value of remote.adapterSurface({ adapter: 'demo-statusline', session: 's1' }, abort.signal)) {
      seen.push(value)
      if (seen.length === 1) setTimeout(() => { surface.changed('other'); surface.changed('s1') }, 5)
      if (seen.length === 2) abort.abort()
    }
    expect(seen).toEqual([{ lines: ['s1 #1'], at: 1 }, { lines: ['s1 #2'], at: 2 }])
    expect(await remote.adapterRead({ adapter: 'demo-statusline', session: 's2', cols: 90 })).toEqual({ lines: ['s2 #3'], at: 3 })
    surface.dispose()
    await expect(async () => { for await (const _ of remote.adapterSurface({ adapter: 'demo-statusline', session: 's1' })) break }).rejects.toMatchObject({ message: 'no adapter surface "demo-statusline" is registered in this DSH' })
  })

  it('ends the stream at once when the session\'s mods draw nothing', async () => {
    const remote = remoteOver({}, { mods: { watch: () => undefined } })
    const seen: unknown[] = []
    for await (const snapshot of remote.modSurfaces({ session: 's' })) seen.push(snapshot)
    expect(seen).toEqual([])
  })
})
