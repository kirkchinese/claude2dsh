import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { McpComponent } from '@kirkchinese/harness-forge-core'
import { expandVariables, foreignServerName, mcpClientConfig, mcpServerName, mountMcp, UnsupportedMcpTransportError, type RemoteMcpHost } from '../src/mcp/mount.js'
import { McpAuthStore } from '../src/mcp/auth.js'
// @ts-expect-error -- plain ESM fixture without type declarations
import { startOAuthMcpServer } from './fixtures/oauth-mcp-server.mjs'

// Absolute on this platform, so resolving a relative command against the root stays under it.
const ROOT = process.platform === 'win32' ? 'C:/plugins/demo' : '/plugins/demo'
const DATA = process.platform === 'win32' ? 'C:/dsh/data/demo' : '/dsh/data/demo'
const vars = { pluginRoot: ROOT, dataDir: DATA }

function component(overrides: Partial<McpComponent>): McpComponent {
  return { id: 'test:mcp:demo', kind: 'mcp', name: 'demo', ...overrides } as McpComponent
}

describe('expandVariables', () => {
  it('expands Claude plugin variables, environment variables and defaults', () => {
    const env = { HOME_DIR: '/home/a', EMPTY: '' }
    expect(expandVariables('${CLAUDE_PLUGIN_ROOT}/bin', vars, env)).toBe(`${ROOT}/bin`)
    expect(expandVariables('${CLAUDE_PLUGIN_DATA}/db', vars, env)).toBe(`${DATA}/db`)
    expect(expandVariables('${PLUGIN_ROOT}', vars, env)).toBe(ROOT)
    expect(expandVariables('${HOME_DIR}/x', vars, env)).toBe('/home/a/x')
    expect(expandVariables('${MISSING:-fallback}', vars, env)).toBe('fallback')
    expect(expandVariables('${EMPTY:-used}', vars, env)).toBe('used')
    expect(expandVariables('${MISSING}', vars, env)).toBe('')
  })
})

describe('server names', () => {
  it('names Claude plugin servers as Claude Code does', () => {
    expect(foreignServerName({ source: 'claude-code', name: 'context7' }, 'context7')).toBe('plugin_context7_context7')
    expect(foreignServerName({ source: 'codex', name: 'archcore' }, 'archcore')).toBe('archcore')
  })

  it('keeps short names and hashes long ones within 32 characters', () => {
    expect(mcpServerName('plugin_context7_context7')).toBe('plugin_context7_context7')
    const long = mcpServerName('plugin_a-very-long-plugin-name_and-a-long-server')
    expect(long.length).toBeLessThanOrEqual(32)
    expect(mcpServerName('plugin_a-very-long-plugin-name_and-a-long-server')).toBe(long)
  })

  it('never puts "__" in a name, so mcp__<server>__<tool> names one server', () => {
    for (const name of ['app__reports', 'a b__c', `${'x'.repeat(22)}__${'y'.repeat(20)}`, '-__-', '__']) {
      const server = mcpServerName(name)
      expect(server).toMatch(/^[A-Za-z0-9_-]{1,32}$/u)
      expect(server).not.toContain('__')
      expect(server).not.toMatch(/^_|_$/u)
    }
    expect(mcpServerName('app__reports')).not.toBe(mcpServerName('app_reports'))
  })
})

describe('mcpClientConfig', () => {
  it('translates a stdio server and expands plugin variables', () => {
    const config = mcpClientConfig(component({
      transport: 'stdio',
      command: './bin/server.js',
      args: ['--root', '${CLAUDE_PLUGIN_ROOT}/data'],
      env: { TOKEN: '${CLAUDE_PLUGIN_DATA}/token' },
      cwd: '${PLUGIN_ROOT}/work',
    }), 'plugin_demo_demo', vars)
    expect(config).toMatchObject({ serverName: 'plugin_demo_demo', transport: 'stdio', failOnStartupError: true })
    expect(config['command']).toBe(join(ROOT, 'bin/server.js'))
    expect(config['args']).toEqual(['--root', `${ROOT}/data`])
    expect(config['env']).toMatchObject({ TOKEN: `${DATA}/token`, CLAUDE_PLUGIN_ROOT: ROOT })
    // The working directory is a resolved path, in this platform's spelling.
    expect(config['cwd']).toBe(join(ROOT, 'work'))
  })

  it('translates a streamable HTTP server', () => {
    const config = mcpClientConfig(component({
      transport: 'streamable-http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer ${CLAUDE_PLUGIN_DATA}' },
    }), 'demo', vars)
    expect(config).toMatchObject({ transport: 'streamable-http', url: 'https://example.com/mcp' })
    expect(config['headers']).toEqual({ Authorization: `Bearer ${DATA}` })
  })

  it('refuses SSE and unknown transports', () => {
    expect(() => mcpClientConfig(component({ transport: 'sse', url: 'https://example.com' }), 'demo', vars)).toThrow(UnsupportedMcpTransportError)
    expect(() => mcpClientConfig(component({ transport: 'unknown' }), 'demo', vars)).toThrow(UnsupportedMcpTransportError)
  })
})

const temporary: string[] = []
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

function authStore(open: (url: string) => Promise<void> = async () => {}): McpAuthStore {
  const root = mkdtempSync(join(tmpdir(), 'harness-forge-auth-'))
  temporary.push(root)
  return new McpAuthStore(root, open)
}

const stdioHost: RemoteMcpHost = { auth: new McpAuthStore(tmpdir()), onState: () => {} }

