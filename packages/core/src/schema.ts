/**
 * Canonical Agent Plugins 1.0.0 schemas. The schemas are vendored from
 * https://agent-plugins.org/schemas/1.0.0/ so validation never performs network
 * I/O while loading a plugin. Validation is advisory: a manifest with a
 * canonical `$schema` gets `schema-invalid` warnings, but an invalid document
 * is still scanned so the workbench can explain every recovered component.
 * @module @kirkchinese/harness-forge-core
 */
import { Ajv2020 } from 'ajv/dist/2020.js'

export const AGENT_PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
export const AGENT_MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'

const pluginSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: AGENT_PLUGIN_SCHEMA,
  type: 'object',
  properties: {
    $schema: { const: AGENT_PLUGIN_SCHEMA },
    name: { type: 'string', minLength: 1, maxLength: 64, pattern: '^(?!.*(?:--|\\.\\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$' },
    version: { type: 'string' },
    description: { type: 'string' },
    author: {
      type: 'object',
      properties: { name: { type: 'string' }, email: { type: 'string' }, url: { type: 'string' } },
      additionalProperties: false,
    },
    homepage: { type: 'string' },
    repository: { type: 'string' },
    license: { type: 'string' },
    keywords: { type: 'array', items: { type: 'string' } },
    extensions: { type: 'object', additionalProperties: { type: 'object' } },
  },
  required: ['$schema', 'name'],
  additionalProperties: false,
} as const

const mcpSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: AGENT_MCP_SCHEMA,
  type: 'object',
  properties: {
    $schema: { const: AGENT_MCP_SCHEMA },
    mcpServers: {
      type: 'object',
      additionalProperties: {
        oneOf: [
          {
            type: 'object',
            properties: {
              type: { const: 'stdio' },
              command: { type: 'string', minLength: 1 },
              args: { type: 'array', items: { type: 'string' } },
              env: { type: 'object', additionalProperties: { type: 'string' } },
              cwd: { type: 'string' },
            },
            required: ['type', 'command'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              type: { const: 'streamable-http' },
              url: { type: 'string', minLength: 1 },
              headers: { type: 'object', additionalProperties: { type: 'string' } },
            },
            required: ['type', 'url'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              type: { const: 'sse' },
              url: { type: 'string', minLength: 1 },
              headers: { type: 'object', additionalProperties: { type: 'string' } },
            },
            required: ['type', 'url'],
            additionalProperties: false,
          },
        ],
      },
    },
  },
  required: ['$schema', 'mcpServers'],
  additionalProperties: false,
} as const

const ajv = new Ajv2020({ allErrors: true, strict: false })
const validatePlugin = ajv.compile(pluginSchema)
const validateMcp = ajv.compile(mcpSchema)

/** Whether a document opted into the canonical Agent Plugins manifest schema. */
export function usesAgentPluginSchema(value: Readonly<Record<string, unknown>>): boolean {
  return value['$schema'] === AGENT_PLUGIN_SCHEMA
}

/** Whether a document opted into the canonical MCP configuration schema. */
export function usesAgentMcpSchema(value: Readonly<Record<string, unknown>>): boolean {
  return value['$schema'] === AGENT_MCP_SCHEMA
}

/** Validate a canonical Agent Plugins manifest; returns empty when valid. */
export function validateAgentPlugin(value: unknown): string[] {
  return validate(validatePlugin, value)
}

/** Validate a canonical Agent Plugins MCP document; returns empty when valid. */
export function validateAgentMcp(value: unknown): string[] {
  return validate(validateMcp, value)
}

function validate(validator: { (value: unknown): boolean; errors?: readonly { instancePath?: string; message?: string }[] | null }, value: unknown): string[] {
  if (validator(value)) return []
  return (validator.errors ?? []).map(error => `${error.instancePath === '' ? '/' : error.instancePath}: ${error.message ?? 'invalid'}`)
}
