/**
 * The MCP row: imported MCP servers, stdio through DSH's own MCP client (or
 * the capability catalog when the profile composes it), Streamable HTTP and
 * SSE with OAuth sign-in. Their tool calls are the components' evidence.
 * @module @kirkchinese/harness-forge/mcp
 */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@kirkchinese/harness-forge-core'
import { onDsh } from '../dsh/host.js'
import type { Disposer, McpApi, McpToolVerdict, Mounter, MountScope } from '../forge/contract.js'
import { FORGE_SERVICE, type HarnessForge } from '../forge/service.js'
import { McpAuthStore } from './auth.js'
import { CATALOG_CALL_TOOL, CATALOG_SERVICES, catalogEntry } from './catalog.js'
import type { RemoteMcp } from './remote.js'
import { foreignServerName, harnessVariables, mcpServerName, mountMcp, servedByCatalog, type RemoteMcpHost } from './mount.js'
import { mcpToolPolicy, type McpToolPolicy } from './policy.js'
import { messageOf } from '../shared/util.js'
import { mounted, Parts, rowEffect } from '../forge/row.js'

export const name = 'harness-forge-mcp'
export const inject = [FORGE_SERVICE]

/** The MCP row. */
export function apply(ctx: Context): void {
  rowEffect(ctx, 'mcp', forge => startMcp(ctx, forge))
}

/** A remote server's sign-in bookkeeping: its component and, for a project server, its session. */
interface RemoteEntry {
  readonly componentId: string
  readonly sessionId?: string
  readonly server: RemoteMcp
}

/** A mounted server's registration, for tool-call evidence and its configuration's tool policy. */
interface ServerEntry {
  /** The exact `serverName` it is registered under. */
  readonly serverName: string
  readonly componentId: string
  readonly sessionId?: string
  readonly policy?: McpToolPolicy
  /** How its tools are called: through the capability catalog (`capability_call`) or directly (`mcp__<server>__<tool>`). */
  readonly route: 'catalog' | 'direct'
  /** The plugin that declares it, and the name it declares it under (`McpComponent.declaredName`). */
  readonly pluginId: string
  readonly pluginName: string
  readonly declaredName: string
  /** Declared in the user's own configuration (config.toml, the user `.mcp.json`), which every plugin's hooks may name. */
  readonly userLevel: boolean
}

/** Claude Code's scoped hook server name `plugin:<plugin>:<server>`. */
const SCOPED_HOOK_SERVER = /^plugin:([^:]+):(.+)$/u

/** The server a tool call goes to and the tool it runs there. */
interface CallTarget {
  readonly server: ServerEntry
  /** The server's own name for the tool, when known: always through the catalog, for a configured tool directly. */
  readonly rawName?: string
  /** The model-facing `mcp__<server>__<tool>` name. */
  readonly toolName: string
}

/** The identity of a tool call as the `tools/pre-execute` and `tools/post-execute` events give it. */
interface ToolCall {
  readonly name: string
  readonly arguments: unknown
  readonly agent?: { readonly session?: { readonly header?: { readonly id?: string } } }
}

