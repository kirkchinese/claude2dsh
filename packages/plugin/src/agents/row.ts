/**
 * The agents row: imported agents become DSH agent presets offered through
 * one delegation tool (a session's project agents through a tool of its own),
 * with their frontmatter's run-time effects (`model`, `skills`, `mcpServers`,
 * `maxTurns`, `memory`, `isolation: worktree`, `initialPrompt`), and the hooks
 * their frontmatter declares, which the hooks row runs.
 * @module @kirkchinese/harness-forge/agents
 */
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@kirkchinese/harness-forge-core'
import { AgentProfiles } from './profiles.js'
import { AgentTool, mountAgentPreset } from './presets.js'
import { dshService, onDsh, presetOfSession } from '../dsh/host.js'
import type { AgentsApi, Disposer, FrontmatterHooks, MountScope } from '../forge/contract.js'
import { FORGE_SERVICE, type HarnessForge } from '../forge/service.js'
import { hookSource, parseHookTable } from '../hooks/config.js'
import { isOwnAssets, type RemoteMcpHost } from '../mcp/mount.js'
import { messageOf } from '../shared/util.js'
import { mounted, Parts, rowEffect } from '../forge/row.js'

export const name = 'harness-forge-agents'
export const inject = [FORGE_SERVICE]

/** The agents row. */
export function apply(ctx: Context): void {
  rowEffect(ctx, 'agents', forge => startAgents(ctx, forge))
}

interface AgentLike {
  readonly session: unknown
}

/** One tool dispatch, as the `tools/execute` waterfall passes it. */
interface ToolExecLike {
  readonly name: string
  readonly arguments: unknown
  readonly agent?: unknown
  readonly signal: AbortSignal
}

