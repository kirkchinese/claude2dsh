/**
 * The `harness-forge` row: the ledger (discover, plan, apply, undo, remove),
 * the shared service every other row reaches as `harnessForge`, imported
 * settings, project assets, the turn lifecycle of invoked skills and
 * commands, `/harness` and the `harness_*` model tools. The capability rows
 * (skills, commands, agents, hooks, MCP, mods, OpenCode, sessions, porter,
 * workbench) are rows of their own; each can be off without affecting the rest.
 * @module @kirkchinese/harness-forge
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { CommandDefinition, CommandInvocation } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-commands'
import { dialectIds } from '@kirkchinese/harness-forge-core'
import { FORGE_SERVICE, HarnessForge } from './forge/service.js'
import { registerModelTools } from './workbench/model-tools.js'
import { setModelAliases } from './shared/invocation.js'
import { registerBundledSkills } from './skills/bundled.js'
import { defaultStatePath, resolveDshHome } from './forge/state.js'
import { dshService, onDsh, reportFaults } from './dsh/host.js'
import { turnListeners } from './forge/turns.js'
import { Workbench } from './workbench/workbench.js'
import { loggerOf, messageOf } from './shared/util.js'
import { Parts } from './forge/row.js'

/** Plugin configuration. */
export interface Config {
  /** Plugin roots installed automatically at boot (acceptance/demo profiles). */
  preload?: string[]
  /** Write lifecycle diagnostics to `$DSH_HOME/harness-forge/debug.log`. */
  debug?: boolean
  /**
   * The model a Claude alias (`haiku`, `sonnet`, `opus`, or a `claude-…` id of that family) runs on, as
   * `provider/model`. Without an entry the session's model answers it: model names do not say which is stronger.
   */
  modelAliases?: { haiku?: string; sonnet?: string; opus?: string }
}

/** Schemastery validation for the plugin configuration. */
// Schemastery's inferred array-output type includes its Volatile wrapper even
// for a required array; the runtime schema is a plain string array.
export const Config = z.object({
  preload: z.array(z.string()),
  debug: z.boolean(),
  modelAliases: z.object({ haiku: z.string(), sonnet: z.string(), opus: z.string() }),
}) as unknown as z<Config>

/** Cordis plugin name. */
export const name = 'harness-compat'

/** Every DSH service the row uses is optional: a headless profile runs the ledger alone. */
export const inject: string[] = []

/** How long a new session's first request waits for imported plugins to mount at most. */
const READY_WAIT_MS = 30_000

const COMMAND_HINT = '<status|list|scan|plan|import|undo|remove|roots|login> [args]'

