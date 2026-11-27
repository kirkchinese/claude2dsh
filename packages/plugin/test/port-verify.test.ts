import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { scanPlugin } from '@kirkchinese/harness-forge-core'
import { PortSessions, stateOf } from '../src/porting/port-sessions.js'
import { portPrompt, VERIFY_TOOL } from '../src/porting/prompt.js'
import { verifyPort, type PluginManagerLike, type VerifyDeps } from '../src/porting/verify-port.js'
import { HarnessRemoteService } from '../src/workbench/remote.js'
import type { AdapterCoverage } from '../src/workbench/overview.js'

const roots: string[] = []
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'hf-port-verify-'))
  roots.push(root)
  return root
}

/** A Claude Code plugin with a status line its installer writes. */
function hud(): ReturnType<typeof scanPlugin>['plugin'] {
  const root = temp()
  mkdirSync(join(root, '.claude-plugin'), { recursive: true })
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'claude-hud', license: 'MIT' }))
  writeFileSync(join(root, 'install.mjs'), "// points Claude Code's statusLine at the HUD in ~/.claude/settings.json\nexport {}\n")
  return scanPlugin(root, { source: 'claude-code' }).plugin
}

describe('the port prompt', () => {
  const plugin = { id: 'claude-code:claude-hud', name: 'claude-hud' }
  const component = { id: 'claude-code:claude-hud:ui:statusline', name: 'statusline' }
  const prompt = portPrompt({ plugin, component, brief: '# Port "statusline" of claude-hud to DSH\n\nfacts\n', language: 'zh-CN' })

  it('asks once, with the default source directory and the brief\'s questions, before writing code', () => {
    expect(prompt).toContain('Your first reply is ONE concise message')
    expect(prompt).toContain('Use only the brief: do not call tools, inspect files or the runtime, or plan the implementation before the answer')
    expect(prompt).toContain('Now read the original files and load the `dsh-doc` skill')
    expect(prompt).toContain('find and read the installed dsh-doc references directly')
    expect(prompt).toContain('`~/dsh-adapters/dsh-adapter-claude-hud-statusline`, because it is outside every workspace')
    expect(prompt).toContain('"Questions for the user" in the brief')
    expect(prompt).toMatch(/Never ask what you can look up/u)
    expect(prompt).toContain('Write no file before the answer')
  })

  it('builds autonomously, installs locally, and verifies with the tool before reporting', () => {
    expect(prompt).toContain('`plugin_manager` `install_bundle`')
    expect(prompt).toContain('reusing the original\'s code')
    expect(prompt).toContain(`\`${VERIFY_TOOL}\` with \`{"pluginId":"claude-code:claude-hud","componentId":"claude-code:claude-hud:ui:statusline"}\` answers \`"covered": true\``)
    expect(prompt).toMatch(/Only after 3 passed/u)
    expect(prompt).toMatch(/say exactly what blocks it/u)
  })

  it('names the user\'s language, and ends with the brief', () => {
    expect(prompt).toContain('Talk to the user in Chinese (简体中文), the language of their DSH interface')
    expect(portPrompt({ plugin, component, brief: 'b' })).toContain('Talk to the user in the language they write in.')
    expect(prompt.endsWith('---\n\n# Port "statusline" of claude-hud to DSH\n\nfacts\n')).toBe(true)
  })
})

