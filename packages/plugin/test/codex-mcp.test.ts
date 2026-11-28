import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { codexHome, type ForeignPlugin, type McpComponent } from '@kirkchinese/harness-forge-core'
import type { Mounter, MountRequest } from '../src/forge/contract.js'
import { harnessVariables, mcpClientConfig, mcpServerName, mountMcp, type RemoteMcpHost } from '../src/mcp/mount.js'
import { mcpToolPolicy } from '../src/mcp/policy.js'
import { McpAuthStore } from '../src/mcp/auth.js'
import { HarnessForge } from '../src/forge/service.js'
import { startMcp } from '../src/mcp/row.js'

const temporary: string[] = []
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-forge-codex-mcp-'))
  temporary.push(dir)
  return dir
}

/** A plugin root in this platform's own form (on Windows, a drive and backslashes), as Forge resolves paths. */
const ROOT = resolve('/plugins/demo')
const vars = { pluginRoot: ROOT, dataDir: '/data' }

function component(overrides: Partial<McpComponent>): McpComponent {
  return { id: 'codex:demo:mcp:demo', kind: 'mcp', name: 'demo', transport: 'stdio', ...overrides } as McpComponent
}

/** The openai-bundled code-review server, as Forge reads it. */
const codeReview = component({
  command: '/bin/sh',
  args: ['-c', 'exec "$CODEX_MCP_NODE_PATH" ./server.mjs "$@"', '--'],
  cwd: '.',
  env: { CODEX_HOME: '${CODEX_HOME}', CODEX_MCP_NODE_PATH: '${CODEX_MCP_NODE_PATH}' },
})

describe('Codex-provided variables', () => {
  it('gives a Codex plugin server the Node.js running DSH and the Codex home, and nothing to other plugins', () => {
    expect(harnessVariables({ source: 'codex' })).toEqual({ CODEX_HOME: codexHome(), CODEX_MCP_NODE_PATH: process.execPath })
    expect(harnessVariables({ source: 'claude-code' })).toEqual({})
    const config = mcpClientConfig(codeReview, 'code-review', { ...vars, provided: harnessVariables({ source: 'codex' }) })
    expect(config['env']).toMatchObject({ CODEX_MCP_NODE_PATH: process.execPath, CODEX_HOME: codexHome() })
    expect(config['cwd']).toBe(ROOT)
  })

  it('refuses to start a server whose command needs a variable nothing sets, instead of running an empty program', () => {
    const before = process.env['CODEX_MCP_NODE_PATH']
    delete process.env['CODEX_MCP_NODE_PATH']
    try {
      expect(() => mcpClientConfig(codeReview, 'code-review', vars)).toThrow(/needs CODEX_MCP_NODE_PATH, which DSH does not provide/u)
      expect(() => mcpClientConfig(component({ command: '${CODEX_MCP_NODE_PATH}', args: ['server.mjs'] }), 'demo', vars)).toThrow(/needs CODEX_MCP_NODE_PATH/u)
      // A shell variable the server does not declare may be the script's own.
      expect(() => mcpClientConfig(component({ command: '/bin/sh', args: ['-c', 'for f in *; do echo $f; done'] }), 'demo', vars)).not.toThrow()
    } finally {
      if (before !== undefined) process.env['CODEX_MCP_NODE_PATH'] = before
    }
  })
})

describe('Codex timeouts', () => {
  it('uses startup_timeout_sec and tool_timeout_sec where the client takes them', () => {
    expect(mcpClientConfig(component({ command: 'node', startupTimeoutMs: 10_000, toolTimeoutMs: 120_000 }), 'demo', vars)).toMatchObject({ startupTimeoutMs: 10_000, toolCallTimeoutMs: 120_000 })
    expect(mcpClientConfig(component({ command: 'node' }), 'demo', vars)['startupTimeoutMs']).toBeUndefined()
  })
})

