/**
 * One Codex MCP server entry, as Codex reads it, translated once for both
 * places Codex declares servers: `config.toml` `[mcp_servers.<name>]` and a
 * plugin's `.mcp.json` / `mcp.json` / manifest `mcpServers`.
 *
 * Fields follow the Codex MCP reference
 * (https://developers.openai.com/codex/mcp, "Configure with config.toml";
 * https://github.com/openai/codex/blob/main/docs/config.md points there).
 * Variables Codex passes through are referenced as `${NAME}`, expanded when
 * the server starts.
 *
 * Read but not used: `omit_tools_from` (which of Codex's own tool surfaces,
 * such as code mode or deferred tools, leave the server's tools out; DSH has
 * neither surface) and `tools.<tool>.output_token_limit` (a Codex truncation
 * budget; DSH bounds tool output itself).
 * @module @kirkchinese/harness-forge-core
 */
import { isPlainObject } from '../../paths.js'
import type { McpComponent, McpNotStartedCode } from '../../types.js'

/** Where the server is declared, for its component identity and description. */
export interface CodexMcpBase {
  readonly id: string
  readonly name: string
  /** The name the configuration declares (see `McpComponent.declaredName`). */
  readonly declaredName?: string
  readonly path?: string
  /** What the default description says the server is, e.g. `user-scope` or `plugin`. */
  readonly scope: string
  /** What `enabled = false` is reported as. */
  readonly disabledCode: Extract<McpNotStartedCode, 'disabled-in-plugin' | 'disabled-in-config'>
}

/** Codex approval modes that ask before a call: `prompt`, and `writes`, which asks for tools not marked read-only. Read-only hints are only known once the server lists its tools, so `writes` asks for every tool. */
const ASKING_APPROVAL_MODES = new Set(['prompt', 'writes'])

/** Codex's `auth` value that signs in with the user's ChatGPT session. */
const CHATGPT_AUTH = 'chatgpt'

/** The English wording of each reason a server is not started, for logs, plans and agents; screens word the code themselves. */
const NOT_STARTED_DETAIL: Readonly<Record<McpNotStartedCode, string>> = {
  'disabled-in-plugin': 'disabled in the plugin',
  'disabled-in-config': 'disabled in config.toml',
  'needs-chatgpt-sign-in': 'needs ChatGPT sign-in, which DSH cannot provide',
}

/** A server that is not started, with the reason `code` says in English. */
export function notStartedBy(code: McpNotStartedCode): NonNullable<McpComponent['notStarted']> {
  return { reason: code === 'needs-chatgpt-sign-in' ? 'unsupported' : 'disabled', code, detail: NOT_STARTED_DETAIL[code] }
}

/** Milliseconds in one of Codex's `*_sec` values. */
const MS_PER_SECOND = 1000

/** Translate one Codex server entry. */
export function codexMcpServer(raw: Record<string, unknown>, base: CodexMcpBase): McpComponent {
  const command = typeof raw['command'] === 'string' ? raw['command'] : undefined
  const url = typeof raw['url'] === 'string' ? raw['url'] : undefined
  const args = strings(raw['args'])
  // `env_vars` entries are names, or `{ name, source }`; DSH runs servers locally, so every source reads the local environment.
  const passed = Array.isArray(raw['env_vars'])
    ? raw['env_vars'].map(item => typeof item === 'string' ? item : isPlainObject(item) && typeof item['name'] === 'string' ? item['name'] : undefined)
      .filter((item): item is string => item !== undefined)
    : []
  const env = { ...Object.fromEntries(passed.map(variable => [variable, `\${${variable}}`])), ...stringRecord(raw['env']) }
  const headers = {
    ...stringRecord(raw['http_headers']),
    ...Object.fromEntries(Object.entries(stringRecord(raw['env_http_headers'])).map(([header, variable]) => [header, `\${${variable}}`])),
    ...(typeof raw['bearer_token_env_var'] === 'string' ? { Authorization: `Bearer \${${raw['bearer_token_env_var']}}` } : {}),
  }
  const transport = codexTransport(raw['type'], command, url)
  const enabledTools = Array.isArray(raw['enabled_tools']) ? strings(raw['enabled_tools']) : undefined
  const disabledTools = strings(raw['disabled_tools'])
  const approval = toolApproval(raw)
  const startupTimeoutMs = seconds(raw['startup_timeout_sec'])
  const toolTimeoutMs = seconds(raw['tool_timeout_sec'])
  const notStarted = raw['enabled'] === false
    ? notStartedBy(base.disabledCode)
    : raw['auth'] === CHATGPT_AUTH ? notStartedBy('needs-chatgpt-sign-in') : undefined
  return {
    id: base.id,
    kind: 'mcp',
    name: base.name,
    ...(base.declaredName !== undefined ? { declaredName: base.declaredName } : {}),
    ...(base.path !== undefined ? { path: base.path } : {}),
    description: typeof raw['description'] === 'string' ? raw['description'] : `${base.scope} ${transport} MCP server`,
    transport,
    ...(command !== undefined ? { command } : {}),
    ...(args.length > 0 ? { args } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(typeof raw['cwd'] === 'string' ? { cwd: raw['cwd'] } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(enabledTools !== undefined ? { enabledTools } : {}),
    ...(disabledTools.length > 0 ? { disabledTools } : {}),
    ...(approval !== undefined ? { toolApproval: approval } : {}),
    ...(startupTimeoutMs !== undefined ? { startupTimeoutMs } : {}),
    ...(toolTimeoutMs !== undefined ? { toolTimeoutMs } : {}),
    ...(notStarted !== undefined ? { notStarted } : {}),
  }
}

/** Codex's `type`: `http` and `streamable_http` are Streamable HTTP; without one, `command` is stdio and `url` Streamable HTTP. */
function codexTransport(type: unknown, command: string | undefined, url: string | undefined): McpComponent['transport'] {
  if (type === 'stdio') return 'stdio'
  if (type === 'http' || type === 'streamable-http' || type === 'streamable_http' || type === 'streamableHttp') return 'streamable-http'
  if (type === 'sse') return 'sse'
  return command !== undefined ? 'stdio' : url !== undefined ? 'streamable-http' : 'unknown'
}

/** The tools that ask first; undefined when none does. */
function toolApproval(raw: Record<string, unknown>): McpComponent['toolApproval'] {
  const asks = (mode: unknown): boolean | undefined => typeof mode === 'string' ? ASKING_APPROVAL_MODES.has(mode) : undefined
  const askByDefault = asks(raw['default_tools_approval_mode']) ?? false
  const tools: Record<string, boolean> = {}
  if (isPlainObject(raw['tools'])) {
    for (const [tool, settings] of Object.entries(raw['tools'])) {
      const ask = isPlainObject(settings) ? asks(settings['approval_mode']) : undefined
      if (ask !== undefined && ask !== askByDefault) tools[tool] = ask
    }
  }
  return askByDefault || Object.values(tools).some(Boolean) ? { askByDefault, tools } : undefined
}

function seconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value * MS_PER_SECOND) : undefined
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function stringRecord(value: unknown): Record<string, string> {
  return isPlainObject(value)
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : {}
}
