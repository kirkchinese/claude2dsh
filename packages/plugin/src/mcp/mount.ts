/**
 * Dynamic MCP bridge. A stdio server mounts one official `mcp-client`
 * instance; Streamable HTTP and SSE servers connect through `remote.ts`,
 * which adds OAuth sign-in. Server names follow the foreign harness so the model-facing
 * tool names are the ones the plugin's hooks, agents and prompts already use:
 * Claude Code plugin servers are `plugin_<plugin>_<server>`
 * (`mcp__plugin_<plugin>_<server>__<tool>`), Codex and portable servers keep
 * their own name.
 * @module @kirkchinese/harness-forge
 */
import { existsSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ForeignPlugin, McpComponent } from '@kirkchinese/harness-forge-core'
import { codexHome, contentPath, LEADS_TO_SHARE, shortHash, stripAround } from '@kirkchinese/harness-forge-core'
import type { McpAuthStore } from './auth.js'
import { RemoteMcp, type RemoteMcpState } from './remote.js'
import { composedCatalog, mountInCatalog } from './catalog.js'
import { DEFAULT_TOOL_CALL_TIMEOUT_MS } from './policy.js'

/** One mounted MCP server. */
export interface McpMount {
  readonly serverName: string
  /** Present for Streamable HTTP and SSE servers, which may need sign-in. */
  readonly remote?: RemoteMcp
  /** True when the server is served through the capability catalog (`capability_call`, id `mcp:<server>/<tool>`). */
  readonly catalog?: boolean
  readonly dispose: () => Promise<void>
}

