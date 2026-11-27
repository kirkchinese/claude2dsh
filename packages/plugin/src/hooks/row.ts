/**
 * The hooks row: imported hooks configurations (plugin hooks, settings hooks,
 * skill, agent and command frontmatter hooks) run through one broker on DSH's
 * interception points, and the run-time parts of a user's Codex configuration
 * (`notify`, global instructions). Mods and OpenCode plugins add to it
 * (`tool.check`, `shell.env`) through its API; it asks nothing of them.
 * @module @kirkchinese/harness-forge/hooks
 */
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@kirkchinese/harness-forge-core'
import { mountCodexInstructions, mountCodexNotify } from './codex-user.js'
import { onDsh } from '../dsh/host.js'
import type { Disposer, HooksApi, ToolVerdict } from '../forge/contract.js'
import { FORGE_SERVICE, type HarnessForge } from '../forge/service.js'
import { HookBroker } from './broker.js'
import { hookSource, parseHookTable, readHookTable } from './config.js'
import { mounted, Parts, rowEffect } from '../forge/row.js'

export const name = 'harness-forge-hooks'
export const inject = [FORGE_SERVICE]

/** The hooks row. */
export function apply(ctx: Context): void {
  rowEffect(ctx, 'hooks', forge => startHooks(ctx, forge))
}

/** Start the hooks row on the shared service. Returns its teardown. */
export function startHooks(ctx: Context, forge: HarnessForge): Disposer {
  let checker: { checks(exec: unknown): boolean; check(exec: unknown, verdict: ToolVerdict): Promise<ToolVerdict> } | undefined
  const shellEnvs = new Set<(exec: unknown) => Promise<Record<string, string>>>()
  const broker = new HookBroker(ctx, {
    shell: forge.shell,
    dataRoot: forge.dataRoot,
    observe: ({ componentId, event, ok, detail }) => { forge.observe(componentId, `hook:${event}`, ok, detail) },
    agentName: presetId => forge.lookup('agents')?.foreignName(presetId),
    presetOf: foreignName => forge.lookup('agents')?.presetOf(foreignName),
    skillHooks: skill => forge.lookup('skills')?.skillHooks(skill),
    agentHooks: presetId => forge.lookup('agents')?.agentHooks(presetId),
    reloadSkills: () => { forge.lookup('skills')?.reload() },
    environment: session => forge.settings.env(session),
    permissionRules: session => forge.settings.permissionRules(session),
    hooksDisabled: session => forge.settings.hooksDisabled(session),
    prepareSession: (agent, cwd) => forge.projects.prepare(agent as never, cwd),
    releaseSession: sessionId => forge.projects.release(sessionId),
    check: (exec, verdict) => checker === undefined ? Promise.resolve(verdict) : checker.check(exec, verdict),
    checks: exec => checker?.checks(exec) ?? false,
    shellEnv: async (exec) => {
      const env: Record<string, string> = {}
      for (const provider of shellEnvs) Object.assign(env, await provider(exec))
      return env
    },
  })
  const api: HooksApi = {
    rewrite: (callId, args) => { broker.rewrite(callId, args) },
    expandSkill: (agent, skill, signal) => broker.expandSkill(agent as never, skill, signal),
    expandCommand: (agent, command, signal) => broker.expandCommand(agent as never, command, signal),
    add: source => broker.add(source),
    setChecker: (next) => {
      checker = next
      return () => { if (checker === next) checker = undefined }
    },
    addShellEnv: (provider) => {
      shellEnvs.add(provider)
      return () => { shellEnvs.delete(provider) }
    },
  }
  const parts = new Parts(ctx, forge, 'hooks')
  parts.add('broker', () => broker.install())
  // A skill's frontmatter hooks run for the rest of the session once the skill is invoked.
  parts.add('skill hooks', () => onDsh(ctx, 'tools/post-execute', ((exec: { name: string; arguments: unknown; agent?: { session: { header: { id: string } } } }, result: { isError: boolean }, next: () => unknown) => {
    if (exec.name === 'skill' && !result.isError && exec.agent !== undefined) {
      const skill = (exec.arguments as { name?: unknown } | undefined)?.name
      const source = typeof skill === 'string' ? forge.lookup('skills')?.skillHooks(skill) : undefined
      if (source !== undefined) broker.add({ ...source, origin: 'skill', sessionId: exec.agent.session.header.id })
    }
    return next()
  }) as never, { owner: 'hooks' }))
  parts.add('hooks mounter', () => forge.registerMounter('hooks', {
    mount: async ({ component, plugin, dataDir, scope }) => {
      if (component.kind !== 'hooks') throw new HarnessError('component-failed', `action expects hooks: ${component.id}`)
      const table = component.configPath.length > 0 ? readHookTable(component.configPath) : parseHookTable(component.inline ?? {})
      const origin = component.metadata?.['origin'] === 'settings' ? 'settings' : 'plugin'
      const dispose = broker.add({ ...hookSource(component.id, plugin, dataDir, table, origin), ...(scope.sessionId !== undefined ? { sessionId: scope.sessionId } : {}) })
      return { outcome: mounted(component, 'L1b', [...table.keys()].join(',')), disposer: async () => { dispose() } }
    },
  }))
  parts.add('codex-notify mounter', () => forge.registerMounter('codex-notify', {
    mount: async ({ component, plugin }) => {
      const dispose = mountCodexNotify(ctx, plugin.root, (ok, detail) => { forge.observe(component.id, 'notify', ok, detail) })
      return { outcome: mounted(component, 'L1b', 'runs after each completed turn'), disposer: async () => { dispose() } }
    },
  }))
  parts.add('codex-instructions mounter', () => forge.registerMounter('codex-instructions', {
    mount: async ({ component, plugin }) => {
      if (component.path === undefined) throw new HarnessError('component-failed', `instructions without a file: ${component.id}`)
      const dispose = mountCodexInstructions(ctx, plugin.root, component.path, (ok, detail) => { forge.observe(component.id, 'instructions', ok, detail) })
      return { outcome: mounted(component, 'L1a', `${component.path} in the system prompt`), disposer: async () => { dispose() } }
    },
  }))
  parts.add('api', () => forge.provide('hooks', api))
  return () => parts.dispose()
}