describe('port sessions', () => {
  it('records a port in progress, its verification, and forgets deleted sessions', () => {
    const sessions = new PortSessions(join(temp(), 'state.json'))
    expect(sessions.list()).toEqual([])
    sessions.started('p', 'c1', 's1', new Date('2026-11-27T00:00:00Z'))
    sessions.started('p', 'c2', 's2')
    expect(stateOf(sessions.get('p', 'c1')!)).toBe('in-progress')
    sessions.verified('p', 'c1', 'dsh-adapter-p-c1')
    expect(sessions.get('p', 'c1')).toMatchObject({ sessionId: 's1', startedAt: '2026-11-27T00:00:00.000Z', adapter: 'dsh-adapter-p-c1', verifiedAt: expect.any(String) })
    expect(stateOf(sessions.get('p', 'c1')!)).toBe('verified')
    // Both sessions deleted: the in-progress port goes, so the part can be ported again; the verified one stays, unlinked.
    expect(sessions.prune(() => false)).toEqual([{ pluginId: 'p', componentId: 'c1', verifiedAt: expect.any(String), adapter: 'dsh-adapter-p-c1' }])
    expect(sessions.get('p', 'c2')).toBeUndefined()
  })

  it('takes back a verification that no longer holds, and starts over on a new session', () => {
    const sessions = new PortSessions(join(temp(), 'state.json'))
    sessions.started('p', 'c', 's1')
    sessions.verified('p', 'c', 'a')
    sessions.unverified('p', 'c')
    expect(sessions.get('p', 'c')).toEqual({ pluginId: 'p', componentId: 'c', sessionId: 's1', startedAt: expect.any(String) })
    sessions.verified('p', 'c', 'a')
    sessions.started('p', 'c', 's2')
    expect(sessions.get('p', 'c')).toEqual({ pluginId: 'p', componentId: 'c', sessionId: 's2', startedAt: expect.any(String) })
    sessions.forget('p', 'c')
    expect(sessions.list()).toEqual([])
  })

  it('reads an unreadable file as empty', () => {
    const dir = temp()
    writeFileSync(join(dir, 'ports.json'), '{not json')
    expect(new PortSessions(join(dir, 'state.json')).list()).toEqual([])
  })
})

describe('harness_verify_port', () => {
  const plugin = hud()
  const component = plugin.components.find(item => item.kind === 'ui')!
  const adapter: AdapterCoverage = { name: 'dsh-adapter-claude-hud-statusline', ports: [{ plugin: 'claude-hud', component: 'statusline' }], dir: '/home/u/dsh-adapters/dsh-adapter-claude-hud-statusline' }

  function manager(bundle: Partial<Awaited<ReturnType<PluginManagerLike['listBundles']>>[number]> | undefined, entries: Awaited<ReturnType<PluginManagerLike['listPlugins']>> = []): PluginManagerLike {
    return {
      listBundles: async () => bundle === undefined ? [] : [{ name: adapter.name, enabled: true, rows: [], ...bundle }],
      listPlugins: async () => entries,
    }
  }

  function deps(adapters: readonly AdapterCoverage[], pluginManager: PluginManagerLike | undefined): VerifyDeps {
    return {
      findPlugin: (id) => { if (id !== plugin.id) throw new Error(`no plugin ${id} is installed or discovered`); return { plugin } },
      adapters: () => adapters,
      pluginManager,
      sessions: new PortSessions(join(temp(), 'state.json')),
    }
  }

  it('covers the part when an enabled adapter declares it and its plugins are active; records it as verified', async () => {
    const d = deps([adapter], manager({ rows: [{ rowId: 'hud', entryId: 'e1' }] }, [{ entryId: 'e1', enabled: true, fiberPhase: 'active' }]))
    d.sessions.started(plugin.id, component.id, 'port-session')
    const result = await verifyPort(d, plugin.id, component.id, 'other-session')
    expect(result).toMatchObject({ covered: true, adapter: adapter.name, part: 'statusline', plugin: 'claude-hud' })
    expect(result.checks.map(check => [check.check, check.ok])).toEqual([['declared', true], ['enabled', true], ['loaded', true]])
    expect(result.checks[0]!.detail).toContain(adapter.dir)
    expect(d.sessions.get(plugin.id, component.id)).toMatchObject({ sessionId: 'port-session', adapter: adapter.name, verifiedAt: expect.any(String) })
  })

  it('links the calling session when the part was ported outside a recorded session', async () => {
    const d = deps([adapter], manager({}))
    expect((await verifyPort(d, plugin.id, component.id, 'caller')).covered).toBe(true)
    expect(d.sessions.get(plugin.id, component.id)).toMatchObject({ sessionId: 'caller', verifiedAt: expect.any(String) })
  })

  it('says what is missing when no package declares the part', async () => {
    const result = await verifyPort(deps([{ name: 'other', ports: [] }], manager({})), plugin.id, component.id)
    expect(result.covered).toBe(false)
    expect(result.checks).toEqual([{ check: 'declared', ok: false, detail: expect.stringContaining('"harnessForge": { "ports": [{"plugin":"claude-hud","component":"statusline"}] }') }])
  })

  it('fails while the adapter is off, broken, or its plugin did not start, and takes back an earlier verification', async () => {
    const off = await verifyPort(deps([adapter], manager({ enabled: false })), plugin.id, component.id)
    expect(off.checks[1]).toMatchObject({ check: 'enabled', ok: false, detail: expect.stringContaining('switched off') })
    const broken = await verifyPort(deps([adapter], manager({ error: { code: 'operation-error', diagnostic: 'SyntaxError' } })), plugin.id, component.id)
    expect(broken.checks[1]!.detail).toContain('operation-error — SyntaxError')
    expect((await verifyPort(deps([adapter], manager(undefined)), plugin.id, component.id)).checks[1]!.detail).toContain('does not list it as an installed bundle')
    expect((await verifyPort(deps([adapter], undefined), plugin.id, component.id)).checks[1]!.detail).toContain('no plugin manager')

    const d = deps([adapter], manager({ rows: [{ rowId: 'hud', entryId: 'e1' }, { rowId: 'gone' }] }, [{ entryId: 'e1', enabled: true, fiberPhase: 'failed', diagnostic: 'boom' }]))
    d.sessions.started(plugin.id, component.id, 's')
    d.sessions.verified(plugin.id, component.id, adapter.name)
    const failed = await verifyPort(d, plugin.id, component.id)
    expect(failed.covered).toBe(false)
    expect(failed.checks[2]).toEqual({ check: 'loaded', ok: false, detail: 'row "hud" failed to start: boom; row "gone" has no running entry' })
    expect(stateOf(d.sessions.get(plugin.id, component.id)!)).toBe('in-progress')
  })

  it('names an unknown part', async () => {
    await expect(verifyPort(deps([adapter], manager({})), plugin.id, 'nope')).rejects.toThrow(/claude-hud has no part nope; its parts are/u)
  })
})