/** Create the `/harness` command over the installation service. */
function harnessCommand(service: HarnessForge, workbench: Workbench): CommandDefinition {
  return {
    name: 'harness',
    description: 'Scan, install and inspect foreign Claude Code / Codex / OpenCode plugins',
    input: { hint: COMMAND_HINT },
    handler: async (invocation: CommandInvocation) => {
      const input = invocation.rawInput.trim()
      const space = input.indexOf(' ')
      const verb = (space === -1 ? input : input.slice(0, space)).toLowerCase()
      const rest = space === -1 ? '' : input.slice(space + 1).trim()
      switch (verb) {
        case '':
        case 'status':
          return { kind: 'success', text: statusText(service, workbench) }
        case 'roots':
          return { kind: 'success', text: rootsText(workbench) }
        case 'list':
          return { kind: 'success', text: listText(service) }
        case 'scan': {
          const [path, source] = splitPathAndSource(rest)
          if (path.length === 0) return { kind: 'error', text: 'usage: /harness scan <path> [source]' }
          try {
            const plugin = service.scan(path, source)
            return { kind: 'success', text: scanText(plugin) }
          } catch (error: unknown) {
            return { kind: 'error', text: `scan failed: ${messageOf(error)}` }
          }
        }
        case 'import': {
          const [path, source] = splitPathAndSource(rest)
          if (path.length === 0) return { kind: 'error', text: 'usage: /harness import <path> [source]' }
          try {
            const report = await service.install(path, source)
            return {
              kind: 'success',
              text: [
                `Imported ${report.plugin.name} (${report.plugin.source})`,
                `skills: ${report.plugin.components.filter(component => component.kind === 'skill').length}`,
                `commands: ${report.commands.length}${report.commands.length > 0 ? ` (${report.commands.join(', ')})` : ''}`,
                `mcp: ${report.mcp.filter(item => item.status === 'mounted').length}/${report.mcp.length} mounted`,
                `hooks: ${report.hooks.filter(item => item.status === 'mounted').length}/${report.hooks.length} mounted`,
                `agents: ${report.agents.filter(item => item.status === 'mounted').length}/${report.agents.length} presets`,
                ...(report.mcp.some(item => item.status === 'failed') ? [`mcp failures: ${report.mcp.filter(item => item.status === 'failed').map(item => item.name).join(', ')}`] : []),
                ...(report.hooks.some(item => item.status === 'failed') ? [`hooks failures: ${report.hooks.filter(item => item.status === 'failed').map(item => item.name).join(', ')}`] : []),
                ...(report.agents.some(item => item.status === 'failed') ? [`agent failures: ${report.agents.filter(item => item.status === 'failed').map(item => item.name).join(', ')}`] : []),
                ...(report.alreadyInstalled ? ['already installed; no changes'] : []),
                // Every warning, by code: what was left out (an escaping path, a clash of names) and why.
                ...report.plugin.warnings.slice(0, 12).map(warning => `warning ${warning.code}: ${warning.message}`),
                ...(report.plugin.warnings.length > 12 ? [`… ${report.plugin.warnings.length - 12} more warning(s)`] : []),
              ].join('\n'),
            }
          } catch (error: unknown) {
            return { kind: 'error', text: `import failed: ${messageOf(error)}` }
          }
        }
        case 'undo': {
          if (rest.length === 0) return { kind: 'error', text: 'usage: /harness undo <receipt-id>' }
          return await service.undo(rest)
            ? { kind: 'success', text: `Undid receipt ${rest}.` }
            : { kind: 'error', text: `No receipt with id ${rest}.` }
        }
        case 'plan': {
          const [path, source] = splitPathAndSource(rest)
          if (path.length === 0) return { kind: 'error', text: 'usage: /harness plan <path> [source]' }
          try {
            const plan = service.plan(path, source)
            return {
              kind: 'success',
              text: [
                `Plan ${plan.id.slice(0, 12)} for ${plan.pluginId}`,
                `actions: ${plan.actions.length}`,
                `target: assets=${plan.target.assets} runtime=${plan.target.declarativeRuntime} code=${plan.target.codeRuntime} ui=${plan.target.interaction}`,
                `resident tokens: ~${plan.summary.residentTokens}`,
                ...plan.actions.map(action => `- ${action.kind}: ${action.name}`),
              ].join('\n'),
            }
          } catch (error: unknown) {
            return { kind: 'error', text: `plan failed: ${messageOf(error)}` }
          }
        }
        case 'remove': {
          if (rest.length === 0) return { kind: 'error', text: 'usage: /harness remove <plugin-id>' }
          return await service.uninstall(rest)
            ? { kind: 'success', text: `Removed ${rest}.` }
            : { kind: 'error', text: `No installed plugin with id ${rest}.` }
        }
        case 'login': {
          const mcp = service.lookup('mcp')
          if (mcp === undefined) return { kind: 'error', text: 'The Harness Forge mcp row is off; turn it on in Plugin Manager.' }
          const sessionId = invocation.agent.session.header.id
          const pending = mcp.pendingSignIns(sessionId)
          const server = rest.length > 0 ? rest : pending.length === 1 ? pending[0]! : ''
          if (server.length === 0) {
            return pending.length === 0
              ? { kind: 'success', text: 'No MCP server is waiting for sign-in.' }
              : { kind: 'success', text: `MCP servers waiting for sign-in:\n${pending.map(name => `- ${name}`).join('\n')}\nRun /harness login <server>.` }
          }
          try {
            const url = mcp.startSignIn(server, sessionId)
            return { kind: 'success', text: `Opened the sign-in page for ${server} in your browser. If it did not open, visit:\n${url}\nThe server connects as soon as you finish.` }
          } catch (error: unknown) {
            return { kind: 'error', text: messageOf(error) }
          }
        }
        default:
          return {
            kind: 'error',
            text: `usage: /harness ${COMMAND_HINT}`,
          }
      }
    },
  }
}

