import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import { HookBroker, type HookObservation } from '../src/hooks/broker.js'
import { parseHookTable } from '../src/hooks/config.js'
import { createForeignShell } from '../src/hooks/shell.js'
import { scanPlugin, type ForeignPlugin, type McpComponent } from '@kirkchinese/harness-forge-core'
import type { Mounter, MountRequest } from '../src/forge/contract.js'
import { HarnessForge } from '../src/forge/service.js'
import { mcpServerName } from '../src/mcp/mount.js'
import { publicToolName } from '../src/mcp/policy.js'
import { startMcp } from '../src/mcp/row.js'

/**
 * A Codex `mcp_tool` hook names the server the way its configuration does
 * (https://developers.openai.com/codex/hooks, "MCP tool hooks": `server` is the
 * name of an already-connected MCP server), as its plugin declares it. Harness
 * Forge registers that server under its own name (kebab-cased, then
 * `mcpServerName`), directly as `mcp__<server>__<tool>` or in the capability
 * catalog as `mcp:<server>/<tool>`; the hook has to reach the same one.
 */

const temporary: string[] = []
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Call {
  readonly name: string
  readonly args: unknown
}

/** A plugin folder for `scanPlugin`: its manifest, its `.mcp.json` servers and, optionally, the user scope. */
interface PluginSpec {
  readonly name: string
  readonly source: 'codex' | 'claude-code'
  readonly servers: Readonly<Record<string, Record<string, unknown>>>
  readonly user?: boolean
}

/**
 * A hook lab with a real MCP row: each plugin is scanned as Harness Forge scans it, its servers are mounted
 * through the row's mounter (directly, or into a capability catalog), and the hook of `hookPlugin` resolves its
 * server as the hooks row has the broker resolve it.
 */
async function serversLab(plugins: readonly PluginSpec[], hookPlugin: string, handler: Record<string, unknown>, catalog: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'harness-forge-hook-servers-'))
  temporary.push(root)
  const calls: Call[] = []
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>()
  const tool = (name: string) => ({
    execute: async (args: unknown) => {
      calls.push({ name, args })
      return { text: '{}' }
    },
    output: { render: (_args: unknown, value: { text: string }) => [{ type: 'text', text: value.text }] },
  })
  // Every direct MCP tool name answers, so only the resolution decides which one a hook calls.
  const tools = { get: (name: string) => catalog ? name === 'capability_call' ? tool(name) : undefined : name.startsWith('mcp__') ? tool(name) : undefined }
  const catalogService = { async addMcpServer() { return async () => {} } }
  const ctx = {
    fiber: { state: 2, parent: { fiber: { state: 2 } } },
    get: (name: string) => name === 'tools' ? tools : name === 'capabilityCatalogServers' && catalog ? catalogService : undefined,
    on(name: string, listener: (...args: unknown[]) => unknown) {
      listeners.set(name, [...listeners.get(name) ?? [], listener])
      return () => {}
    },
    effect: <T>(run: () => T): T => run(),
    inject: () => ({ dispose() {} }),
    plugin: () => Object.assign(Promise.resolve(), { dispose: async () => {} }),
  }
  const forge = new HarnessForge(ctx as never, join(root, 'state.json'), join(root, 'data'))
  let mounter: Mounter | undefined
  const register = forge.registerMounter.bind(forge)
  forge.registerMounter = (kind, next) => {
    if (kind === 'mcp') mounter = next
    return register(kind, next)
  }
  const stopMcp = startMcp(ctx as unknown as Context, forge)
  const ids = new Map<string, string>()
  for (const spec of plugins) {
    const dir = join(root, spec.name)
    mkdirSync(join(dir, spec.source === 'codex' ? '.codex-plugin' : '.claude-plugin'), { recursive: true })
    writeFileSync(join(dir, spec.source === 'codex' ? '.codex-plugin' : '.claude-plugin', 'plugin.json'), JSON.stringify({ name: spec.name, version: '1.0.0' }))
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: spec.servers }))
    const scanned = scanPlugin(dir, { source: spec.source }).plugin
    const plugin = spec.user === true ? { ...scanned, manifest: { ...scanned.manifest, scope: 'user' } } : scanned
    ids.set(spec.name, plugin.id)
    for (const component of plugin.components.filter(part => part.kind === 'mcp')) {
      await mounter!.mount({ component, plugin, dataDir: dir, scope: {} } as unknown as MountRequest)
    }
  }
  const observations: HookObservation[] = []
  const broker = new HookBroker(ctx as unknown as Context, {
    shell: createForeignShell(),
    dataRoot: join(root, 'data'),
    observe: (observation) => { observations.push(observation) },
    agentName: () => undefined,
    environment: () => ({}),
    permissionRules: () => ({ allow: [], deny: [], ask: [] }),
    hooksDisabled: () => false,
    mcpToolPolicy: call => forge.lookup('mcp')?.toolPolicy(call),
    mcpHookServer: (pluginId, server, sessionId) => forge.lookup('mcp')?.hookServer(pluginId, server, sessionId),
  })
  broker.install()
  const pluginId = ids.get(hookPlugin) ?? `codex:${hookPlugin}`
  broker.add({ componentId: `${pluginId}:hooks`, pluginId, dialect: 'codex', pluginRoot: root, dataDir: root, table: parseHookTable({ hooks: { Stop: [{ hooks: [handler] }] } }), origin: 'plugin' })
  const stop = async (): Promise<void> => {
    const agent = { session: Session.create('session-root' as never), options: { provider: 'p', model: 'm' }, inject: () => {}, steer: () => {}, followup: () => {}, cancel: () => {} }
    await listeners.get('agent/turn-stopping')?.[0]?.({ agent, turn: 1, signal: new AbortController().signal })
    await broker.drain()
    await forge.dispose()
    await stopMcp()
  }
  return { calls, observations, stop }
}