describe('the port Remote methods', () => {
  it('lists ports without deleted sessions, and verifies through the same path as the tool', async () => {
    const plugin = hud()
    const component = plugin.components.find(item => item.kind === 'ui')!
    const statePath = join(temp(), 'state.json')
    const sessions = new PortSessions(statePath)
    sessions.started(plugin.id, component.id, 'alive')
    sessions.started(plugin.id, 'gone-part', 'deleted')
    const services: Record<string, unknown> = {
      sessionController: { list: async () => ({ items: [{ sessionId: 'alive' }] }) },
      pluginManager: { listBundles: async () => [{ name: 'dsh-adapter-claude-hud-statusline', enabled: true, rows: [] }], listPlugins: async () => [] },
    }
    const forge = { statePath, ctx: { get: (name: string) => services[name] } }
    const remote = Object.create(HarnessRemoteService.prototype) as HarnessRemoteService
    Object.defineProperty(remote, 'forge', { value: forge })
    Object.defineProperty(remote, 'workbench', { value: { findPlugin: () => ({ plugin, gaps: [] }), adapters: () => [{ name: 'dsh-adapter-claude-hud-statusline', ports: [] }] } })

    expect(await remote.portSessions()).toEqual({ ports: [{ pluginId: plugin.id, componentId: component.id, sessionId: 'alive', startedAt: expect.any(String), state: 'in-progress' }] })
    expect(await remote.verifyPort({ pluginId: plugin.id, componentId: component.id })).toMatchObject({ covered: true })
    expect(await remote.portSessions()).toEqual({ ports: [expect.objectContaining({ sessionId: 'alive', state: 'verified', adapter: 'dsh-adapter-claude-hud-statusline' })] })
    await expect(remote.verifyPort({ pluginId: plugin.id })).rejects.toMatchObject({ message: 'componentId is required' })
  })
})
