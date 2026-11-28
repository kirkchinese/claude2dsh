import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assess, codexMcpComponents, planPlugin, scanPlugin, type McpComponent } from '../src/index.js'

const temporary: string[] = []
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function pluginRoot(manifestDir: string, servers: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-forge-codex-mcp-'))
  temporary.push(root)
  mkdirSync(join(root, manifestDir), { recursive: true })
  writeFileSync(join(root, manifestDir, 'plugin.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }))
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: servers }))
  return root
}

function servers(root: string, source: 'codex' | 'claude-code'): Map<string, McpComponent> {
  const { plugin } = scanPlugin(root, { source })
  return new Map(plugin.components.filter((component): component is McpComponent => component.kind === 'mcp').map(component => [component.name, component]))
}

/** The openai-bundled code-review and openai-developers servers, as shipped. */
const CODEX_SERVERS = {
  'code-review': {
    command: '/bin/sh',
    enabled: false,
    args: ['-c', 'exec "$CODEX_MCP_NODE_PATH" ./server.mjs "$@"', '--'],
    cwd: '.',
    env_vars: ['PATH', 'CODEX_HOME', 'CODEX_MCP_NODE_PATH'],
    tool_timeout_sec: 120,
  },
  'api-credit-promo': {
    type: 'http',
    url: 'https://chatgpt.com/backend-api/product-account-links/mcp',
    auth: 'chatgpt',
    enabled_tools: ['preview_api_credit_promo'],
  },
  notion: { type: 'http', url: 'https://mcp.notion.com/mcp' },
  'codex-app': {
    command: './launch',
    args: ['./server.mjs'],
    env_vars: ['HOME', { name: 'TOKEN', source: 'local' }],
    enabled_tools: ['create_thread', 'automation_update'],
    disabled_tools: ['automation_update'],
    default_tools_approval_mode: 'approve',
    tools: { create_thread: { approval_mode: 'prompt' }, automation_update: { approval_mode: 'prompt', output_token_limit: 100 } },
    startup_timeout_sec: 10,
    tool_timeout_sec: 3600,
    omit_tools_from: ['code_mode'],
  },
}

describe('Codex MCP server fields', () => {
  it('reads a Codex plugin\'s servers as Codex does', () => {
    const byName = servers(pluginRoot('.codex-plugin', CODEX_SERVERS), 'codex')
    expect(byName.get('code-review')).toMatchObject({
      transport: 'stdio',
      cwd: '.',
      env: { PATH: '${PATH}', CODEX_HOME: '${CODEX_HOME}', CODEX_MCP_NODE_PATH: '${CODEX_MCP_NODE_PATH}' },
      toolTimeoutMs: 120_000,
      notStarted: { reason: 'disabled', code: 'disabled-in-plugin', detail: 'disabled in the plugin' },
    })
    expect(byName.get('api-credit-promo')).toMatchObject({
      transport: 'streamable-http',
      enabledTools: ['preview_api_credit_promo'],
      notStarted: { reason: 'unsupported', code: 'needs-chatgpt-sign-in', detail: 'needs ChatGPT sign-in, which DSH cannot provide' },
    })
    expect(byName.get('notion')).toMatchObject({ transport: 'streamable-http', url: 'https://mcp.notion.com/mcp' })
    expect(byName.get('notion')?.notStarted).toBeUndefined()
    expect(byName.get('codex-app')).toMatchObject({
      env: { HOME: '${HOME}', TOKEN: '${TOKEN}' },
      enabledTools: ['create_thread', 'automation_update'],
      disabledTools: ['automation_update'],
      toolApproval: { askByDefault: false, tools: { create_thread: true, automation_update: true } },
      startupTimeoutMs: 10_000,
      toolTimeoutMs: 3_600_000,
    })
  })

  it('translates config.toml servers with the same function', () => {
    const [user] = codexMcpComponents('codex:user', { 'code-review': CODEX_SERVERS['code-review'] })
    const plugin = servers(pluginRoot('.codex-plugin', CODEX_SERVERS), 'codex').get('code-review')
    const { id: _a, path: _b, description: _c, notStarted: userOff, ...userRest } = user!
    const { id: _d, path: _e, description: _f, notStarted: pluginOff, ...pluginRest } = plugin!
    expect(userRest).toEqual(pluginRest)
    expect(userOff).toEqual({ reason: 'disabled', code: 'disabled-in-config', detail: 'disabled in config.toml' })
    expect(pluginOff?.reason).toBe('disabled')
  })

  it('leaves out a server marked enabled: false in any plugin', () => {
    const byName = servers(pluginRoot('.claude-plugin', { off: { command: 'x', enabled: false }, on: { command: 'y' } }), 'claude-code')
    expect(byName.get('off')?.notStarted).toEqual({ reason: 'disabled', code: 'disabled-in-plugin', detail: 'disabled in the plugin' })
    expect(byName.get('on')?.notStarted).toBeUndefined()
  })

  it('reports a ChatGPT-authenticated server as a gap, a disabled one as nothing the plugin needs', () => {
    const { plugin } = scanPlugin(pluginRoot('.codex-plugin', { promo: CODEX_SERVERS['api-credit-promo'], off: CODEX_SERVERS['code-review'] }), { source: 'codex' })
    const compat = assess(plugin)
    const promo = plugin.components.find(component => component.name === 'promo')!
    expect(compat.gaps).toContainEqual(expect.objectContaining({ componentId: promo.id, kind: 'external-requirement', summary: expect.stringContaining('needs ChatGPT sign-in') }))
    expect(compat.gaps.filter(gap => gap.componentId.endsWith(':off'))).toEqual([])
    expect(planPlugin(plugin).actions.find(action => action.componentId === promo.id)?.description).toContain('needs ChatGPT sign-in')
  })
})