describe('Codex tool filters and approval modes', () => {
  const filtered = component({
    enabledTools: ['create_thread', 'automation_update', 'read'],
    disabledTools: ['automation_update'],
    toolApproval: { askByDefault: false, tools: { create_thread: true } },
  })

  it('refuses switched-off tools and asks before prompting ones', () => {
    const policy = mcpToolPolicy(filtered, 'app')!
    expect(policy.decide(undefined, 'mcp__app__other')?.kind).toBe('deny')
    expect(policy.decide('other', 'mcp__app__other')?.kind).toBe('deny')
    expect(policy.decide('automation_update', 'mcp__app__automation_update')?.kind).toBe('deny')
    expect(policy.decide('create_thread', 'mcp__app__create_thread')?.kind).toBe('ask')
    expect(policy.decide('read', 'mcp__app__read')).toBeUndefined()
    expect(policy.rawName('mcp__app__create_thread')).toBe('create_thread')
    expect(policy.rawName('mcp__elsewhere__create_thread')).toBeUndefined()
    const asking = mcpToolPolicy(component({ toolApproval: { askByDefault: true, tools: { read: false } } }), 'app')!
    expect(asking.decide('read', 'mcp__app__read')).toBeUndefined()
    expect(asking.decide('toString', 'mcp__app__toString')?.kind).toBe('ask')
    expect(mcpToolPolicy(component({}), 'app')).toBeUndefined()
  })

  it('hands the filters to the capability catalog', async () => {
    const added: Array<Record<string, unknown>> = []
    const catalog = { async addMcpServer(server: Record<string, unknown>) { added.push(server); return async () => {} } }
    const ctx = { get: (name: string) => name === 'capabilityCatalogServers' ? catalog : undefined }
    const host: RemoteMcpHost = { auth: new McpAuthStore(join(tempDir(), 'auth')), onState() {} }
    await mountMcp(ctx as unknown as Context, component({ ...filtered, command: 'node', toolTimeoutMs: 5000, startupTimeoutMs: 3000 }), 'app', vars, host)
    expect(added[0]).toMatchObject({ allowTools: ['create_thread', 'automation_update', 'read'], denyTools: ['automation_update'], callTimeoutMs: 5000, discoveryTimeoutMs: 3000 })
    await mountMcp(ctx as unknown as Context, component({ command: 'node', enabledTools: [] }), 'none', vars, host)
    expect(added[1]).toMatchObject({ allowTools: [], denyTools: ['*'] })
  })

  it('enforces them on a direct mount when a call is made', async () => {
    const root = tempDir()
    const plugin = join(root, 'plugin')
    mkdirSync(join(plugin, '.codex-plugin'), { recursive: true })
    writeFileSync(join(plugin, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'app', version: '1.0.0' }))
    writeFileSync(join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { app: { command: 'node', args: ['server.mjs'], enabled_tools: ['read', 'create_thread'], tools: { create_thread: { approval_mode: 'prompt' } } } } }))
    const listeners = new Map<string, (...args: unknown[]) => unknown>()
    const ctx = {
      get: () => undefined,
      on: (name: string, listener: (...args: unknown[]) => unknown) => { listeners.set(name, listener); return () => {} },
      effect: <T>(run: () => T): T => run(),
      inject: () => ({ dispose() {} }),
      plugin: () => Object.assign(Promise.resolve(), { dispose: async () => {} }),
    }
    const forge = new HarnessForge(ctx as never, join(root, 'state.json'), join(root, 'data'))
    const stop = startMcp(ctx as unknown as Context, forge)
    await forge.install(plugin, 'codex')
    await forge.ready()
    expect(forge.list()[0]?.outcomes?.find(outcome => outcome.componentId.endsWith(':mcp:app'))?.status).toBe('mounted')
    const preExecute = listeners.get('tools/pre-execute')!
    const allow = async () => ({ kind: 'allow' })
    await expect(preExecute({ name: 'mcp__app__delete', arguments: {} }, allow)).resolves.toMatchObject({ kind: 'deny' })
    await expect(preExecute({ name: 'mcp__app__create_thread', arguments: {} }, allow)).resolves.toMatchObject({ kind: 'ask' })
    await expect(preExecute({ name: 'mcp__app__read', arguments: {} }, allow)).resolves.toEqual({ kind: 'allow' })
    // Another rule's denial stands.
    await expect(preExecute({ name: 'mcp__app__create_thread', arguments: {} }, async () => ({ kind: 'deny', reason: 'no' }))).resolves.toEqual({ kind: 'deny', reason: 'no' })
    await forge.dispose()
    await stop()
  })

  it('does not count a refused call as a fault of the server: the refusal is the policy\'s, the server never ran', async () => {
    const root = tempDir()
    const plugin = codexServers(root, { app: { command: 'node', args: ['server.mjs'], enabled_tools: ['read'] } })
    const listeners = new Map<string, (...args: unknown[]) => unknown>()
    const ctx = {
      get: () => undefined,
      on: (name: string, listener: (...args: unknown[]) => unknown) => { listeners.set(name, listener); return () => {} },
      effect: <T>(run: () => T): T => run(),
      inject: () => ({ dispose() {} }),
      plugin: () => Object.assign(Promise.resolve(), { dispose: async () => {} }),
    }
    const forge = new HarnessForge(ctx as never, join(root, 'state.json'), join(root, 'data'))
    const stop = startMcp(ctx as unknown as Context, forge)
    await forge.install(plugin, 'codex')
    await forge.ready()
    const outcome = () => forge.list()[0]!.outcomes!.find(item => item.componentId.endsWith(':mcp:app'))
    // As the tool pipeline runs a refused call: the same execution through pre-execute, then post-execute with the error result.
    const call = async (name: string, result: { isError: boolean; error?: { message: string } }) => {
      const exec = { name, arguments: {} }
      const decision = await listeners.get('tools/pre-execute')!(exec, async () => ({ kind: 'allow' })) as { kind: string; reason?: string }
      const final = decision.kind === 'deny' ? { isError: true, error: { message: decision.reason! } } : result
      await listeners.get('tools/post-execute')!(exec, final, async () => ({ kind: 'accept' }))
    }
    await call('mcp__app__delete', { isError: false })
    expect(outcome()).toMatchObject({ status: 'mounted' })
    expect(outcome()?.observations ?? []).toEqual([])
    // A call that ran and failed still is the server's evidence.
    await call('mcp__app__read', { isError: true, error: { message: 'boom' } })
    expect(outcome()?.observations).toEqual([expect.objectContaining({ signal: 'tool:mcp__app__read', ok: false, detail: 'boom' })])
    await forge.dispose()
    await stop()
  })

  /**
   * A host whose server mounts register at once and whose withdrawals fail while `failing` says so; with
   * `catalog`, the capability catalog is composed, so a process-wide stdio server is served through it.
   */
  function directHost(root: string, state: { failing: boolean }, catalog?: { addMcpServer(server: Record<string, unknown>): Promise<() => Promise<void>> }) {
    const listeners = new Map<string, (...args: unknown[]) => unknown>()
    const ctx = {
      get: (name: string) => name === 'capabilityCatalogServers' ? catalog : undefined,
      on: (name: string, listener: (...args: unknown[]) => unknown) => { listeners.set(name, listener); return () => {} },
      effect: <T>(run: () => T): T => run(),
      inject: () => ({ dispose() {} }),
      plugin: () => Object.assign(Promise.resolve(), {
        dispose: async () => { if (state.failing) throw new Error('withdrawal failed') },
      }),
    }
    const forge = new HarnessForge(ctx as never, join(root, 'state.json'), join(root, 'data'))
    let registered: Mounter | undefined
    const register = forge.registerMounter.bind(forge)
    forge.registerMounter = (kind, mounter) => {
      if (kind === 'mcp') registered = mounter
      return register(kind, mounter)
    }
    const stop = startMcp(ctx as unknown as Context, forge)
    return {
      forge, stop, mounter: () => registered!,
      preExecute: (name: string, args: unknown = {}, sessionId?: string) => listeners.get('tools/pre-execute')!({ name, arguments: args, ...(sessionId !== undefined ? { agent: { session: { header: { id: sessionId } } } } : {}) }, async () => ({ kind: 'allow' })),
    }
  }

  it('checks a catalog call against the catalog\'s server and a direct call against the direct one, when both share a name', async () => {
    const root = tempDir()
    const catalog = { async addMcpServer() { return async () => {} } }
    const { forge, stop, preExecute, mounter } = directHost(root, { failing: false }, catalog)
    const plugin = { source: 'codex', name: 'app', root } as unknown as ForeignPlugin
    const mount = (overrides: Partial<McpComponent>, scope: Record<string, unknown>) => mounter().mount({ component: component({ command: 'node', args: ['server.mjs'], ...overrides }), plugin, dataDir: root, scope } as unknown as MountRequest)
    // The process-wide server goes into the catalog and asks before `x`; a session's own `app` mounts directly and allows it.
    await mount({ id: 'codex:app:mcp:global', name: 'app', toolApproval: { askByDefault: false, tools: { x: true } } }, {})
    await mount({ id: 'codex:app:mcp:local', name: 'app' }, { sessionId: 's1' })
    await expect(preExecute('capability_call', { id: 'mcp:app/x' }, 's1')).resolves.toMatchObject({ kind: 'ask' })
    await expect(preExecute('capability_call', { id: 'mcp:app/x' })).resolves.toMatchObject({ kind: 'ask' })
    await expect(preExecute('mcp__app__x', {}, 's1')).resolves.toEqual({ kind: 'allow' })
    await forge.dispose()
    await stop()
  })

  it('binds a catalog call to its own server when one server name begins with another and "__"', async () => {
    const root = tempDir()
    const reports = mcpServerName('app__reports')
    const { forge, stop, preExecute, mounter } = directHost(root, { failing: false }, { async addMcpServer() { return async () => {} } })
    const plugin = { source: 'codex', name: 'app', root } as unknown as ForeignPlugin
    const mount = (overrides: Partial<McpComponent>) => mounter().mount({ component: component({ command: 'node', args: ['server.mjs'], ...overrides }), plugin, dataDir: root, scope: {} } as unknown as MountRequest)
    await mount({ id: 'codex:app:mcp:app', name: 'app', disabledTools: ['other'] })
    await mount({ id: 'codex:app:mcp:reports', name: 'app__reports', enabledTools: ['x'], toolApproval: { askByDefault: false, tools: { x: true } } })
    await expect(preExecute('capability_call', { id: `mcp:${reports}/x` })).resolves.toMatchObject({ kind: 'ask' })
    await expect(preExecute('capability_call', { id: 'mcp:app/reports__x' })).resolves.toEqual({ kind: 'allow' })
    await expect(preExecute('capability_call', { id: 'mcp:app/other' })).resolves.toMatchObject({ kind: 'deny' })
    await forge.dispose()
    await stop()
  })

  function codexServers(root: string, servers: Record<string, unknown>): string {
    const plugin = join(root, 'plugin')
    mkdirSync(join(plugin, '.codex-plugin'), { recursive: true })
    writeFileSync(join(plugin, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'app', version: '1.0.0' }))
    writeFileSync(join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: servers }))
    return plugin
  }

  it('binds a call to its own server when one server name begins with another and "__"', async () => {
    const root = tempDir()
    const reports = mcpServerName('app__reports')
    expect(reports).not.toContain('__')
    expect(reports).not.toBe(mcpServerName('app_reports'))
    // A plugin's own server names are kebab-cased; `__` reaches the row from names Forge does not scan itself.
    const { forge, stop, preExecute, mounter } = directHost(root, { failing: false })
    const plugin = { source: 'codex', name: 'app', root } as unknown as ForeignPlugin
    const mount = (overrides: Partial<McpComponent>) => mounter().mount({ component: component({ command: 'node', args: ['server.mjs'], ...overrides }), plugin, dataDir: root, scope: {} } as unknown as MountRequest)
    await mount({ id: 'codex:app:mcp:app', name: 'app', disabledTools: ['other'] })
    await mount({ id: 'codex:app:mcp:reports', name: 'app__reports', enabledTools: ['x'], toolApproval: { askByDefault: false, tools: { x: true } } })
    // `app__reports` asks before `x` and refuses everything else.
    await expect(preExecute(`mcp__${reports}__x`)).resolves.toMatchObject({ kind: 'ask' })
    await expect(preExecute(`mcp__${reports}__y`)).resolves.toMatchObject({ kind: 'deny' })
    // `app`'s own tool `reports__x` is `app`'s, which allows it.
    await expect(preExecute('mcp__app__reports__x')).resolves.toEqual({ kind: 'allow' })
    await expect(preExecute('mcp__app__other')).resolves.toMatchObject({ kind: 'deny' })
    // Through the capability catalog: see the catalog-host test of the same name. Without the catalog no server is
    // registered there, so a catalog call meets no policy here (and the catalog has nothing to run).
    await expect(preExecute('capability_call', { id: `mcp:${reports}/x` })).resolves.toEqual({ kind: 'allow' })
    await forge.dispose()
    await stop()
  })

  it('keeps a server\'s policy while its withdrawal fails and drops it once a withdrawal succeeds', async () => {
    const root = tempDir()
    const plugin = codexServers(root, { app: { command: 'node', args: ['server.mjs'], enabled_tools: ['read'] } })
    const state = { failing: true }
    const { forge, stop, preExecute } = directHost(root, state)
    await forge.install(plugin, 'codex')
    await forge.ready()
    const pluginId = forge.list()[0]!.id
    const componentId = forge.list()[0]!.outcomes!.find(outcome => outcome.componentId.endsWith(':mcp:app'))!.componentId
    await forge.setPartEnabled(pluginId, componentId, false).catch(() => false)
    // The tools are still registered, so their filter still holds.
    await expect(preExecute('mcp__app__delete')).resolves.toMatchObject({ kind: 'deny' })
    state.failing = false
    await forge.dispose()
    await expect(preExecute('mcp__app__delete')).resolves.toEqual({ kind: 'allow' })
    await stop()
  })
})