describe('mountMcp', () => {
  it('waits for the official client instance to become ready', async () => {
    let mountedConfig: unknown
    const ctx = {
      get: () => undefined,
      plugin(_module: unknown, config: unknown) {
        mountedConfig = config
        return Object.assign(Promise.resolve(), { dispose: async () => {} })
      },
    }
    const mount = await mountMcp(ctx as unknown as Context, component({ transport: 'stdio', command: 'node', args: ['server.js'] }), 'demo', vars, stdioHost)
    expect(mountedConfig).toMatchObject({ serverName: 'demo', transport: 'stdio' })
    expect(mount.serverName).toBe('demo')
  })

  it('fails the mount with the server error when it cannot start', async () => {
    let disposed = false
    const ctx = {
      get: () => undefined,
      plugin() {
        const failure = Promise.reject(new Error('outer', { cause: new Error('Connection closed') }))
        failure.catch(() => {})
        return Object.assign(failure, { dispose: async () => { disposed = true } })
      },
    }
    await expect(mountMcp(ctx as unknown as Context, component({ transport: 'stdio', command: 'node' }), 'demo', vars, stdioHost)).rejects.toThrow(/Connection closed/u)
    expect(disposed).toBe(true)
  })

  it('hands a stdio server to the capability catalog when it is composed, and keeps remote and session servers direct', async () => {
    const added: Array<Record<string, unknown>> = []
    let removed = 0
    const catalog = { async addMcpServer(server: Record<string, unknown>) { added.push(server); return async () => { removed++ } } }
    const ctx = {
      get: (name: string) => name === 'capabilityCatalogServers' ? catalog : undefined,
      plugin(_module: unknown, config: unknown) {
        return Object.assign(Promise.resolve(config), { dispose: async () => {} })
      },
    }
    const mount = await mountMcp(ctx as unknown as Context, component({ transport: 'stdio', command: 'node', args: ['server.js'], env: { TOKEN: '${HOME_TOKEN:-none}' } }), 'plugin_demo_db', { ...vars, env: { SETTING: 'on' } }, stdioHost)
    expect(mount).toMatchObject({ serverName: 'plugin_demo_db', catalog: true })
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ name: 'plugin_demo_db', enabled: true, transport: 'stdio', args: ['server.js'], env: { SETTING: 'on', TOKEN: 'none', CLAUDE_PLUGIN_ROOT: vars.pluginRoot } })
    expect(String(added[0]?.['command'])).toMatch(/node(\.exe)?$/iu)
    await mount.dispose()
    expect(removed).toBe(1)
    // A session-scoped mount stays out of the process-wide catalog.
    const direct = await mountMcp(ctx as unknown as Context, component({ transport: 'stdio', command: 'node' }), 'demo', vars, stdioHost, { catalog: false })
    expect(direct.catalog).toBeUndefined()
    expect(added).toHaveLength(1)
  })

  it('names the missing program of a stdio server', async () => {
    const ctx = { get: () => undefined, plugin: () => { throw new Error('must not spawn') } }
    await expect(mountMcp(ctx as unknown as Context, component({ transport: 'stdio', command: 'archcore-not-installed', args: ['mcp'] }), 'demo', vars, stdioHost))
      .rejects.toThrow(/needs the program "archcore-not-installed", which is not installed/u)
  })

  it('signs in to an OAuth-protected remote server, then reconnects with the stored token', async () => {
    const remote = await startOAuthMcpServer()
    const definitions: Array<{ name: string; execute(args: unknown, execution: unknown): Promise<unknown> }> = []
    const ctx = {
      get: () => undefined,
      inject(_deps: string[], callback: (child: unknown) => void) {
        callback({ tools: { register(definition: (typeof definitions)[number]) { definitions.push(definition); return () => {} } } })
        return { async dispose() {} }
      },
    }
    // The "browser" follows the authorization redirect back to the loopback listener.
    const auth = authStore(async (url) => { await fetch(url) })
    const states: string[] = []
    const host: RemoteMcpHost = { auth, onState: (_server, state) => { states.push(state.kind) } }
    try {
      const mount = await mountMcp(ctx as unknown as Context, component({ transport: 'streamable-http', url: remote.url }), 'demo', vars, host)
      expect(mount.remote?.current.kind).toBe('sign-in-required')
      expect(definitions).toHaveLength(0)

      const signedIn = await mount.remote!.signIn()
      expect(signedIn).toEqual({ kind: 'connected', tools: ['mcp__demo__echo'] })
      const result = await definitions[0]!.execute({ text: 'OAUTH-OK' }, { signal: new AbortController().signal }) as { content: Array<{ text: string }> }
      expect(result.content[0]?.text).toBe('OAUTH-OK')
      await mount.dispose()

      const again = await mountMcp(ctx as unknown as Context, component({ transport: 'streamable-http', url: remote.url }), 'demo', vars, host)
      expect(again.remote?.current.kind).toBe('connected')
      expect(states).toEqual(['sign-in-required', 'connected', 'connected'])
      await again.dispose()
    } finally {
      auth.close()
      await remote.close()
    }
  }, 30_000)

  it('fails a remote mount with the network error', async () => {
    const ctx = { get: () => undefined, inject(_deps: string[], callback: (child: unknown) => void) { callback({ tools: { register: () => () => {} } }); return { async dispose() {} } } }
    const auth = authStore()
    try {
      await expect(mountMcp(ctx as unknown as Context, component({ transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp' }), 'demo', vars, { auth, onState: () => {} }))
        .rejects.toThrow(/failed to connect/u)
    } finally {
      auth.close()
    }
  })
})
