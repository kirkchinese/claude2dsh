/**
 * The capability catalog (`@kirkchinese/dsh-capability-catalog`, an optional
 * plugin of its own), in one place. When a profile composes it, stdio MCP
 * servers are listed in its compact index and started on demand instead of
 * putting every tool schema in every request; the model calls such a tool as
 * `capability_call` with the entry id `mcp:<server>/<tool>`. Nothing here
 * waits for the catalog: the MCP row mounts directly while it is absent and
 * moves its servers into it when it appears.
 * @module @kirkchinese/harness-forge
 */
import type { McpComponent } from '@kirkchinese/harness-forge-core'
import { dshService } from '../dsh/host.js'

/** The catalog meta-tool that runs a catalog entry. */
export const CATALOG_CALL_TOOL = 'capability_call'
/** Every catalog meta-tool; an agent that may use an MCP tool may use these. */
export const CATALOG_TOOLS = ['capability_search', 'capability_describe', CATALOG_CALL_TOOL] as const
/** The services the catalog provides. */
export const CATALOG_SERVICES = ['capabilityCatalogServers', 'capabilityCatalog'] as const

/** The `mcp__<server>__<tool>` name of a catalog entry id `mcp:<server>/<tool>`. */
export function catalogToolName(id: unknown): string | undefined {
  if (typeof id !== 'string') return undefined
  const match = /^mcp:([^/]+)\/(.+)$/u.exec(id)
  return match === null ? undefined : `mcp__${match[1] ?? ''}__${match[2] ?? ''}`
}

/** The tool a call runs: a catalog call runs the MCP tool its id names. */
export function calledTool(name: string, args: unknown): string {
  return name === CATALOG_CALL_TOOL ? catalogToolName((args as { id?: unknown } | undefined)?.id) ?? name : name
}

/** The capability catalog's server registry. */
export interface CatalogServers {
  addMcpServer(server: Record<string, unknown>): Promise<() => Promise<void>>
}

/** The catalog's overview endpoint: each server's tool count and discovery problem. */
interface CatalogRemote {
  request(request: { action: 'overview' }, signal: AbortSignal): Promise<{ servers?: ReadonlyArray<{ name: string; tools: number; problem: string | null }> }>
}

/** The catalog's server registry when the profile composes the catalog and it runs. */
export function composedCatalog(ctx: object): CatalogServers | undefined {
  return dshService(ctx, 'capabilityCatalogServers') as CatalogServers | undefined
}

/**
 * Hand one stdio server to the capability catalog. The catalog records a
 * failed discovery instead of throwing; its overview tells, so a server that
 * never started fails the mount with the catalog's reason.
 * @param config - the server's `mcp-client` configuration.
 * @param program - the program as the configuration names it; `resolved`, where it was found.
 * @returns the removal.
 */
export async function mountInCatalog(ctx: object, catalog: CatalogServers, component: McpComponent, serverName: string, config: Record<string, unknown>, program: string, resolved: string, discoveryTimeoutMs: number): Promise<() => Promise<void>> {
  const dispose = await catalog.addMcpServer({
    name: serverName,
    enabled: true,
    ...(component.description !== undefined && !/^\w+ MCP server$|^[\w-]+ \w+ MCP server$/u.test(component.description) ? { description: component.description } : {}),
    transport: 'stdio',
    // The catalog spawns without a shell; a Windows `.cmd` shim runs through cmd.exe,
    // named as the config names it so a path with spaces never reaches cmd's parser.
    ...(/\.(cmd|bat)$/iu.test(resolved)
      ? { command: process.env['ComSpec'] ?? 'cmd.exe', args: ['/d', '/s', '/c', /[\\/]/u.test(program) ? resolved : program, ...(config['args'] as string[])] }
      : { command: resolved, args: config['args'] }),
    env: config['env'],
    cwd: config['cwd'],
    headers: {},
    allowTools: [],
    denyTools: [],
    families: [],
    idleDisconnectMs: 300_000,
    callTimeoutMs: 600_000,
    discoveryTimeoutMs,
    catalogTtlMs: 86_400_000,
  })
  const remote = dshService(ctx, 'capabilityCatalog') as CatalogRemote | undefined
  const overview = await remote?.request({ action: 'overview' }, AbortSignal.timeout(30_000)).catch(() => undefined)
  const problem = overview?.servers?.find(server => server.name === serverName)?.problem
  if (typeof problem === 'string' && problem.length > 0) {
    await dispose()
    throw new Error(`MCP server "${component.name}" failed in the capability catalog: ${problem}`)
  }
  return dispose
}