describe('servers that do not start', () => {
  function codexPlugin(servers: Record<string, unknown>): { root: string; plugin: string } {
    const root = tempDir()
    const plugin = join(root, 'plugin')
    mkdirSync(join(plugin, '.codex-plugin'), { recursive: true })
    mkdirSync(join(plugin, 'skills', 'one'), { recursive: true })
    writeFileSync(join(plugin, 'skills', 'one', 'SKILL.md'), '---\nname: one\ndescription: One\n---\n\nOne.\n')
    writeFileSync(join(plugin, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }))
    writeFileSync(join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: servers }))
    return { root, plugin }
  }

  it('skips a disabled or ChatGPT-authenticated server with the reason', async () => {
    const { root, plugin } = codexPlugin({
      off: { command: '/bin/sh', enabled: false },
      promo: { type: 'http', url: 'https://chatgpt.com/mcp', auth: 'chatgpt' },
    })
    const forge = new HarnessForge({ get: () => undefined } as never, join(root, 'state.json'), join(root, 'data'))
    const tried: string[] = []
    forge.registerMounter('mcp', { mount: async ({ component }) => { tried.push(component.name); throw new Error(`${component.name} failed`) } })
    await forge.install(plugin, 'codex')
    await forge.ready()
    const outcome = (name: string) => forge.list()[0]?.outcomes?.find(item => item.componentId.endsWith(`:mcp:${name}`))
    expect(outcome('off')).toMatchObject({ status: 'skipped', message: 'disabled in the plugin' })
    expect(outcome('promo')).toMatchObject({ status: 'skipped', message: 'needs ChatGPT sign-in, which DSH cannot provide' })
    expect(tried).toEqual([])
    await forge.dispose()
  })

  it('tries a server that failed again only when its own row comes back, not once per row starting at boot', async () => {
    const { root, plugin } = codexPlugin({ broken: { command: 'broken' } })
    const forge = new HarnessForge({ get: () => undefined } as never, join(root, 'state.json'), join(root, 'data'))
    let tried = 0
    const failing = { mount: async (): Promise<never> => { tried++; throw new Error('broken failed') } }
    const stopMcp = forge.registerMounter('mcp', failing)
    await forge.install(plugin, 'codex')
    await forge.ready()
    expect(tried).toBe(1)
    forge.registerMounter('skill', { mount: async ({ component }) => ({ outcome: { componentId: component.id, status: 'mounted', level: 'L1a', evidence: 'source' } }) })
    forge.registerMounter('command', { mount: async ({ component }) => ({ outcome: { componentId: component.id, status: 'mounted', level: 'L1b', evidence: 'source' } }) })
    await forge.ready()
    expect(tried).toBe(1)
    expect(forge.list()[0]?.outcomes?.find(item => item.componentId.endsWith(':mcp:broken'))).toMatchObject({ status: 'failed', message: 'broken failed' })
    stopMcp()
    await forge.ready()
    forge.registerMounter('mcp', failing)
    await forge.ready()
    expect(tried).toBe(2)
    await forge.dispose()
  })
})