describe('Codex mcp_tool hooks', () => {
  const hook = (server: string) => ({ type: 'mcp_tool', server, tool: 'turn_ended', input: { session_id: '${session_id}' } })
  const expectCalled = (calls: readonly Call[], registered: string, catalog: boolean): void => {
    expect(calls).toEqual([catalog
      ? { name: 'capability_call', args: { id: `mcp:${registered}/turn_ended`, arguments: { session_id: 'session-root' } } }
      : { name: publicToolName(registered, 'turn_ended'), args: { session_id: 'session-root' } }])
  }
  for (const catalog of [false, true]) {
    const route = catalog ? 'through the capability catalog' : 'directly'
    // unified-computer-use's own shape: its `.mcp.json` declares `cua_repl`, which Forge registers as `cua-repl`.
    for (const declared of ['cua_repl', 'cua-repl']) {
      it(`reaches its own plugin's server "${declared}" by the name the plugin declared (${route})`, async () => {
        const lab = await serversLab([{ name: 'unified-computer-use', source: 'codex', servers: { [declared]: { command: 'node', args: ['repl.mjs'] } } }], 'unified-computer-use', hook(declared), catalog)
        await lab.stop()
        expectCalled(lab.calls, mcpServerName('cua-repl'), catalog)
        expect(lab.observations).toEqual([expect.objectContaining({ ok: true })])
      })
    }

    it(`reads the scoped form plugin:<plugin>:<server> within that plugin (${route})`, async () => {
      const lab = await serversLab([{ name: 'my-plugin', source: 'claude-code', servers: { the_server: { command: 'node' } } }], 'my-plugin', hook('plugin:my-plugin:the_server'), catalog)
      await lab.stop()
      expectCalled(lab.calls, mcpServerName('plugin_my-plugin_the-server'), catalog)
    })

    it(`never reaches another plugin's server of the same name (${route})`, async () => {
      const lab = await serversLab([
        { name: 'hooks-only', source: 'codex', servers: {} },
        { name: 'other', source: 'codex', servers: { cua_repl: { command: 'node' } } },
      ], 'hooks-only', hook('cua_repl'), catalog)
      await lab.stop()
      expect(lab.calls).toEqual([])
      expect(lab.observations).toEqual([expect.objectContaining({ ok: false, detail: expect.stringMatching(/cua_repl/u) })])
    })

    it(`falls back to the user's own servers by their declared names (${route})`, async () => {
      const lab = await serversLab([
        { name: 'hooks-only', source: 'codex', servers: {} },
        { name: 'codex-user', source: 'codex', servers: { cua_repl: { command: 'node' } }, user: true },
      ], 'hooks-only', hook('cua_repl'), catalog)
      await lab.stop()
      expectCalled(lab.calls, mcpServerName('cua-repl'), catalog)
    })
  }

  it('reports a server neither its plugin nor the user declares', async () => {
    const lab = await serversLab([{ name: 'app', source: 'codex', servers: {} }], 'app', hook('cua-repl'), false)
    await lab.stop()
    expect(lab.calls).toEqual([])
    expect(lab.observations).toEqual([expect.objectContaining({ ok: false })])
  })
})

/**
 * A hook lab with a real MCP row: its servers are mounted through the row's mounter (directly, or into a capability
 * catalog when `catalog` is set), and the hooks see the row's tool policy as the hooks row hands it to the broker.
 */
