import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isRemoteJsonValue, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { HarnessRemoteService, REMOTE_METHODS } from '../src/workbench/remote.js'
import { call, isWorkbenchOff, setMountedRemote, TYPERT_REMOTE } from '../src/client/typert.js'

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

  it('answers every method as lossless JSON, whatever the service hands back', async () => {
    // What a service might return: absent fields as `undefined`, at any depth (an install report's `receipt`, say).
    const dirty = (): Record<string, unknown> => ({
      kept: 'yes', gone: undefined, count: 1, zero: -0,
      nested: { gone: undefined, list: ['a', undefined, { gone: undefined, kept: true }] },
      // Enough of a plugin and a report for the methods that summarise one.
      plugin: { id: 'claude-code:p', name: 'p', source: 'claude-code', root: '/p', version: undefined, license: undefined, ref: { manifestKind: 'plugin.json' }, manifest: {}, components: [], warnings: [] },
      report: undefined, pluginId: 'claude-code:p', revision: 'r1', updated: false,
      receipt: undefined, outcomes: [], alreadyInstalled: true,
      name: 'm', entries: [], warnings: [], components: [],
    })
    const service = new Proxy({}, { get: (_target, key) => key === 'then' ? undefined : () => dirty() })
    const remote = remoteOver({
      install: dirty, installMarketplace: dirty, uninstall: () => true, setPartEnabled: () => true,
      scanMarketplace: dirty,
      remote: service,
      projects: { workspaces: () => [dirty()], setTrust: () => ({ stillLive: [dirty()] }), trust: { list: () => [dirty()], state: () => ({ workspace: '/nowhere', trusted: false, sources: [], gone: undefined }), dismiss: () => undefined } },
      ctx: {},
      statePath: join(import.meta.dirname, 'no-such-state'),
    }, { context: service, mcp: service, sessions: { sessions: () => [dirty()], importSession: dirty }, mods: service })
    Object.defineProperty(remote, 'workbench', { value: new Proxy({}, { get: () => () => dirty() }) })
    const request: Record<string, unknown> = {
      path: '/p', token: 't', input: 'i', id: 'claude-code:p', name: 'm', pluginId: 'claude-code:p', componentId: 'c', enabled: true,
      cwd: '/nowhere', trusted: true, dismissed: true, server: 's', source: 'claude-code', session: 's', pane: 'p', generation: 1,
    }
    const answered: string[] = []
    for (const [method, mode, takesRequest] of REMOTE_METHODS) {
      if (mode === 'stream' || ['adapterRead', 'portBrief', 'portGap', 'verifyPort', 'installChatImport'].includes(method)) continue
      const call = (remote as unknown as Record<string, (request?: unknown) => Promise<unknown>>)[method]!
      const answer = await call.call(remote, takesRequest ? request : undefined)
      expect(isRemoteJsonValue(answer) || answer === undefined, `${method} answers ${JSON.stringify(answer)}`).toBe(true)
      answered.push(method)
    }
    expect(answered).toEqual(expect.arrayContaining(['installPlugin', 'marketplaceInstall', 'remoteInstall', 'overview', 'sessions', 'importSession']))
    // An adapter's surface is the adapter's answer; it is cleaned the same way, read once or streamed.
    remote.registerAdapterSurface('dirty', { read: dirty })
    expect(isRemoteJsonValue(await remote.adapterRead({ adapter: 'dirty' }))).toBe(true)
    for await (const value of remote.adapterSurface({ adapter: 'dirty' }, AbortSignal.timeout(1000))) {
      expect(isRemoteJsonValue(value)).toBe(true)
      break
    }
    // A number JSON cannot carry is refused with a reason, not sent as null.
    remote.registerAdapterSurface('nan', { read: () => ({ at: Number.NaN }) })
    await expect(remote.adapterRead({ adapter: 'nan' })).rejects.toMatchObject({ code: 'harness-forge/failed', message: expect.stringMatching(/at.*NaN/u) })
  })

  it('tells a call the workbench row cannot answer (it is off) from an ordinary failure', async () => {
    const failing = (error: unknown) => ({ overview: () => Promise.resolve({ ok: false, error }), settings: () => Promise.reject(error as Error) })
    // What the browser's Remote namespace answers while no Host service serves harnessCompat (as DSH 0.2.2-rc.3 does).
    setMountedRemote(failing({ code: 'gateway/internal', message: 'client api: harnessCompat/overview failed: transport failure for /api/harnessCompat/overview: HTTP 404' }))
    expect(isWorkbenchOff(await call('overview').catch((error: unknown) => error))).toBe(true)
    // Other gateway answers for an endpoint nothing serves.
    setMountedRemote(failing({ code: 'gateway/invocation-unavailable', message: 'typert gateway: harnessCompat/overview: no active Remote method exports this endpoint' }))
    const off = await call('overview').catch((error: unknown) => error)
    expect(isWorkbenchOff(off)).toBe(true)
    expect(off).toMatchObject({ code: 'gateway/invocation-unavailable' })
    setMountedRemote(failing(Object.assign(new Error('typert gateway: harnessCompat/settings: active Service "harnessCompat" is unavailable'), { code: 'gateway/service-unavailable' })))
    expect(isWorkbenchOff(await call('settings').catch((error: unknown) => error))).toBe(true)
    // A failure the workbench itself reports is shown as it is.
    setMountedRemote(failing({ code: 'harness-forge/failed', message: 'the Harness Forge mcp row is off; turn it on in Plugin Manager' }))
    expect(isWorkbenchOff(await call('overview').catch((error: unknown) => error))).toBe(false)
    expect(isWorkbenchOff(new Error('network down'))).toBe(false)
    expect(isWorkbenchOff(new Error('client api: harnessCompat/overview failed: transport failure for /api/harnessCompat/overview: HTTP 502'))).toBe(false)
    // The notice is worded in both languages.
    for (const language of ['en', 'zh']) {
      const strings = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'src', 'client', 'locale', `${language}.json`), 'utf8')) as Record<string, string>
      expect(strings['workbenchOff']).toMatch(/workbench/u)
    }
  })

  it('ends the stream at once when the session\'s mods draw nothing', async () => {
    const remote = remoteOver({}, { mods: { watch: () => undefined } })
    const seen: unknown[] = []
    for await (const snapshot of remote.modSurfaces({ session: 's' })) seen.push(snapshot)
    expect(seen).toEqual([])
  })
})