/**
 * Activate the ledger and the shared service. The ledger and `preload`
 * plugins mount in the background; a new session's first request waits for
 * them (at most a while), so it already has their skills, commands, hooks,
 * MCP tools and agents, as Claude Code loads plugins before a session starts.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  setModelAliases(config.modelAliases)
  const log = loggerOf(ctx)
  const profile = dshService(ctx, 'profileContext') as { readonly dir?: string; readonly name?: string } | undefined
  const statePath = defaultStatePath(process.env, profile)
  const dataRoot = profile?.dir !== undefined && profile.dir.length > 0
    ? join(profile.dir, '.harness-forge', 'data')
    : join(resolveDshHome(), 'harness-forge', 'data')
  const forge = new HarnessForge(ctx, statePath, dataRoot)
  const workbench = new Workbench(forge)
  // Started before anything else can reach the service, so the restore holds its queue ahead of any install or
  // removal (which would otherwise write a ledger without the restored records).
  const startup = forge.start(config.preload ?? [])
  startup.catch((error: unknown) => { log?.warn?.(`harness-forge: startup failed: ${messageOf(error)}`) })

  const parts = new Parts(ctx, forge, 'harness-forge')
  ctx.effect(() => () => parts.dispose(), 'harness-forge.parts')
  ctx.effect(() => () => forge.dispose(), 'harness-forge.ledger')
  parts.add('faults', () => reportFaults(ctx, (error) => { forge.fault('harness-forge', error) }))
  if (typeof (ctx as { provide?: unknown }).provide === 'function') parts.add('shared service', () => ctx.provide(FORGE_SERVICE, forge))
  if (config.debug === true) parts.add('debug log', () => debugLog(ctx, join(dirname(statePath), 'debug.log')))
  ctx.inject(['skills'], (skillCtx) => { registerBundledSkills(skillCtx) })
  for (const [label, start] of turnListeners(ctx, forge)) parts.add(label, start)
  // Project assets load for every new top-level session; the hooks row, when it runs, loads them first
  // (before SessionStart) and withdraws them after SessionEnd, otherwise this row does.
  parts.add('project assets', () => {
    const stops = [
      onDsh(ctx, 'agent/created', ((payload: { agent: { session: { header: { id: string; cwd?: string; delegationDepth?: number } } }; signal?: AbortSignal }) => {
        const agent = payload.agent
        return forge.directory(agent, payload.signal ?? new AbortController().signal).then(cwd => forge.projects.prepare(agent, cwd))
      }) as never, { owner: 'harness-forge' }),
      onDsh(ctx, 'agent/disposed', ((payload: { agent: { session: { header: { id: string } } } }) => {
        if (forge.lookup('hooks') === undefined) void forge.projects.release(payload.agent.session.header.id)
      }) as never, { owner: 'harness-forge' }),
    ]
    return () => { for (const stop of stops) stop() }
  })
  // DSH awaits `agent/created` listeners before an agent takes its first input: waiting there holds a new session's
  // first request until what is installed has mounted (DSH 0.2.2 collects a request's tools before assembling it).
  parts.add('readiness', () => onDsh(ctx, 'agent/created', (async () => {
    await Promise.race([forge.ready(), new Promise<void>((resolve) => { setTimeout(resolve, READY_WAIT_MS).unref?.() })])
  }) as never, { prepend: true, owner: 'harness-forge' }))
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.effect(() => commandCtx.commands.register(harnessCommand(forge, workbench)), 'harness-forge.command')
  })
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => registerModelTools(toolCtx, forge), 'harness-forge.model-tools')
  })

  // The capability parts, each isolated from the others.
}

/** Write agent lifecycle diagnostics to a file. Returns the disposer. */
function debugLog(ctx: Context, path: string): () => void {
  const write = (line: string): void => {
    try {
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, `${new Date().toISOString()} ${line}\n`)
    } catch {
      // Diagnostics must never affect the host.
    }
  }
  return onDsh(ctx, 'agent/created', ((payload: { agent?: { id?: string }; source?: unknown }) => {
    write(`agent/created ${payload.agent?.id ?? '?'} source=${JSON.stringify(payload.source)}`)
  }) as never)
}

function statusText(service: HarnessForge, workbench: Workbench): string {
  const records = service.list()
  const pending = service.lookup('mcp')?.pendingSignIns() ?? []
  return [
    'Harness Forge',
    `installed plugins: ${records.length}`,
    `skill roots: ${workbench.listSkillRoots().length}`,
    ...(pending.length > 0 ? [`waiting for sign-in: ${pending.join(', ')} (run /harness login <server>)`] : []),
    'subcommands: status, list, scan <path>, plan <path>, import <path>, undo <receipt>, remove <id>, roots, login [server]',
  ].join('\n')
}

function rootsText(workbench: Workbench): string {
  const roots = workbench.listSkillRoots()
  return roots.length === 0 ? 'No skill roots installed.' : `Skill roots:\n${roots.map(root => `- ${root}`).join('\n')}`
}

function listText(service: HarnessForge): string {
  const records = service.list()
  if (records.length === 0) return 'No foreign plugins installed.'
  return records.map(record => [
    `${record.id}`,
    `  root: ${record.root}`,
    `  components: ${record.components.map(component => component.kind).join(', ') || 'none'}`,
  ].join('\n')).join('\n')
}

function scanText(plugin: ReturnType<HarnessForge['scan']>): string {
  const counts = new Map<string, number>()
  for (const component of plugin.components) counts.set(component.kind, (counts.get(component.kind) ?? 0) + 1)
  return [
    `${plugin.name} (${plugin.source}, ${plugin.ref.manifestKind})`,
    `root: ${plugin.root}`,
    ...(plugin.version !== undefined ? [`version: ${plugin.version}`] : []),
    ...(plugin.license !== undefined ? [`license: ${plugin.license}`] : []),
    `components: ${[...counts].map(([kind, count]) => `${kind}=${count}`).join(', ') || 'none'}`,
    ...(plugin.warnings.length > 0 ? [`warnings: ${plugin.warnings.map(warning => warning.code).join(', ')}`] : []),
  ].join('\n')
}

function splitPathAndSource(input: string): [string, string | undefined] {
  if (input.length === 0) return ['', undefined]
  const lastSpace = input.lastIndexOf(' ')
  if (lastSpace === -1) return [input, undefined]
  const maybeSource = input.slice(lastSpace + 1)
  if ([...dialectIds(), 'foreign'].includes(maybeSource)) {
    return [input.slice(0, lastSpace).trim(), maybeSource]
  }
  return [input, undefined]
}