/** Start the MCP row on the shared service. Returns its teardown. */
export function startMcp(ctx: Context, forge: HarnessForge): Disposer {
  const auth = new McpAuthStore(join(forge.dataRoot, 'mcp-auth'))
  /**
   * Remote servers that reported a state, by server object: the same name may
   * be mounted process-wide and in several sessions' projects at once, each
   * with its own sign-in state and component.
   */
  const remotes = new Map<RemoteMcp, RemoteEntry>()
  /**
   * Each server's registration, with its component and session: published
   * before its tools are, and kept until their withdrawal succeeds, so its
   * policy covers every moment they can be called.
   */
  const servers = new Set<ServerEntry>()

  const remoteHost = (componentId: string, scope: MountScope = {}): RemoteMcpHost => ({
    auth,
    onState: (server, state) => {
      remotes.set(server, { componentId, server, ...(scope.sessionId !== undefined ? { sessionId: scope.sessionId } : {}) })
      if (state.kind === 'sign-in-required') forge.observe(componentId, 'sign-in', false, `sign-in required: run /harness login ${server.serverName}`)
      else forge.clearObservation(componentId, 'sign-in')
    },
  })

  /** Servers waiting for sign-in that a session sees (its own and process-wide ones); every one without a session. */
  const waiting = (sessionId: string | undefined): RemoteEntry[] => {
    for (const server of [...remotes.keys()]) if (server.disposed) remotes.delete(server)
    return [...remotes.values()].filter(entry => entry.server.current.kind === 'sign-in-required'
      && (sessionId === undefined || entry.sessionId === undefined || entry.sessionId === sessionId))
  }

  const api: McpApi = {
    pendingSignIns: sessionId => [...new Set(waiting(sessionId).map(entry => entry.server.serverName))],
    startSignIn: (serverName, sessionId) => {
      const named = waiting(sessionId).filter(entry => entry.server.serverName === serverName)
      // The session's own server first, then the process-wide one.
      const remote = named.find(entry => sessionId !== undefined && entry.sessionId === sessionId)
        ?? named.find(entry => entry.sessionId === undefined)
        ?? named[0]
      const state = remote?.server.current
      if (remote === undefined || state?.kind !== 'sign-in-required') throw new Error(`MCP server "${serverName}" is not waiting for sign-in`)
      void remote.server.signIn().then((next) => {
        if (next.kind === 'failed') forge.observe(remote.componentId, 'sign-in', false, `sign-in failed: ${next.error}`)
      }, (error: unknown) => {
        forge.observe(remote.componentId, 'sign-in', false, `sign-in failed: ${messageOf(error)}`)
      })
      return state.url
    },
    remoteHost,
    toolPolicy: call => toolPolicy(call as ToolCall),
    hookServer: (pluginId, server, sessionId) => {
      const scoped = SCOPED_HOOK_SERVER.exec(server)
      const declared = scoped?.[2] ?? server
      const named = [...servers].filter(entry => entry.declaredName === declared)
      const pick = (matching: readonly ServerEntry[]): ServerEntry | undefined =>
        matching.find(entry => sessionId !== undefined && entry.sessionId === sessionId) ?? matching.find(entry => entry.sessionId === undefined)
      const own = pick(named.filter(entry => scoped === null ? entry.pluginId === pluginId : entry.pluginName === scoped[1]))
      return (own ?? (scoped === null ? pick(named.filter(entry => entry.userLevel)) : undefined))?.serverName
    },
  }

  const mounter: Mounter = {
    mount: async ({ component, plugin, dataDir, scope }) => {
      if (component.kind !== 'mcp') throw new HarnessError('component-failed', `action expects MCP: ${component.id}`)
      const serverName = mcpServerName(foreignServerName(plugin, component.name))
      // A session's project servers stay in its own context; the catalog is process-wide.
      const vars = { pluginRoot: plugin.root, dataDir, env: forge.settings.env(), provided: harnessVariables(plugin) }
      const policy = mcpToolPolicy(component, serverName)
      const options = { catalog: scope.sessionId === undefined }
      const entry = (route: ServerEntry['route']): ServerEntry => ({
        serverName,
        componentId: component.id,
        route,
        pluginId: plugin.id,
        pluginName: plugin.name,
        declaredName: component.declaredName ?? component.name,
        userLevel: plugin.manifest?.['scope'] === 'user',
        ...(scope.sessionId !== undefined ? { sessionId: scope.sessionId } : {}),
        ...(policy !== undefined ? { policy } : {}),
      })
      // Published before the server's tools can be called; a mount that fails has withdrawn them itself.
      let server = entry(servedByCatalog(scope.ctx ?? ctx, component, options) ? 'catalog' : 'direct')
      servers.add(server)
      let mount: Awaited<ReturnType<typeof mountMcp>>
      try {
        mount = await mountMcp(scope.ctx ?? ctx, component, serverName, vars, remoteHost(component.id, scope), options)
      } catch (error: unknown) {
        servers.delete(server)
        throw error
      }
      // The catalog came or went while the server mounted: the policy follows the route it took.
      const route = mount.catalog === true ? 'catalog' : 'direct'
      if (route !== server.route) {
        const moved = entry(route)
        servers.add(moved)
        servers.delete(server)
        server = moved
      }
      return {
        outcome: mounted(component, 'L1b', mount.catalog === true ? `${serverName} (capability catalog)` : serverName),
        // A withdrawal that fails leaves the tools registered, so their policy stays until one succeeds.
        disposer: async () => {
          await mount.dispose()
          servers.delete(server)
          if (mount.remote !== undefined) remotes.delete(mount.remote)
        },
      }
    },
  }

  /**
   * The server a call goes to: a catalog call (`capability_call`) only among
   * servers registered in the catalog, a direct call only among direct ones,
   * so two servers of one name, one in each, never lend each other a policy.
   * Among those, the calling session's own first, then the process-wide one of
   * that name. A catalog call names the server and the raw
   * tool exactly. A direct call names the tool `dsh-mcp-client` registered in
   * the server's namespace `mcp__<server>__`; server names never hold `__`
   * ({@link mcpServerName}), so one namespace holds it, and the policy knows
   * the raw name of every tool it configures by that same public name.
   */
  const targetOf = (exec: ToolCall): CallTarget | undefined => {
    const sessionId = exec.agent?.session?.header?.id
    const pick = (route: ServerEntry['route'], matches: (server: ServerEntry) => boolean): ServerEntry | undefined => {
      const matching = [...servers].filter(server => server.route === route && matches(server))
      return matching.find(candidate => sessionId !== undefined && candidate.sessionId === sessionId)
        ?? matching.find(candidate => candidate.sessionId === undefined)
    }
    if (exec.name === CATALOG_CALL_TOOL) {
      const entry = catalogEntry((exec.arguments as { id?: unknown } | undefined)?.id)
      const server = entry === undefined ? undefined : pick('catalog', candidate => candidate.serverName === entry.server)
      return entry === undefined || server === undefined ? undefined : { server, rawName: entry.tool, toolName: `mcp__${entry.server}__${entry.tool}` }
    }
    const server = pick('direct', candidate => exec.name.startsWith(`mcp__${candidate.serverName}__`))
    const rawName = server?.policy?.rawName(exec.name)
    return server === undefined ? undefined : { server, ...(rawName !== undefined ? { rawName } : {}), toolName: exec.name }
  }

  /**
   * Calls refused before they ran. DSH still runs `tools/post-execute` for the refusal's error result, but the
   * server never saw the call: a refusal is the policy's doing, not evidence about the part, and recording it
   * would mark the part failed (and list it in Diagnostics as one that failed to start).
   */
  const refused = new WeakSet<object>()
  /** A server's own filters and approval modes for one call (see `McpApi.toolPolicy`). */
  function toolPolicy(exec: ToolCall): McpToolVerdict | undefined {
    const target = targetOf(exec)
    return target?.server.policy?.decide(target.rawName, target.toolName)
  }

  const parts = new Parts(ctx, forge, 'mcp')
  // A server's own tool filters and approval modes: a switched-off tool is refused, an asking one asks whatever
  // the rest of the chain allowed. First in the chain, so nothing before it can allow the call outright.
  parts.add('tool policy', () => onDsh(ctx, 'tools/pre-execute', (async (exec: ToolCall, next: () => Promise<{ kind: string }>) => {
    const target = targetOf(exec)
    const verdict = toolPolicy(exec)
    if (verdict?.kind === 'deny') {
      refused.add(exec)
      return { kind: 'deny', reason: verdict.reason }
    }
    const decided = await next()
    if (decided.kind === 'deny' && target !== undefined) refused.add(exec)
    return verdict?.kind === 'ask' && decided.kind === 'allow' ? { kind: 'ask', reason: verdict.reason } : decided
  }) as never, { owner: 'mcp', prepend: true }))
  parts.add('tool evidence', () => onDsh(ctx, 'tools/post-execute', ((exec: ToolCall, result: { isError: boolean; error?: { message?: string } }, next: () => unknown) => {
    const target = targetOf(exec)
    if (target !== undefined && !refused.has(exec)) {
      forge.observe(target.server.componentId, `tool:${target.toolName}`, !result.isError, result.isError ? result.error?.message ?? 'tool call failed' : `tool call returned${target.toolName !== exec.name ? ' through the capability catalog' : ''}`)
    }
    return next()
  }) as never, { owner: 'mcp' }))
  let unregister: Disposer = () => {}
  let stopping = false
  parts.add('mcp mounter', () => {
    unregister = forge.registerMounter('mcp', mounter)
    return () => unregister()
  })
  // The capability catalog is optional and may come and go: its stdio servers move into it when it starts and
  // mount directly again when it stops. Nothing waits for it.
  parts.add('capability catalog', () => {
    const fiber = ctx.inject([...CATALOG_SERVICES], (catalogCtx) => {
      const remount = (): void => {
        if (stopping) return
        unregister()
        unregister = forge.registerMounter('mcp', mounter)
      }
      remount()
      catalogCtx.effect(() => remount, 'harness-forge.mcp-catalog')
    }) as unknown as { dispose(): unknown }
    return () => fiber.dispose()
  })
  parts.add('api', () => forge.provide('mcp', api))
  parts.add('sign-in store', () => () => { auth.close() })
  // Torn down first: the catalog's going away with this row moves nothing.
  parts.add('stopping', () => () => { stopping = true })
  return () => parts.dispose()
}
