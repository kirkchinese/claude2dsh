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
import type { Disposer, McpApi, Mounter, MountScope } from '../forge/contract.js'
import { FORGE_SERVICE, type HarnessForge } from '../forge/service.js'
import { McpAuthStore } from './auth.js'
import { CATALOG_SERVICES, calledTool } from './catalog.js'
import type { RemoteMcp } from './remote.js'
import { foreignServerName, mcpServerName, mountMcp, type RemoteMcpHost } from './mount.js'
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

/** A mounted server's tool-name prefix, for tool-call evidence. */
interface PrefixEntry {
  readonly prefix: string
  readonly componentId: string
  readonly sessionId?: string
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
  /** Each mounted server's tool-name prefix, with its component and session. */
  const prefixes = new Set<PrefixEntry>()

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
  }

  const mounter: Mounter = {
    mount: async ({ component, plugin, dataDir, scope }) => {
      if (component.kind !== 'mcp') throw new HarnessError('component-failed', `action expects MCP: ${component.id}`)
      const serverName = mcpServerName(foreignServerName(plugin, component.name))
      // A session's project servers stay in its own context; the catalog is process-wide.
      const mount = await mountMcp(scope.ctx ?? ctx, component, serverName, { pluginRoot: plugin.root, dataDir, env: forge.settings.env() }, remoteHost(component.id, scope), { catalog: scope.sessionId === undefined })
      const prefix: PrefixEntry = { prefix: `mcp__${serverName}__`, componentId: component.id, ...(scope.sessionId !== undefined ? { sessionId: scope.sessionId } : {}) }
      prefixes.add(prefix)
      return {
        outcome: mounted(component, 'L1b', mount.catalog === true ? `${serverName} (capability catalog)` : serverName),
        disposer: async () => {
          prefixes.delete(prefix)
          if (mount.remote !== undefined) remotes.delete(mount.remote)
          await mount.dispose()
        },
      }
    },
  }

  const parts = new Parts(ctx, forge, 'mcp')
  parts.add('tool evidence', () => onDsh(ctx, 'tools/post-execute', ((exec: { name: string; arguments: unknown; agent?: { session?: { header?: { id?: string } } } }, result: { isError: boolean; error?: { message?: string } }, next: () => unknown) => {
    const toolName = calledTool(exec.name, exec.arguments)
    const sessionId = exec.agent?.session?.header?.id
    const matching = [...prefixes].filter(entry => toolName.startsWith(entry.prefix))
    // The calling session's own server first, then the process-wide one of that name.
    const entry = matching.find(candidate => sessionId !== undefined && candidate.sessionId === sessionId)
      ?? matching.find(candidate => candidate.sessionId === undefined)
    if (entry !== undefined) {
      forge.observe(entry.componentId, `tool:${toolName}`, !result.isError, result.isError ? result.error?.message ?? 'tool call failed' : `tool call returned${toolName !== exec.name ? ' through the capability catalog' : ''}`)
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
