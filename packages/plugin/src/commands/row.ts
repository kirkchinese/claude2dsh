/**
 * The commands row: imported slash commands (Claude Code commands, Codex
 * prompts, OpenCode commands and the commands an OpenCode plugin adds), and
 * Claude Code output styles with `/output-style`.
 * @module @kirkchinese/harness-forge/commands
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { HarnessError, kebabCase, uniqueName } from '@kirkchinese/harness-forge-core'
import { commandDefinition, type CommandHost } from './definition.js'
import { interceptCommands } from '../dsh/commands.js'
import { dshService } from '../dsh/host.js'
import type { CommandsApi, Disposer, MountScope } from '../forge/contract.js'
import { FORGE_SERVICE, type HarnessForge } from '../forge/service.js'
import { hookSource, parseHookTable } from '../hooks/config.js'
import { isOwnAssets, projectRootOf, templateScope } from '../mcp/mount.js'
import { OutputStyles } from './output-styles.js'
import { messageOf } from '../shared/util.js'
import { mounted, Parts, rowEffect } from '../forge/row.js'

export const name = 'harness-forge-commands'
export const inject = [FORGE_SERVICE]

/** How long a slash command typed while imported plugins still mount waits for them at most. */
const READY_WAIT_MS = 30_000

/** The subset of the command registry a mount uses. */
interface CommandRegistrar {
  register(definition: CommandDefinition): () => void
}

/** The commands row. */
export function apply(ctx: Context): void {
  rowEffect(ctx, 'commands', forge => startCommands(ctx, forge))
}

/** The command registry of a scope: the session's for project assets. */
function registrarOf(ctx: Context, scope: MountScope): CommandRegistrar | undefined {
  return dshService(scope.ctx ?? ctx, 'commands') as CommandRegistrar | undefined
}

