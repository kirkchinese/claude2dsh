import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanPlugin } from '../src/manifest.js'
import { AGENT_MCP_SCHEMA, AGENT_PLUGIN_SCHEMA, validateAgentMcp, validateAgentPlugin } from '../src/schema.js'

const temporary: string[] = []
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('canonical Agent Plugins schemas', () => {
  it('accepts a minimal valid plugin manifest', () => {
    expect(validateAgentPlugin({ $schema: AGENT_PLUGIN_SCHEMA, name: 'demo-plugin' })).toEqual([])
  })

  it('reports the canonical name and required-field violations', () => {
    const errors = validateAgentPlugin({ $schema: AGENT_PLUGIN_SCHEMA, name: 'Bad--Name' })
    expect(errors.some(error => error.includes('name'))).toBe(true)
    expect(validateAgentPlugin({ $schema: AGENT_PLUGIN_SCHEMA })).not.toEqual([])
  })

  it('accepts stdio, streamable HTTP and SSE MCP entries', () => {
    expect(validateAgentMcp({
      $schema: AGENT_MCP_SCHEMA,
      mcpServers: {
        local: { type: 'stdio', command: 'node' },
        http: { type: 'streamable-http', url: 'https://example.test/mcp' },
        sse: { type: 'sse', url: 'https://example.test/sse' },
      },
    })).toEqual([])
  })

  it('rejects an MCP entry with both transport shapes', () => {
    expect(validateAgentMcp({
      $schema: AGENT_MCP_SCHEMA,
      mcpServers: { bad: { type: 'stdio', command: 'node', url: 'https://example.test' } },
    })).not.toEqual([])
  })

  it('surfaces canonical schema errors as scan warnings', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-forge-schema-'))
    temporary.push(root)
    writeFileSync(join(root, 'plugin.json'), JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: 'Bad--Name' }))
    expect(scanPlugin(root, { source: 'agent-plugins' }).plugin.warnings.some(warning => warning.code === 'schema-invalid')).toBe(true)
  })
})
