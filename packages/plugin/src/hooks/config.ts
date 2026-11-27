/**
 * Parse a foreign hooks configuration (a Claude Code or Codex `hooks.json`, a
 * settings file's `hooks` key, an inline `plugin.json#hooks` object, or a
 * skill's or agent's frontmatter `hooks`) into the broker's handler model,
 * keeping every field the hook reference defines.
 * @module @kirkchinese/harness-forge
 */
import { readFileSync } from 'node:fs'
import type { ForeignPlugin } from '@kirkchinese/harness-forge-core'

/** Fields every handler type accepts. */
interface HandlerCommon {
  /** The `if` permission rule. */
  readonly condition?: string
  readonly timeoutSec?: number
  readonly statusMessage?: string
  /** Only honored for skill-frontmatter hooks. */
  readonly once?: boolean
}

/** A `type: "command"` handler. */
export interface CommandHandler extends HandlerCommon {
  readonly type: 'command'
  readonly command: string
  /** Exec form when present: `command` is spawned directly with these arguments. */
  readonly args?: readonly string[]
  readonly shell?: 'bash' | 'powershell'
  readonly async?: boolean
  readonly asyncRewake?: boolean
  readonly rewakeMessage?: string
  readonly onFailure?: 'continue' | 'block'
  /** Codex: Windows-only command override. */
  readonly commandWindows?: string
  /** Codex: approximate token threshold before additionalContext spills to a file; 0 disables it. */
  readonly additionalContextLimit?: number
}

/** A `type: "http"` handler. */
export interface HttpHandler extends HandlerCommon {
  readonly type: 'http'
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
  readonly allowedEnvVars?: readonly string[]
  readonly onFailure?: 'continue' | 'block'
}

/** A `type: "mcp_tool"` handler. */
export interface McpToolHandler extends HandlerCommon {
  readonly type: 'mcp_tool'
  readonly server: string
  readonly tool: string
  readonly input?: unknown
}

/** A `type: "prompt"` or `type: "agent"` handler. */
export interface ModelHandler extends HandlerCommon {
  readonly type: 'prompt' | 'agent'
  readonly prompt: string
  readonly model?: string
  readonly continueOnBlock?: boolean
}

/** A handler the configuration does not describe validly. */
export interface InvalidHandler extends HandlerCommon {
  readonly type: 'invalid'
  readonly reason: string
}

/** One configured handler. */
export type HookHandler = CommandHandler | HttpHandler | McpToolHandler | ModelHandler | InvalidHandler

/** One matcher group. */
export interface HookGroup {
  readonly matcher?: string
  readonly handlers: readonly HookHandler[]
}

/** Event name → matcher groups, in configuration order. */
export type HookTable = ReadonlyMap<string, readonly HookGroup[]>

/** Read a hooks file or settings file. */
export function readHookTable(path: string): HookTable {
  return parseHookTable(JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, '')) as unknown)
}

/**
 * Parse an already-loaded hooks value: `{ hooks: { Event: [...] } }` or the
 * bare `{ Event: [...] }` table (frontmatter form).
 */
export function parseHookTable(raw: unknown): HookTable {
  const root = record(raw)
  const hooks = record(root?.['hooks']) ?? root ?? {}
  const table = new Map<string, HookGroup[]>()
  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) continue
    const groups: HookGroup[] = []
    for (const entry of value) {
      const group = record(entry)
      if (group === undefined) continue
      const handlers = Array.isArray(group['hooks']) ? group['hooks'].map(parseHandler) : []
      const matcher = typeof group['matcher'] === 'string' ? group['matcher'] : undefined
      groups.push({ ...(matcher !== undefined ? { matcher } : {}), handlers })
    }
    if (groups.length > 0) table.set(event, groups)
  }
  return table
}

/** Every handler type a table uses, for the compatibility report. */
export function handlerTypes(table: HookTable): string[] {
  const types = new Set<string>()
  for (const groups of table.values()) for (const group of groups) for (const handler of group.handlers) types.add(handler.type)
  return [...types]
}