async function policyLab(handler: Record<string, unknown>, server: Record<string, unknown>, catalog: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'harness-forge-hook-mcp-policy-'))
  temporary.push(root)
  const serverName = mcpServerName(String(server['name']))
  const registered = catalog ? ['capability_call'] : [publicToolName(serverName, 'allowed'), publicToolName(serverName, 'asking'), publicToolName(serverName, 'hidden')]
  const calls: Call[] = []
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>()
  const tools = {
    get: (name: string) => registered.includes(name)
      ? {
          execute: async (args: unknown) => {
            calls.push({ name, args })
            return { text: '{}' }
          },
          output: { render: (_args: unknown, value: { text: string }) => [{ type: 'text', text: value.text }] },
        }
      : undefined,
  }
  const catalogService = { async addMcpServer() { return async () => {} } }
  const ctx = {
    fiber: { state: 2, parent: { fiber: { state: 2 } } },
    get: (name: string) => name === 'tools' ? tools : name === 'capabilityCatalogServers' && catalog ? catalogService : undefined,
    on(name: string, listener: (...args: unknown[]) => unknown) {
      listeners.set(name, [...listeners.get(name) ?? [], listener])
      return () => {}
    },
    effect: <T>(run: () => T): T => run(),
    inject: () => ({ dispose() {} }),
    plugin: () => Object.assign(Promise.resolve(), { dispose: async () => {} }),
  }
  const forge = new HarnessForge(ctx as never, join(root, 'state.json'), join(root, 'data'))
  let mounter: Mounter | undefined
  const register = forge.registerMounter.bind(forge)
  forge.registerMounter = (kind, next) => {
    if (kind === 'mcp') mounter = next
    return register(kind, next)
  }
  const stopMcp = startMcp(ctx as unknown as Context, forge)
  const plugin = { id: 'codex:app', source: 'codex', name: 'app', root } as unknown as ForeignPlugin
  const component = { id: 'codex:app:mcp:app', kind: 'mcp', transport: 'stdio', command: 'node', args: ['server.mjs'], ...server } as unknown as McpComponent
  await mounter!.mount({ component, plugin, dataDir: root, scope: {} } as unknown as MountRequest)
  const observations: HookObservation[] = []
  const broker = new HookBroker(ctx as unknown as Context, {
    shell: createForeignShell(),
    dataRoot: join(root, 'data'),
    observe: (observation) => { observations.push(observation) },
    agentName: () => undefined,
    environment: () => ({}),
    permissionRules: () => ({ allow: [], deny: [], ask: [] }),
    hooksDisabled: () => false,
    mcpToolPolicy: call => forge.lookup('mcp')?.toolPolicy(call),
    mcpHookServer: (pluginId, name, sessionId) => forge.lookup('mcp')?.hookServer(pluginId, name, sessionId),
  })
  broker.install()
  broker.add({ componentId: 'codex:app', pluginId: 'codex:app', dialect: 'codex', pluginRoot: root, dataDir: root, table: parseHookTable({ hooks: { Stop: [{ hooks: [handler] }] } }), origin: 'plugin' })
  const stop = async (): Promise<void> => {
    const agent = { session: Session.create('session-root' as never), options: { provider: 'p', model: 'm' }, inject: () => {}, steer: () => {}, followup: () => {}, cancel: () => {} }
    await listeners.get('agent/turn-stopping')?.[0]?.({ agent, turn: 1, signal: new AbortController().signal })
    await broker.drain()
    await forge.dispose()
    await stopMcp()
  }
  return { calls, observations, stop }
}

describe('Codex mcp_tool hooks under the server\'s tool policy', () => {
  // `enabled_tools` leaves `hidden` out; `asking` needs approval (https://developers.openai.com/codex/config-reference, `mcp_servers.<id>.tools.<tool>.approval_mode`).
  const server = { name: 'app', enabledTools: ['allowed', 'asking'], toolApproval: { askByDefault: false, tools: { asking: true } } }
  const call = (tool: string) => ({ type: 'mcp_tool', server: 'app', tool, input: {} })
  for (const catalog of [false, true]) {
    const route = catalog ? 'through the capability catalog' : 'directly'
    it(`refuses a tool the server's filters leave out, as if it did not exist (${route})`, async () => {
      const hooks = await policyLab(call('hidden'), server, catalog)
      await hooks.stop()
      expect(hooks.calls).toEqual([])
      expect(hooks.observations).toEqual([expect.objectContaining({ ok: false, detail: expect.stringMatching(/mcp__app__hidden is not available/u) })])
    })

    it(`runs an allowed tool, and one that needs approval without asking, as Codex does (${route})`, async () => {
      for (const tool of ['allowed', 'asking']) {
        const hooks = await policyLab(call(tool), server, catalog)
        await hooks.stop()
        expect(hooks.calls, tool).toHaveLength(1)
        expect(hooks.observations, tool).toEqual([expect.objectContaining({ ok: true })])
      }
    })
  }
})
