import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentComponent } from '@kirkchinese/harness-forge-core'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { agentPresetId, agentTools, mountAgentPreset } from '../src/agents/presets.js'
import { apply as applyToolFilter, exclusion } from '../src/presets/tool-filter.js'

const STANDARD = [
  '- id: persona',
  '  name: \'@deepseek-ai/dsh-persona\'',
  '  config:',
  '    prefix: You are a coding agent powered by the {{model}} model.',
  '- id: tool-bash',
  '  name: \'@deepseek-ai/dsh-tool-bash\'',
  '  disabled: !!js process.platform === \'win32\'',
  '- id: tool-fs',
  '  name: \'@deepseek-ai/dsh-tool-fs\'',
  '- id: tool-fs-search',
  '  name: \'@deepseek-ai/dsh-tool-fs-search\'',
  '- id: tool-goal',
  '  name: \'@deepseek-ai/dsh-tool-goal\'',
  '- id: delegation',
  '  name: cordis:group',
  '  group: true',
  '  config:',
  '    - id: tool-subagent',
  '      name: \'@deepseek-ai/dsh-tool-subagent\'',
].join('\n')

function agent(overrides: Partial<AgentComponent> = {}): AgentComponent {
  return {
    id: 'test:agent:reviewer',
    kind: 'agent',
    name: 'reviewer',
    bodyPath: '/tmp/reviewer.md',
    body: 'You review code.',
    description: 'Reviews code for bugs',
    frontmatter: { tools: 'Read, Grep, UnknownTool' },
    ...overrides,
  }
}

function registryContext(capture: (definition: PresetDefinition) => void): Context {
  return {
    get(name: string) {
      if (name !== 'agentPresets') return undefined
      return {
        defaultId: 'standard',
        async readDocument() { return { content: STANDARD } },
        async register(definition: PresetDefinition) {
          capture(definition)
          return async () => {}
        },
      }
    },
  } as unknown as Context
}

describe('agent tool filter', () => {
  it('offers the model only the listed tools, whoever registered the rest, and hides global tools that appear later', async () => {
    const listeners = new Map<string, (...args: never[]) => unknown>()
    let schemas = [{ name: 'read' }, { name: 'glob' }]
    const restricted: string[][] = []
    const ctx = {
      effect: (setup: () => unknown) => { setup() },
      on: (name: string, listener: (...args: never[]) => unknown) => { listeners.set(name, listener); return () => {} },
      tools: {
        guard: () => () => {},
        schemas: () => schemas,
        restrict: (filter: { deny: string[] }) => { restricted.push(filter.deny); return () => {} },
      },
    } as unknown as Context
    applyToolFilter(ctx, { allow: ['read', 'grep'] })
    expect(restricted).toEqual([['glob']])
    // A delegation tool registered after the preset started.
    schemas = [...schemas, { name: 'agent' }]
    ;(listeners.get('tools/change') as () => void)()
    expect(restricted).toEqual([['glob'], ['agent']])
  })

  it('judges MCP entries as Claude Code does and a catalog call as the MCP tool it runs', () => {
    const config = { allow: ['read', 'mcp__github', 'capability_search', 'capability_describe', 'capability_call'], deny: ['mcp__github__delete_repo'] }
    expect(exclusion(config, 'read', {})).toBeUndefined()
    expect(exclusion(config, 'write', {})).toMatch(/not available/u)
    expect(exclusion(config, 'mcp__github__get_issue', {})).toBeUndefined()
    expect(exclusion(config, 'mcp__github__delete_repo', {})).toMatch(/not available/u)
    expect(exclusion(config, 'mcp__slack__post', {})).toMatch(/not available/u)
    expect(exclusion(config, 'capability_call', { id: 'mcp:github/get_issue', arguments: {} })).toBeUndefined()
    expect(exclusion(config, 'capability_call', { id: 'mcp:github/delete_repo' })).toBe('mcp__github__delete_repo is not available to this agent')
    expect(exclusion(config, 'capability_call', { id: 'mcp:slack/post' })).toBe('mcp__slack__post is not available to this agent')
    expect(exclusion(config, 'capability_search', {})).toBeUndefined()
    // An agent that lists no MCP tool keeps no catalog tool.
    expect(exclusion({ allow: ['read'] }, 'capability_search', {})).toMatch(/not available/u)
    expect(exclusion({ deny: ['mcp__github__*'] }, 'capability_call', { id: 'mcp:github/x' })).toMatch(/not available/u)
  })
})