/** Start the commands row on the shared service. Returns its teardown. */
export function startCommands(ctx: Context, forge: HarnessForge): Disposer {
  const stylePath = join(forge.dataRoot, 'output-style.json')
  const outputStyles = new OutputStyles(
    () => {
      try {
        const saved = (JSON.parse(readFileSync(stylePath, 'utf8')) as { selected?: unknown }).selected
        return typeof saved === 'string' ? saved : undefined
      } catch {
        return undefined
      }
    },
    (selected) => {
      mkdirSync(forge.dataRoot, { recursive: true })
      writeFileSync(stylePath, JSON.stringify({ selected: selected ?? null }))
    },
    () => forge.settings.outputStyle(),
  )
  let beforeSubmit: Parameters<CommandsApi['setBeforeSubmit']>[0] | undefined
  const host: CommandHost = {
    shell: forge.shell,
    hooks: () => forge.lookup('hooks'),
    invocations: forge.invocations,
    directory: (agent, signal) => forge.directory(agent, signal),
    observe: (componentId, ok, detail) => { forge.observe(componentId, 'command', ok, detail) },
    trust: dir => forge.projects.trust.state(dir),
    beforeSubmit: (agent, command, prompt) => beforeSubmit === undefined ? Promise.resolve([prompt]) : beforeSubmit(agent, command, prompt),
  }
  const api: CommandsApi = {
    registerAdded: (command, scope, taken) => {
      const commands = registrarOf(ctx, scope)
      if (commands === undefined) return undefined
      const added = uniqueName(kebabCase(command.name), taken, command.component.id)
      if (command.component.kind !== 'command') return undefined
      const dispose = commands.register(commandDefinition(command.component, added, { pluginRoot: command.pluginRoot, dataDir: command.dataDir, foreignName: command.foreignName, pluginId: command.pluginId }, host))
      return { name: added, dispose }
    },
    setBeforeSubmit: (hook) => {
      beforeSubmit = hook
      return () => { if (beforeSubmit === hook) beforeSubmit = undefined }
    },
  }

  const parts = new Parts(ctx, forge, 'commands')
  parts.add('output style section', () => outputStyles.install(ctx))
  parts.add('/output-style', () => registerOutputStyleCommand(ctx, outputStyles))
  // A command typed while imported plugins still mount (DSH just started) waits for them, at most a while.
  parts.add('readiness', () => {
    const commands = dshService(ctx, 'commands') as Parameters<typeof interceptCommands>[0] | undefined
    if (commands === undefined) return undefined
    return interceptCommands(commands, async (args, next) => {
      await Promise.race([forge.ready(), new Promise<void>((resolve) => { setTimeout(resolve, READY_WAIT_MS).unref?.() })])
      return next(args)
    })
  })
  parts.add('command mounter', () => forge.registerMounter('command', {
    mount: async ({ component, plugin, dataDir, scope, commandNames, takenNames }) => {
      if (component.kind !== 'command') throw new HarnessError('component-failed', `action expects a command: ${component.id}`)
      const commands = registrarOf(ctx, scope)
      if (commands === undefined) throw new HarnessError('host-capability-missing', 'this DSH profile has no command registry')
      // Claude Code names a user's or project's own commands without a plugin prefix.
      const own = isOwnAssets(plugin)
      const commandName = commandNames.get(component.id)
        ?? uniqueName(kebabCase(own ? component.name : `${plugin.name}-${component.name}`), takenNames(), component.id)
      commandNames.set(component.id, commandName)
      const local = component.invocationName ?? component.name
      const foreignName = own ? local : `${plugin.name}:${local}`
      const hooks = component.frontmatter['hooks']
      const hookTable = hooks === undefined ? undefined : hookSource(component.id, plugin, dataDir, parseHookTable(hooks), 'skill')
      const projectRoot = projectRootOf(plugin)
      const dispose = commands.register(commandDefinition(component, commandName, {
        pluginRoot: plugin.root,
        dataDir,
        foreignName,
        pluginId: plugin.id,
        scope: templateScope(plugin),
        ...(projectRoot !== undefined ? { projectRoot } : {}),
        ...(hookTable !== undefined ? { hooks: hookTable } : {}),
      }, host))
      return { outcome: mounted(component, 'L1b', commandName), disposer: async () => { dispose() } }
    },
  }))
  parts.add('output style mounter', () => forge.registerMounter('output-style', {
    mount: async ({ component, plugin }) => {
      if (component.kind !== 'ui' || component.specPath === undefined) throw new HarnessError('component-failed', `action expects an output style: ${component.id}`)
      const style = outputStyles.add(component.specPath, isOwnAssets(plugin) ? undefined : plugin.name, component.id)
      return { outcome: mounted(component, 'L1a', style.name), disposer: async () => { style.dispose() } }
    },
  }))
  // A command registry that starts after this row retries the commands that needed it.
  parts.add('command registry', () => {
    const fiber = ctx.inject(['commands'], () => { forge.ledger.reapply() }) as unknown as { dispose(): unknown }
    return () => fiber.dispose()
  })
  parts.add('api', () => forge.provide('commands', api))
  return () => parts.dispose()
}

/** `/output-style [name]`: list the styles or switch to one, as in Claude Code. */
function registerOutputStyleCommand(ctx: Context, outputStyles: OutputStyles): Disposer | undefined {
  const commands = dshService(ctx, 'commands') as { register(definition: unknown): () => void } | undefined
  if (commands === undefined) return undefined
  return commands.register({
    name: 'output-style',
    description: 'Show or switch the Claude Code output style',
    input: { hint: '[name]' },
    handler: async (invocation: { rawInput: string }) => {
      const wanted = invocation.rawInput.trim()
      if (wanted.length === 0) {
        const current = outputStyles.current()?.name ?? 'default'
        const lines = ['default', ...outputStyles.list().map(style => style.name)]
          .map(name => `${name === current ? '●' : '○'} ${name}${name === 'default' ? '' : ` — ${outputStyles.list().find(style => style.name === name)?.description ?? ''}`}`)
        return { kind: 'success', text: `Output style: ${current}\n${lines.join('\n')}\n\nSwitch with /output-style <name>.` }
      }
      try {
        const selected = outputStyles.select(wanted)
        return { kind: 'success', text: selected === 'default' ? 'Output style set to default.' : `Output style set to ${selected.name}. It applies from the next response.` }
      } catch (error) {
        return { kind: 'error', text: messageOf(error) }
      }
    },
  })
}
