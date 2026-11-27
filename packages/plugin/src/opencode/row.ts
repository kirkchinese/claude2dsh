/**
 * The OpenCode row: OpenCode code plugins, each in its own Bun host, their
 * hooks raised where DSH does the same work. It adds `shell.env` to the hooks
 * row and `command.execute.before` to the commands row while those run, and
 * its plugins' added commands through the commands row.
 * @module @kirkchinese/harness-forge/opencode
 */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@kirkchinese/harness-forge-core'
import { onDsh } from '../dsh/host.js'
import type { Disposer } from '../forge/contract.js'
import { FORGE_SERVICE, type HarnessForge } from '../forge/service.js'
import { OpenCodeRuntime } from './runtime.js'
import { mounted, Parts, rowEffect } from '../forge/row.js'

export const name = 'harness-forge-opencode'
export const inject = [FORGE_SERVICE]

/** The OpenCode row. */
export function apply(ctx: Context): void {
  rowEffect(ctx, 'opencode', forge => startOpenCode(ctx, forge))
}

/** Start the OpenCode row on the shared service. Returns its teardown. */
export function startOpenCode(ctx: Context, forge: HarnessForge): Disposer {
  const opencode = new OpenCodeRuntime(ctx, {
    dataRoot: join(forge.dataRoot, 'opencode'),
    observe: (componentId, signal, ok, detail) => { forge.observe(componentId, signal, ok, detail) },
    directory: (agent, signal) => forge.directory(agent, signal),
    rewrite: (callId, args) => { forge.lookup('hooks')?.rewrite(callId, args) },
    agentName: presetId => forge.lookup('agents')?.foreignName(presetId),
  })
  /** The component of each tool a plugin registered, for its call evidence. */
  const tools = new Map<string, string>()

  const parts = new Parts(ctx, forge, 'opencode')
  parts.add('runtime', () => opencode.install())
  parts.add('tool evidence', () => onDsh(ctx, 'tools/post-execute', ((exec: { name: string }, result: { isError: boolean; error?: { message?: string } }, next: () => unknown) => {
    const componentId = tools.get(exec.name)
    if (componentId !== undefined) forge.observe(componentId, `tool:${exec.name}`, !result.isError, result.isError ? result.error?.message ?? 'tool call failed' : 'tool call returned')
    return next()
  }) as never, { owner: 'opencode' }))
  parts.add('shell.env', () => forge.watch('hooks', hooks => hooks.addShellEnv(exec => opencode.shellEnv(exec as never))))
  parts.add('command.execute.before', () => forge.watch('commands', commands => commands.setBeforeSubmit((agent, command, prompt) => opencode.beforeCommand(agent as never, command, prompt))))
  parts.add('plugin mounter', () => forge.registerMounter('opencode-plugin', {
    mount: async ({ component, plugin, dataDir, scope, takenNames }) => {
      if (component.kind !== 'code') throw new HarnessError('component-failed', `action expects code: ${component.id}`)
      const mount = await opencode.mount(component, plugin)
      for (const tool of mount.tools) tools.set(tool, component.id)
      // Commands the plugin's `config` hook added run like the project's own OpenCode commands.
      const withdraw: Array<() => void> = []
      const commandNames: string[] = []
      const commands = forge.lookup('commands')
      if (commands !== undefined) {
        const taken = takenNames()
        for (const command of mount.commands) {
          const added = commands.registerAdded({ component: command.component, name: command.name, foreignName: command.name, pluginId: plugin.id, pluginRoot: plugin.root, dataDir }, scope, taken)
          if (added === undefined) continue
          taken.add(added.name)
          withdraw.push(added.dispose)
          commandNames.push(added.name)
        }
        opencode.recordAddedCommands(component.id, mount.commands.map((command, index) => ({ name: commandNames[index] ?? command.name, foreignName: command.name, template: command.component.body })))
      }
      const summary = [
        `opencode-plugin hooks [${mount.hooks.join(', ')}]`,
        `tools [${mount.tools.join(', ')}]`,
        // The names they are typed under in DSH.
        ...(commandNames.length > 0 ? [`commands [${commandNames.join(', ')}]`] : []),
        // What its config hook changed: only `command` is applied in DSH.
        ...(mount.configChanged.length > 0 ? [`config [${mount.configChanged.join(', ')}]`] : []),
      ].join('; ')
      return {
        outcome: mounted(component, 'L1b', summary),
        disposer: async () => {
          for (const tool of mount.tools) if (tools.get(tool) === component.id) tools.delete(tool)
          for (const dispose of withdraw) dispose()
          await mount.dispose()
        },
      }
    },
  }))
  return () => parts.dispose()
}
