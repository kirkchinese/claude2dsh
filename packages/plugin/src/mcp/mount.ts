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
import { shortHash } from '@kirkchinese/harness-forge-core'
import type { McpAuthStore } from './auth.js'
import { RemoteMcp, type RemoteMcpState } from './remote.js'
import { composedCatalog, mountInCatalog } from './catalog.js'

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
  const candidates = /[\\/]/u.test(program)
    ? [isAbsolute(program) ? program : resolve(cwd, program)]
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

/** How long a server may take to connect and list its tools. */
const READY_TIMEOUT_MS = 120_000

/** Variables a plugin's MCP configuration may reference. */
export interface McpVariables {
  readonly pluginRoot: string
  readonly dataDir: string
  /** The `env` of imported harness settings: servers inherit it, `${VAR}` reads it. */
  readonly env?: Readonly<Record<string, string>>
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
 * `.mcp.json`. Unknown variables without a default expand to empty text.
 */
export function expandVariables(value: string, vars: McpVariables, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/gu, (_match, name: string, fallback: string | undefined) => {
    if (name === 'CLAUDE_PLUGIN_ROOT' || name === 'PLUGIN_ROOT') return vars.pluginRoot
    if (name === 'CLAUDE_PLUGIN_DATA' || name === 'PLUGIN_DATA') return vars.dataDir
    const resolved = vars.env?.[name] ?? env[name]
    return resolved !== undefined && resolved.length > 0 ? resolved : fallback ?? ''
  })
}

/** Build the official mcp-client config for one component. */
export function mcpClientConfig(component: McpComponent, serverName: string, vars: McpVariables): Record<string, unknown> {
  const expand = (value: string): string => expandVariables(value, vars)
  const expandRecord = (record: Readonly<Record<string, string>> | undefined): Record<string, string> =>
    Object.fromEntries(Object.entries(record ?? {}).map(([key, value]) => [key, expand(value)]))
  if (component.transport === 'stdio') {
    if (component.command === undefined) throw new Error(`MCP server "${component.name}" has no command`)
    const command = resolveCommand(expand(component.command), vars.pluginRoot)
    return {
      serverName,
      transport: 'stdio',
      command,
      args: (component.args ?? []).map(expand),
      env: {
        ...vars.env,
        ...expandRecord(component.env),
        CLAUDE_PLUGIN_ROOT: vars.pluginRoot,
        CLAUDE_PLUGIN_DATA: vars.dataDir,
        PLUGIN_ROOT: vars.pluginRoot,
        PLUGIN_DATA: vars.dataDir,
      },
      cwd: component.cwd === undefined ? vars.pluginRoot : resolvePath(expand(component.cwd), vars.pluginRoot),
      failOnStartupError: true,
      toolCallTimeoutMs: 600_000,
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
      toolCallTimeoutMs: 600_000,
    }
  }
  throw new UnsupportedMcpTransportError(component.transport)
}

/** What a remote mount needs beyond the component. */
export interface RemoteMcpHost {
  readonly auth: McpAuthStore
  onState(server: RemoteMcp, state: RemoteMcpState): void
}

/**
 * Mount one MCP server and wait until it is connected and its tools are
 * registered, so the first model request already sees them. A stdio server
 * whose program is missing, or a server that cannot connect, fails the mount
 * with that reason. A remote server that requires sign-in stays mounted in
 * that state.
 */
export async function mountMcp(ctx: Context, component: McpComponent, serverName: string, vars: McpVariables, remoteHost: RemoteMcpHost, options: { readonly catalog?: boolean } = {}): Promise<McpMount> {
  // With the capability catalog composed, a stdio server is listed in its
  // compact index and started on demand instead of putting every tool schema
  // in every request. Remote servers keep the direct path, which adds OAuth.
  const catalog = options.catalog === false ? undefined : composedCatalog(ctx)
  if (catalog !== undefined && component.transport === 'stdio') {
    const config = mcpClientConfig(component, serverName, vars)
    const program = String(config['command'])
    const resolved = findProgram(program, String(config['cwd']))
    if (resolved === undefined) {
      throw new Error(`MCP server "${component.name}" needs the program "${program}", which is not installed or not on PATH`)
    }
    return { serverName, catalog: true, dispose: await mountInCatalog(ctx, catalog, component, serverName, config, program, resolved, READY_TIMEOUT_MS) }
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
    await withTimeout(fiber as unknown as Promise<unknown>, `MCP server "${component.name}" did not become ready within ${READY_TIMEOUT_MS / 1000}s`)
  } catch (error: unknown) {
    await fiber.dispose()
    throw new Error(`MCP server "${component.name}" failed to start: ${rootCause(error)}`)
  }
  return { serverName, dispose: async () => { await fiber.dispose() } }
}

/** A DSH-safe server name (`[A-Za-z0-9_-]{1,32}`), stable for the same input. */
export function mcpServerName(name: string): string {
  const base = name.replace(/[^A-Za-z0-9_-]+/gu, '_').replace(/^_+|_+$/gu, '')
  if (base.length > 0 && base.length <= 32) return base
  if (base.length > 32) return `${base.slice(0, 23).replace(/[_-]+$/u, '')}_${shortHash(base, 8)}`
  return `mcp_${shortHash(name, 8)}`
}

/** The per-plugin data directory under a profile-local root. */
export function pluginDataDir(dataRoot: string, pluginId: string): string {
  return join(dataRoot, pluginId.replace(/[^A-Za-z0-9._-]+/gu, '-'))
}

function resolveCommand(command: string, root: string): string {
  if (command.startsWith('./') || command.startsWith('.\\')) return resolve(root, command)
  return command
}

function resolvePath(path: string, root: string): string {
  return isAbsolute(path) ? path : resolve(root, path)
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

function withTimeout(promise: Promise<unknown>, message: string): Promise<unknown> {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), READY_TIMEOUT_MS)
      timer.unref?.()
    }),
  ])
}