describe('agentTools', () => {
  it('maps Claude and Codex tool names to DSH names and reports unknown ones', () => {
    expect(agentTools(agent({ frontmatter: { tools: 'Read, Grep, Bash, UnknownTool, mcp__github__read' } }))).toEqual({
      // An MCP tool is reachable directly or through the capability catalog.
      allow: ['read', 'read_image', 'grep', 'bash', 'pwsh', 'mcp__github__read', 'capability_search', 'capability_describe', 'capability_call'],
      unknown: ['UnknownTool'],
    })
    expect(agentTools(agent({ frontmatter: { disallowedTools: ['Write', 'Edit'] } }))).toEqual({
      deny: ['write', 'edit'],
      unknown: [],
    })
  })
})

describe('mountAgentPreset', () => {
  it('builds on the default preset, replaces the persona and narrows its tool rows', async () => {
    let definition: PresetDefinition | undefined
    const mount = await mountAgentPreset(registryContext((value) => { definition = value }), agent(), 'demo-plugin')
    expect(mount.presetId).toBe(agentPresetId('demo-plugin', 'reviewer'))
    expect(definition?.name).toBe('demo-plugin:reviewer')
    expect(definition?.description).toBe('Reviews code for bugs')
    // Read and Grep: tool-fs keeps read/read_image only, tool-fs-search stays,
    // the shell, host-only and delegation rows go.
    expect(definition?.plugins.map(row => row.id)).toEqual(['persona', 'tool-fs', 'tool-fs-search', 'harness-forge-tool-filter'])
    expect(definition?.plugins[0]).toMatchObject({ config: { prefix: 'You review code.' } })
    expect(definition?.plugins[1]).toMatchObject({ config: { read: true, readImage: true, write: false, edit: false } })
    expect(definition?.plugins[3]).toMatchObject({ config: { allow: ['read', 'read_image', 'grep'] } })
  })

  it('keeps every tool but delegation when the agent lists none, and keeps !!js conditions', async () => {
    let definition: PresetDefinition | undefined
    await mountAgentPreset(registryContext((value) => { definition = value }), agent({ frontmatter: {} }), 'demo')
    expect(definition?.plugins.map(row => row.id)).toEqual(['persona', 'tool-bash', 'tool-fs', 'tool-fs-search', 'tool-goal'])
    expect(typeof definition?.plugins[1]?.disabled).not.toBe('boolean')
  })

  it('keeps delegation for an agent that lists the Agent tool', async () => {
    let definition: PresetDefinition | undefined
    await mountAgentPreset(registryContext((value) => { definition = value }), agent({ frontmatter: { tools: 'Agent, Read' } }), 'demo')
    expect(definition?.plugins.map(row => row.id)).toContain('delegation')
  })

  it('leaves an agent whose every listed tool is unknown without tool rows', async () => {
    let definition: PresetDefinition | undefined
    await mountAgentPreset(registryContext((value) => { definition = value }), agent({ frontmatter: { tools: 'Nope' } }), 'demo')
    expect(definition?.plugins.map(row => row.id)).toEqual(['persona', 'harness-forge-tool-filter'])
    expect(definition?.plugins.at(-1)).toMatchObject({ config: { allow: [] } })
  })

  it('names the profiles that compose presets when the registry is absent', async () => {
    const ctx = { get: () => undefined } as unknown as Context
    await expect(mountAgentPreset(ctx, agent(), 'demo')).rejects.toThrow(/Web and Desktop/u)
  })
})