/** Resolve a program the way a spawned process would find it. */
export function findProgram(program: string, cwd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const extensions = process.platform === 'win32'
    ? ['', ...(env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(extension => extension.length > 0)]
    : ['']
  // A program path the configuration names is checked against the folder it runs in (see `contentPath`).
  const named = /[\\/]/u.test(program) ? contentPath(program, cwd) : undefined
  if (/[\\/]/u.test(program) && named === undefined) return undefined
  const candidates = named !== undefined
    ? [named]
    : (env['PATH'] ?? env['Path'] ?? '').split(delimiter).filter(entry => entry.length > 0).map(entry => join(entry, program))
  for (const candidate of candidates) {
    for (const extension of extensions) {
      const path = `${candidate}${extension}`
      if (existsSync(path) && statSync(path).isFile()) return path
    }
  }
  return undefined
}

/** Raised when a foreign MCP transport has no implementation. */
export class UnsupportedMcpTransportError extends Error {
  readonly code = 'unsupported-transport'
  constructor(readonly transport: string) {
    super(`MCP transport "${transport}" is not supported`)
    this.name = 'UnsupportedMcpTransportError'
  }
}

/** How long a server may take to connect and list its tools when its configuration does not say. */
const READY_TIMEOUT_MS = 120_000

/** Variables a plugin's MCP configuration may reference. */
export interface McpVariables {
  readonly pluginRoot: string
  readonly dataDir: string
  /** The `env` of imported harness settings: servers inherit it, `${VAR}` reads it. */
  readonly env?: Readonly<Record<string, string>>
  /**
   * Variables the foreign harness itself sets for its servers, read by
   * `${VAR}` when neither the settings nor the environment set them; see
   * {@link harnessVariables}.
   */
  readonly provided?: Readonly<Record<string, string>>
}

/**
 * The variables a harness provides to its plugins' MCP servers. Codex sets
 * `CODEX_HOME` (its configuration directory) and, for plugin servers,
 * `CODEX_MCP_NODE_PATH`, the Node.js it bundles (the openai-bundled plugins
 * start their servers as `exec "$CODEX_MCP_NODE_PATH" ./server.mjs`). DSH
 * provides the Node.js running it instead. They reach a server only through
 * its configuration (`env_vars`, `env`, `${VAR}` in its command or arguments).
 */
export function harnessVariables(plugin: Pick<ForeignPlugin, 'source'>): Readonly<Record<string, string>> {
  return plugin.source === 'codex' ? { CODEX_HOME: codexHome(), CODEX_MCP_NODE_PATH: process.execPath } : {}
}

/**
 * The server name the foreign harness would use, before DSH length limits:
 * Claude Code scopes a plugin's servers as `plugin_<plugin>_<server>` and
 * keeps user, project and local servers under their own names.
 */
export function foreignServerName(plugin: Pick<ForeignPlugin, 'source' | 'name'> & { readonly manifest?: Readonly<Record<string, unknown>> }, server: string): string {
  if (plugin.source !== 'claude-code' || isOwnAssets(plugin)) return server
  return `plugin_${plugin.name}_${server}`
}

/** A user's or project's own assets rather than a plugin. */
export function isOwnAssets(plugin: { readonly manifest?: Readonly<Record<string, unknown>> }): boolean {
  const scope = plugin.manifest?.['scope']
  return scope === 'user' || scope === 'project'
}

/** Whose templates a plugin's commands and skills are: the person's own, a project's, or an installed plugin's. */
export function templateScope(plugin: { readonly manifest?: Readonly<Record<string, unknown>> }): 'user' | 'project' | 'plugin' {
  const scope = plugin.manifest?.['scope']
  return scope === 'user' || scope === 'project' ? scope : 'plugin'
}

/** The project directory of a project's assets, else undefined. */
export function projectRootOf(plugin: { readonly manifest?: Readonly<Record<string, unknown>> }): string | undefined {
  const root = plugin.manifest?.['projectRoot']
  return plugin.manifest?.['scope'] === 'project' && typeof root === 'string' ? root : undefined
}

/**
 * Expand `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${PLUGIN_ROOT}`,
 * `${PLUGIN_DATA}`, `${VAR}` and `${VAR:-default}` the way Claude Code expands
 * `.mcp.json`; then what the harness provides ({@link McpVariables.provided}).
 * Unknown variables without a default expand to empty text; a stdio server
 * whose command or arguments need one does not start (`missingVariables`).
 * The value goes in as plain text, as in Claude Code: expanded into an
 * explicit `sh -c '… ${VAR} …'` argument it becomes part of that script. The
 * values are the plugin author's and the user's own environment, so this
 * keeps the original harness's meaning instead of quoting them.
 */
export function expandVariables(value: string, vars: McpVariables, env: NodeJS.ProcessEnv = process.env): string {
  const expand = (name: string, fallback: string | undefined): string => {
    if (name === 'CLAUDE_PLUGIN_ROOT' || name === 'PLUGIN_ROOT') return vars.pluginRoot
    if (name === 'CLAUDE_PLUGIN_DATA' || name === 'PLUGIN_DATA') return vars.dataDir
    const resolved = [vars.env?.[name], env[name], vars.provided?.[name]].find(value => value !== undefined && value.length > 0)
    return resolved ?? fallback ?? ''
  }
  // A scan: `/\$\{(NAME)(?::-([^}]*))?\}/g` reads to the end from every unclosed `${NAME:-`, quadratic.
  let out = ''
  let index = 0
  let close = -1
  for (;;) {
    const start = value.indexOf('${', index)
    if (close < start + 2) close = value.indexOf('}', start + 2)
    if (start === -1 || close === -1) return out + value.slice(index)
    const match = /^([A-Za-z_][A-Za-z0-9_]*)(?::-(.*))?$/su.exec(value.slice(start + 2, close))
    if (match === null) {
      out += value.slice(index, start + 2)
      index = start + 2
      continue
    }
    out += value.slice(index, start) + expand(match[1] ?? '', match[2])
    index = close + 1
  }
}

/** Build the official mcp-client config for one component. */
export function mcpClientConfig(component: McpComponent, serverName: string, vars: McpVariables): Record<string, unknown> {
  const expand = (value: string): string => expandVariables(value, vars)
  const expandRecord = (record: Readonly<Record<string, string>> | undefined): Record<string, string> =>
    Object.fromEntries(Object.entries(record ?? {}).map(([key, value]) => [key, expand(value)]))
  if (component.transport === 'stdio') {
    if (component.command === undefined) throw new Error(`MCP server "${component.name}" has no command`)
    const env = expandRecord(component.env)
    const missing = missingVariables(component, env, vars)
    if (missing.length > 0) {
      throw new Error(`MCP server "${component.name}" needs ${missing.join(', ')}, which DSH does not provide; set ${missing.length > 1 ? 'them' : 'it'} in the environment DSH starts in`)
    }
    const command = resolveCommand(expand(component.command), vars.pluginRoot)
    return {
      serverName,
      transport: 'stdio',
      command,
      args: (component.args ?? []).map(expand),
      env: {
        ...vars.env,
        ...env,
        CLAUDE_PLUGIN_ROOT: vars.pluginRoot,
        CLAUDE_PLUGIN_DATA: vars.dataDir,
        PLUGIN_ROOT: vars.pluginRoot,
        PLUGIN_DATA: vars.dataDir,
      },
      cwd: component.cwd === undefined ? vars.pluginRoot : workingDirectory(component, expand(component.cwd), vars.pluginRoot),
      failOnStartupError: true,
      toolCallTimeoutMs: component.toolTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS,
      ...(component.startupTimeoutMs !== undefined ? { startupTimeoutMs: component.startupTimeoutMs } : {}),
    }
  }
  if (component.transport === 'streamable-http') {
    if (component.url === undefined) throw new Error(`MCP server "${component.name}" has no url`)
    return {
      serverName,
      transport: 'streamable-http',
      url: expand(component.url),
      headers: expandRecord(component.headers),
      failOnStartupError: true,
      toolCallTimeoutMs: component.toolTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS,
      ...(component.startupTimeoutMs !== undefined ? { startupTimeoutMs: component.startupTimeoutMs } : {}),
    }
  }
  throw new UnsupportedMcpTransportError(component.transport)
}

/**
 * The variables a stdio server's command or arguments reference that would
 * be empty: a `${VAR}` without a default that nothing sets, and a shell
 * `$VAR` the server's `env` passes through (`env_vars`) but nothing sets.
 * Started anyway, such a server runs an empty program
 * (`exec "$CODEX_MCP_NODE_PATH"` fails with `exec: : Permission denied`).
 * A shell variable the server does not declare may be the script's own, so
 * it is left alone.
 */
function missingVariables(component: McpComponent, env: Readonly<Record<string, string>>, vars: McpVariables): string[] {
  const missing = new Set<string>()
  const declared = component.env ?? {}
  for (const text of [component.command ?? '', ...(component.args ?? [])]) {
    for (const match of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu)) {
      const name = match[1] ?? ''
      if (expandVariables(match[0], vars) === '') missing.add(name)
    }
    for (const match of text.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/gu)) {
      const name = match[1] ?? ''
      const passed = declared[name]
      if (passed !== undefined && /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/u.test(passed) && env[name] === '') missing.add(name)
    }
  }
  return [...missing]
}