/** Start the agents row on the shared service. Returns its teardown. */
export function startAgents(ctx: Context, forge: HarnessForge): Disposer {
  const agents = new AgentTool(ctx)
  /** Each session's own delegation tool, for its project agents. */
  const sessionAgents = new Map<string, AgentTool>()
  /** The component of each mounted preset, for its run evidence. */
  const presets = new Map<string, string>()
  const agentHooks = new Map<string, FrontmatterHooks>()
  const remoteHost = (componentId: string): RemoteMcpHost => {
    const mcp = forge.lookup('mcp')
    if (mcp === undefined) throw new Error('the agent\'s MCP servers need the Harness Forge mcp row, which is off')
    return mcp.remoteHost(componentId)
  }
  const profiles = new AgentProfiles(ctx, forge.shell, forge.dataRoot, remoteHost)
  const toolOf = (scope: MountScope): AgentTool => {
    if (scope.ctx === undefined || scope.sessionId === undefined) return agents
    let tool = sessionAgents.get(scope.sessionId)
    if (tool === undefined) {
      tool = new AgentTool(scope.ctx, agents)
      // A tool mounted in an agent's context takes no config updates: it starts once, with every project agent.
      tool.hold()
      sessionAgents.set(scope.sessionId, tool)
    }
    return tool
  }

  /** An agent with `isolation: worktree` starts in a fresh git worktree of the repository. */
  const isolate = async (exec: ToolExecLike, next: () => Promise<unknown>): Promise<unknown> => {
    const args = exec.arguments as { agent_preset?: unknown; cwd?: unknown } | undefined
    if (exec.agent === undefined || !profiles.isolated(args?.agent_preset)) return next()
    const base = typeof args?.cwd === 'string' && args.cwd.length > 0 ? args.cwd : await forge.directory(exec.agent, exec.signal)
    const worktree = await profiles.worktree(base)
    if (worktree === undefined) return next()
    const tools = dshService(ctx, 'tools') as { get(name: string, scope?: unknown): { execute(args: unknown, exec: unknown): Promise<unknown>; output: { render(args: unknown, value: unknown): unknown } } | undefined } | undefined
    const definition = tools?.get(exec.name, exec.agent)
    if (definition === undefined) return next()
    const isolated = { ...(exec.arguments as Record<string, unknown>), cwd: worktree }
    try {
      const value = await definition.execute(isolated, exec)
      return { isError: false, value, content: definition.output.render(isolated, value) }
    } catch (error: unknown) {
      const message = messageOf(error)
      return { isError: true, error: { message }, content: [{ type: 'text', text: `Error: ${message}` }] }
    }
  }

  /** A delegated run under an imported preset is evidence for its component. */
  const observeRun = (childId: string, ok: boolean, detail: string): void => {
    const child = (dshService(ctx, 'agents') as { get(id: string): AgentLike | undefined } | undefined)?.get(childId)
    if (child === undefined) return
    const preset = presetOfSession(ctx, child.session)
    const componentId = preset === undefined ? undefined : presets.get(preset)
    if (componentId !== undefined) forge.observe(componentId, 'agent-run', ok, detail)
  }

  const api: AgentsApi = {
    foreignName: presetId => agents.foreignName(presetId),
    presetOf: foreignName => agents.presetOf(foreignName),
    agentHooks: presetId => agentHooks.get(presetId),
  }

  const parts = new Parts(ctx, forge, 'agents')
  parts.add('profiles', () => profiles.install())
  parts.add('isolation', () => onDsh(ctx, 'tools/execute', ((exec: ToolExecLike, next: () => Promise<unknown>) => isolate(exec, next)) as never, { owner: 'agents' }))
  parts.add('run evidence', () => {
    const stops = [
      onDsh(ctx, 'subagent/start', ((info: { id: string }) => { observeRun(info.id, true, 'delegated run started') }) as never, { owner: 'agents' }),
      onDsh(ctx, 'subagent/end', ((info: { id: string; stopReason: string }) => { observeRun(info.id, info.stopReason !== 'error', `delegated run ended: ${info.stopReason}`) }) as never, { owner: 'agents' }),
    ]
    return () => { for (const stop of stops) stop() }
  })
  parts.add('delegation tool', () => () => agents.dispose())
  parts.add('agent mounter', () => forge.registerMounter('agent', {
    mount: async ({ component, plugin, dataDir, scope }) => {
      if (component.kind !== 'agent') throw new HarnessError('component-failed', `action expects an agent: ${component.id}`)
      const mount = await mountAgentPreset(scope.ctx ?? ctx, component, plugin.name)
      const withdraw = toolOf(scope).add(mount.presetId, isOwnAssets(plugin) ? component.name : `${plugin.name}:${component.name}`)
      presets.set(mount.presetId, component.id)
      const hooks = component.frontmatter['hooks']
      const source = hooks === undefined ? undefined : hookSource(component.id, plugin, dataDir, parseHookTable(hooks), 'agent')
      if (source !== undefined) agentHooks.set(mount.presetId, source)
      // `model`, `effort`, `skills`, `mcpServers`, `maxTurns`, `memory`, `isolation`, `initialPrompt`.
      const withdrawProfile = profiles.register({
        presetId: mount.presetId,
        name: component.name,
        pluginId: plugin.id,
        frontmatter: component.frontmatter,
        vars: { pluginRoot: plugin.root, dataDir, env: forge.settings.env() },
      })
      return {
        outcome: mounted(component, 'L1b', mount.presetId),
        disposer: async () => {
          if (presets.get(mount.presetId) === component.id) presets.delete(mount.presetId)
          if (source !== undefined && agentHooks.get(mount.presetId) === source) agentHooks.delete(mount.presetId)
          withdraw()
          withdrawProfile()
          await mount.dispose()
        },
      }
    },
    // The delegation tool restarts on each agent change; the next request must see them all.
    settle: async (scope) => {
      const tool = toolOf(scope)
      tool.resume()
      await tool.settled()
    },
    release: async (scope) => {
      if (scope.sessionId === undefined) return
      const tool = sessionAgents.get(scope.sessionId)
      sessionAgents.delete(scope.sessionId)
      await tool?.dispose()
    },
  }))
  // A preset registry that starts after this row retries the agents that needed it.
  parts.add('preset registry', () => {
    const fiber = ctx.inject(['agentPresets'], () => { forge.ledger.reapply() }) as unknown as { dispose(): unknown }
    return () => fiber.dispose()
  })
  parts.add('api', () => forge.provide('agents', api))
  return () => parts.dispose()
}