function parseHandler(value: unknown): HookHandler {
  const handler = record(value) ?? {}
  const common = commonFields(handler)
  const type = handler['type']
  switch (type) {
    case 'command': {
      if (typeof handler['command'] !== 'string' || handler['command'].length === 0) return invalid(common, 'command handler has no "command"')
      const args = handler['args']
      const shell = handler['shell']
      const onFailure = handler['onFailure']
      const limit = handler['additionalContextLimit']
      const windows = handler['commandWindows'] ?? handler['command_windows']
      return {
        ...common,
        type,
        command: handler['command'],
        ...(Array.isArray(args) ? { args: args.map(item => String(item)) } : {}),
        ...(shell === 'bash' || shell === 'powershell' ? { shell } : {}),
        ...(handler['async'] === true ? { async: true } : {}),
        ...(handler['asyncRewake'] === true ? { asyncRewake: true } : {}),
        ...(typeof handler['rewakeMessage'] === 'string' ? { rewakeMessage: handler['rewakeMessage'] } : {}),
        ...(onFailure === 'continue' || onFailure === 'block' ? { onFailure } : {}),
        ...(typeof windows === 'string' && windows.length > 0 ? { commandWindows: windows } : {}),
        ...(typeof limit === 'number' && limit >= 0 ? { additionalContextLimit: limit } : {}),
      }
    }
    case 'http': {
      if (typeof handler['url'] !== 'string' || handler['url'].length === 0) return invalid(common, 'http handler has no "url"')
      const headers = record(handler['headers'])
      const allowed = handler['allowedEnvVars']
      const onFailure = handler['onFailure']
      return {
        ...common,
        type,
        url: handler['url'],
        ...(headers !== undefined ? { headers: Object.fromEntries(Object.entries(headers).map(([key, item]) => [key, String(item)])) } : {}),
        ...(Array.isArray(allowed) ? { allowedEnvVars: allowed.map(item => String(item)) } : {}),
        ...(onFailure === 'continue' || onFailure === 'block' ? { onFailure } : {}),
      }
    }
    case 'mcp_tool': {
      if (typeof handler['server'] !== 'string' || typeof handler['tool'] !== 'string') return invalid(common, 'mcp_tool handler needs "server" and "tool"')
      return { ...common, type, server: handler['server'], tool: handler['tool'], ...('input' in handler ? { input: handler['input'] } : {}) }
    }
    case 'prompt':
    case 'agent': {
      if (typeof handler['prompt'] !== 'string' || handler['prompt'].length === 0) return invalid(common, `${type} handler has no "prompt"`)
      return {
        ...common,
        type,
        prompt: handler['prompt'],
        ...(typeof handler['model'] === 'string' ? { model: handler['model'] } : {}),
        ...(handler['continueOnBlock'] === true ? { continueOnBlock: true } : {}),
      }
    }
    default:
      return invalid(common, typeof type === 'string' ? `unknown handler type "${type}"` : 'handler has no "type"')
  }
}

function commonFields(handler: Record<string, unknown>): HandlerCommon {
  const timeout = handler['timeout']
  const condition = handler['if']
  return {
    ...(typeof condition === 'string' && condition.trim().length > 0 ? { condition: condition.trim() } : {}),
    ...(typeof timeout === 'number' && timeout > 0 ? { timeoutSec: timeout } : {}),
    ...(typeof handler['statusMessage'] === 'string' ? { statusMessage: handler['statusMessage'] } : {}),
    ...(handler['once'] === true ? { once: true } : {}),
  }
}

function invalid(common: HandlerCommon, reason: string): InvalidHandler {
  return { ...common, type: 'invalid', reason }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** A hook source for one plugin's hooks file or one skill's, agent's or command's frontmatter. */
export function hookSource(componentId: string, plugin: ForeignPlugin, dataDir: string, table: HookTable, origin: 'plugin' | 'settings' | 'skill' | 'agent'): HookConfigSource {
  return {
    componentId,
    pluginId: plugin.id,
    dialect: plugin.source === 'codex' ? 'codex' : 'claude-code',
    pluginRoot: plugin.root,
    dataDir,
    table,
    origin,
    options: userConfigDefaults(plugin.manifest['userConfig']),
  }
}

/** Plugin `userConfig` option values: the declared defaults. */
function userConfigDefaults(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, option] of Object.entries(value)) {
    const fallback = typeof option === 'object' && option !== null ? (option as { default?: unknown }).default : undefined
    if (fallback !== undefined && fallback !== null) out[key] = typeof fallback === 'string' ? fallback : JSON.stringify(fallback)
  }
  return out
}

/** One hooks configuration with where it comes from: what the hooks row runs. */
export interface HookConfigSource {
  readonly componentId: string
  readonly pluginId: string
  readonly dialect: 'claude-code' | 'codex'
  readonly pluginRoot: string
  readonly dataDir: string
  readonly table: HookTable
  readonly origin?: 'plugin' | 'settings' | 'skill' | 'agent'
  readonly options?: Readonly<Record<string, string>>
}