/** What a remote mount needs beyond the component. */
export interface RemoteMcpHost {
  readonly auth: McpAuthStore
  onState(server: RemoteMcp, state: RemoteMcpState): void
}

/**
 * Whether `mountMcp` serves a server through the capability catalog: with the
 * catalog composed, a stdio server is listed in its compact index and started
 * on demand instead of putting every tool schema in every request. Remote
 * servers keep the direct path, which adds OAuth; `options.catalog: false`
 * (a session's own server) keeps it direct too.
 */
export function servedByCatalog(ctx: object, component: McpComponent, options: { readonly catalog?: boolean } = {}): boolean {
  return options.catalog !== false && component.transport === 'stdio' && composedCatalog(ctx) !== undefined
}

/**
 * Mount one MCP server and wait until it is connected and its tools are
 * registered, so the first model request already sees them. A stdio server
 * whose program is missing, or a server that cannot connect, fails the mount
 * with that reason. A remote server that requires sign-in stays mounted in
 * that state.
 */
export async function mountMcp(ctx: Context, component: McpComponent, serverName: string, vars: McpVariables, remoteHost: RemoteMcpHost, options: { readonly catalog?: boolean } = {}): Promise<McpMount> {
  const catalog = servedByCatalog(ctx, component, options) ? composedCatalog(ctx) : undefined
  if (catalog !== undefined) {
    const config = mcpClientConfig(component, serverName, vars)
    const program = String(config['command'])
    const resolved = findProgram(program, String(config['cwd']))
    if (resolved === undefined) {
      throw new Error(`MCP server "${component.name}" needs the program "${program}", which is not installed or not on PATH`)
    }
    return { serverName, catalog: true, dispose: await mountInCatalog(ctx, catalog, component, serverName, config, program, resolved, component.startupTimeoutMs ?? READY_TIMEOUT_MS) }
  }
  if (component.transport === 'streamable-http' || component.transport === 'sse') {
    if (component.url === undefined) throw new Error(`MCP server "${component.name}" has no url`)
    const expand = (value: string): string => expandVariables(value, vars)
    const server: RemoteMcp = new RemoteMcp(ctx, {
      ...component,
      url: expand(component.url),
      headers: Object.fromEntries(Object.entries(component.headers ?? {}).map(([key, value]) => [key, expand(value)])),
    }, serverName, remoteHost.auth, state => remoteHost.onState(server, state))
    const state = await server.start()
    if (state.kind === 'failed') {
      await server.dispose()
      throw new Error(`MCP server "${component.name}" failed to connect: ${state.error}`)
    }
    return { serverName, remote: server, dispose: () => server.dispose() }
  }
  const config = mcpClientConfig(component, serverName, vars)
  const program = String(config['command'])
  if (findProgram(program, String(config['cwd'])) === undefined) {
    throw new Error(`MCP server "${component.name}" needs the program "${program}", which is not installed or not on PATH`)
  }
  const module = await import('@deepseek-ai/dsh-mcp-client')
  const fiber = ctx.plugin(module as never, config as never)
  try {
    const readyMs = component.startupTimeoutMs ?? READY_TIMEOUT_MS
    await withTimeout(fiber as unknown as Promise<unknown>, readyMs, `MCP server "${component.name}" did not become ready within ${readyMs / 1000}s`)
  } catch (error: unknown) {
    await fiber.dispose()
    throw new Error(`MCP server "${component.name}" failed to start: ${rootCause(error)}`)
  }
  return { serverName, dispose: async () => { await fiber.dispose() } }
}

/** The longest server name DSH's MCP client accepts. */
const MAX_SERVER_NAME_LENGTH = 32
/** Hex characters of the hash that keeps a shortened or collapsed server name apart from the others. */
const SERVER_NAME_HASH_LENGTH = 8
/** Characters kept before that hash: the name, `_` and the hash fit {@link MAX_SERVER_NAME_LENGTH}. */
const SERVER_NAME_KEPT_LENGTH = MAX_SERVER_NAME_LENGTH - SERVER_NAME_HASH_LENGTH - 1

/**
 * A DSH-safe server name (`[A-Za-z0-9_-]{1,32}`), stable for the same input.
 * It never holds `__` nor starts or ends with `_`: a model-facing tool name
 * `mcp__<server>__<tool>` then names one server only (with servers `app` and
 * `app__reports`, `mcp__app__reports__x` would name either). A name that had
 * `__` is collapsed to single `_` and keeps a hash of the original, so it
 * stays apart from a server that was named that way to begin with.
 */
export function mcpServerName(name: string): string {
  const base = stripAround(name.replace(/[^A-Za-z0-9_-]+/gu, '_'), '_')
  const collapsed = base.replace(/_{2,}/gu, '_')
  if (collapsed === base && base.length > 0 && base.length <= MAX_SERVER_NAME_LENGTH) return base
  const kept = collapsed.slice(0, SERVER_NAME_KEPT_LENGTH).replace(/[_-]+$/u, '')
  return `${kept.length > 0 ? kept : 'mcp'}_${shortHash(base.length > 0 ? base : name, SERVER_NAME_HASH_LENGTH)}`
}

/** The per-plugin data directory under a profile-local root. */
export function pluginDataDir(dataRoot: string, pluginId: string): string {
  return join(dataRoot, pluginId.replace(/[^A-Za-z0-9._-]+/gu, '-'))
}

function resolveCommand(command: string, root: string): string {
  if (command.startsWith('./') || command.startsWith('.\\')) return resolve(root, command)
  return command
}

/** A server's configured working directory, resolved against its plugin; one on a network share the plugin is not on is refused. */
function workingDirectory(component: McpComponent, path: string, root: string): string {
  const resolved = contentPath(path, root)
  if (resolved === undefined) throw new Error(`MCP server "${component.name}" would run in ${path}, which ${LEADS_TO_SHARE}; Harness Forge does not start servers there`)
  return resolved
}

function rootCause(error: unknown): string {
  let current: unknown = error
  let message = error instanceof Error ? error.message : String(error)
  while (current instanceof Error && current.cause !== undefined) {
    current = current.cause
    if (current instanceof Error) message = current.message
  }
  return message
}

function withTimeout(promise: Promise<unknown>, ms: number, message: string): Promise<unknown> {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms)
      timer.unref?.()
    }),
  ])
}
