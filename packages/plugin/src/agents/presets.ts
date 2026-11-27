/**
 * Foreign agents as DSH agent presets, plus the delegation tool that offers
 * them to the model.
 *
 * A DSH preset is a complete agent composition, so an imported agent starts
 * from the host's default preset (the same tools, instructions and skills the
 * main agent has), replaces its persona with the agent's prompt, and narrows
 * its tools to the agent's `tools` / `disallowedTools`. The `agent` tool lists
 * every imported agent with its description, as Claude Code's Task tool does.
 * @module @kirkchinese/harness-forge
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import * as subagentTool from '@deepseek-ai/dsh-tool-subagent'
import { load } from 'js-yaml'
import { kebabCase, toolList, type AgentComponent } from '@kirkchinese/harness-forge-core'
import { dshToolsFor } from '../hooks/vocabulary.js'
import { dshService } from '../dsh/host.js'

/** One mounted agent preset. */
export interface AgentMount {
  readonly presetId: string
  readonly dispose: () => Promise<void>
}

type PresetRow = PresetDefinition['plugins'][number]

/** The registry surface used here. */
export interface AgentPresetRegistry {
  readonly defaultId: string
  register(definition: PresetDefinition): Promise<() => Promise<void>>
  readDocument(id: string): Promise<{ readonly content: string }>
}

/** The persona row every built-in preset carries. */
const PERSONA = '@deepseek-ai/dsh-persona'
/** The row that loads AGENTS.md / CLAUDE.md into an agent's context. */
const INSTRUCTIONS = '@deepseek-ai/dsh-agent-instructions'
const TOOL_FILTER = '@kirkchinese/harness-forge/preset-tool-filter'
const FS_SEARCH = '@deepseek-ai/dsh-tool-fs-search'
const FS_SEARCH_STAND_IN = '@kirkchinese/harness-forge/preset-fs-search'

/** The model-facing delegation tool for imported agents. */
export const AGENT_TOOL_NAME = 'agent'

/** The preset id an imported agent is registered under. */
export function agentPresetId(pluginName: string, agentName: string): string {
  return kebabCase(`${pluginName}-${agentName}`)
}

/** Map an agent's tool lists to DSH tool names; unknown names are reported. */
export function agentTools(component: AgentComponent): { allow?: string[]; deny?: string[]; unknown: string[] } {
  const unknown: string[] = []
  const map = (names: readonly string[] | undefined): string[] | undefined => {
    if (names === undefined) return undefined
    const mapped = new Set<string>()
    for (const name of names) {
      const tools = dshToolsFor(name, component.id.startsWith('codex:') ? 'codex' : 'claude-code')
      if (tools.length === 0) unknown.push(name)
      for (const tool of tools) mapped.add(tool)
    }
    return [...mapped]
  }
  const allow = map(toolList(component.frontmatter['tools']))
  const deny = map(toolList(component.frontmatter['disallowedTools'] ?? component.frontmatter['disallowed-tools']))
  return { ...(allow !== undefined ? { allow } : {}), ...(deny !== undefined ? { deny } : {}), unknown }
}

/**
 * Which DSH tools each tool-providing preset row registers, and the row config
 * switch for each tool when the row has one.
 */
const TOOL_ROWS: Readonly<Record<string, ReadonlyArray<{ readonly tool: string; readonly flag?: string }>>> = {
  '@deepseek-ai/dsh-tool-bash': [{ tool: 'bash' }],
  '@deepseek-ai/dsh-tool-pwsh': [{ tool: 'pwsh' }],
  '@deepseek-ai/dsh-tool-fs': [{ tool: 'read', flag: 'read' }, { tool: 'read_image', flag: 'readImage' }, { tool: 'write', flag: 'write' }, { tool: 'edit', flag: 'edit' }],
  '@deepseek-ai/dsh-tool-fs-search': [{ tool: 'glob' }, { tool: 'grep' }],
  '@deepseek-ai/dsh-tool-jobs': [{ tool: 'job_output' }, { tool: 'job_kill' }],
  '@deepseek-ai/dsh-tool-web': [{ tool: 'web_search', flag: 'search' }, { tool: 'web_fetch', flag: 'fetch' }],
  '@deepseek-ai/dsh-tool-todo': [{ tool: 'todo_write' }],
  '@deepseek-ai/dsh-tool-skill': [{ tool: 'skill' }],
  '@deepseek-ai/dsh-tool-ask-user': [{ tool: 'ask_user_question' }],
  '@deepseek-ai/dsh-plan-mode': [{ tool: 'exit_plan_mode' }],
}

/**
 * Rows that let an agent delegate. Claude Code subagents cannot start
 * subagents unless their `tools` names the Agent tool.
 */
const DELEGATION_ROWS = new Set([
  '@deepseek-ai/dsh-tool-subagent',
  '@deepseek-ai/dsh-tool-subagent-control',
  '@deepseek-ai/dsh-tool-subagent-control/list-agents',
  '@deepseek-ai/dsh-workflow-ptc',
  '@deepseek-ai/dsh-tool-workflow',
])

/** Rows whose tools have no Claude Code counterpart; an explicit `tools` list leaves them out. */
const HOST_ONLY_ROWS = new Set([
  '@deepseek-ai/dsh-tool-schedule',
  '@deepseek-ai/dsh-tool-goal',
  '@deepseek-ai/dsh-command-goal',
  '@deepseek-ai/dsh-tool-present',
  '@deepseek-ai/dsh-plugin-manager/tools',
  '@deepseek-ai/dsh-plugin-market/tools',
])

/**
 * Narrow the default preset's rows to an agent's tools: a row whose tools are
 * all excluded is dropped, a row with per-tool switches keeps only the
 * allowed ones. Tools a row cannot switch off individually are denied by the
 * filter row.
 */
export function narrowRows(rows: readonly PresetRow[], allow: ReadonlySet<string> | undefined, deny: ReadonlySet<string>): PresetRow[] {
  const allowed = (tool: string): boolean => !deny.has(tool) && (allow === undefined || allow.has(tool))
  const out: PresetRow[] = []
  for (const row of rows) {
    const name = (row as { name?: unknown }).name
    const nested = (row as { config?: unknown }).config
    if (name === 'cordis:group' && Array.isArray(nested)) {
      const inner = narrowRows(nested as PresetRow[], allow, deny)
      if (inner.length > 0) out.push({ ...row, config: inner } as PresetRow)
      continue
    }
    if (typeof name !== 'string') {
      out.push(row)
      continue
    }
    if (DELEGATION_ROWS.has(name)) {
      // Claude Code's Agent tool starts a subagent; DSH's control and workflow rows (send_message, list_agents,
      // interrupt_agent, workflow) have no Claude Code counterpart, so a listed Agent keeps the spawn row only.
      const spawn = name === '@deepseek-ai/dsh-tool-subagent'
      if (spawn && allow !== undefined && (allow.has('agent') || allow.has('subagent')) && !deny.has('agent')) {
        // Claude Code's Agent tool has no model discovery: DSH 0.2.2's row registers `list_subagent_models` with it on.
        const config = row.config as Record<string, unknown> | undefined
        out.push(config?.['modelDiscovery'] === true ? { ...row, config: { ...config, modelDiscovery: false } } as PresetRow : row)
      }
      continue
    }
    if (HOST_ONLY_ROWS.has(name)) {
      if (allow === undefined) out.push(row)
      continue
    }
    const tools = TOOL_ROWS[name]
    if (tools === undefined) {
      out.push(row)
      continue
    }
    const kept = tools.filter(item => allowed(item.tool))
    if (kept.length === 0) continue
    // DSH's search row registers glob and grep together, with no switch: one listed alone gets a stand-in row.
    if (name === FS_SEARCH && kept.length < tools.length) {
      out.push({ ...row, name: FS_SEARCH_STAND_IN, config: { ...(row.config as Record<string, unknown> | undefined), tools: kept.map(item => item.tool) } } as PresetRow)
      continue
    }
    const flags = tools.filter(item => item.flag !== undefined)
    if (flags.length === 0 || kept.length === tools.length) {
      out.push(row)
      continue
    }
    const config = { ...(row.config as Record<string, unknown> | undefined) }
    for (const item of flags) config[item.flag!] = allowed(item.tool)
    out.push({ ...row, config } as PresetRow)
  }
  return out
}

/**
 * Register one agent as a preset built on the host's default preset.
 * @throws when the host composes no preset registry (headless and SDK profiles).
 */
export async function mountAgentPreset(ctx: Context, component: AgentComponent, pluginName: string): Promise<AgentMount> {
  const registry = dshService(ctx, 'agentPresets') as AgentPresetRegistry | undefined
  if (registry === undefined) throw new Error('this DSH profile composes no agent presets; agents run in the Web and Desktop profiles')
  if (component.body.trim().length === 0) throw new Error(`agent "${component.name}" has an empty prompt`)
  const base = await baseRows(registry)
  const tools = agentTools(component)
  // `memory` enables Read, Write and Edit for the memory files; `permissionMode: plan` is read-only.
  const memory = ['user', 'project', 'local'].includes(String(component.frontmatter['memory']))
  const planMode = component.frontmatter['permissionMode'] === 'plan'
  const listed = tools.allow === undefined ? undefined : [...new Set([...tools.allow, ...(memory ? ['read', 'write', 'edit'] : [])])]
  const denied = [...new Set([...tools.deny ?? [], ...(planMode ? ['write', 'edit'] : [])])]
  const allow = listed === undefined ? undefined : new Set(listed)
  const deny = new Set(denied)
  // `omitClaudeMd` starts the agent without the project instruction files.
  const rows = narrowRows(base, allow, deny).filter(row => !(component.frontmatter['omitClaudeMd'] === true && row.name === INSTRUCTIONS))
  const filter = { ...(listed !== undefined ? { allow: listed } : {}), ...(denied.length > 0 ? { deny: denied } : {}) }
  const plugins: PresetRow[] = [
    ...rows.map(row => row.name === PERSONA ? { ...row, config: { ...(row.config as object | undefined), prefix: component.body.trim() } } : row),
    ...(Object.keys(filter).length > 0 ? [{ id: 'harness-forge-tool-filter', name: TOOL_FILTER, config: filter }] : []),
  ]
  const presetId = agentPresetId(pluginName, component.name)
  const dispose = await registry.register({
    id: presetId,
    name: `${pluginName}:${component.name}`,
    description: component.description ?? `Agent ${component.name} from ${pluginName}`,
    order: 100,
    plugins,
  })
  return { presetId, dispose }
}

/** The default preset's rows, the base every generated preset starts from. */
export async function baseRows(registry: AgentPresetRegistry): Promise<PresetRow[]> {
  const document = await registry.readDocument(registry.defaultId)
  const rows = load(document.content, { schema: entryListSchema as never }) as PresetRow[] | undefined
  if (!Array.isArray(rows) || !rows.some(row => row.name === PERSONA)) {
    throw new Error(`default preset "${registry.defaultId}" has no persona row to replace`)
  }
  return rows
}

/**
 * The `agent` delegation tool: one `dsh-tool-subagent` instance whose
 * selectable presets are exactly the imported agents.
 *
 * A session's project agents get a tool of their own, mounted in that
 * agent's context: it shadows the global tool for the session and offers the
 * global agents too.
 */
export class AgentTool {
  private readonly presets = new Map<string, string>()
  private readonly scoped = new Set<AgentTool>()
  private holding = false
  private fiber: { update(config: unknown): void; await(): Promise<unknown>; dispose(): Promise<void> } | undefined

  /**
   * @param inherited - the global tool whose agents a session-scoped tool also offers.
   */
  constructor(private readonly ctx: Context, private readonly inherited?: AgentTool) {
    inherited?.scoped.add(this)
  }

  /** Offer one preset under its foreign name; returns the withdrawal. */
  add(presetId: string, foreignName: string): () => void {
    this.presets.set(presetId, foreignName)
    this.refresh()
    return () => {
      this.presets.delete(presetId)
      this.refresh()
    }
  }

  /** The foreign agent name of a preset (`plugin:agent`), for hook payloads. */
  foreignName(presetId: string): string | undefined {
    const own = this.presets.get(presetId)
    if (own !== undefined) return own
    for (const tool of this.scoped) {
      const name = tool.presets.get(presetId)
      if (name !== undefined) return name
    }
    return this.inherited?.foreignName(presetId)
  }

  /** The preset of a foreign agent name: `plugin:agent`, or the bare agent name when it is unique. */
  presetOf(foreignName: string): string | undefined {
    const all = [...this.presets, ...[...this.scoped].flatMap(tool => [...tool.presets])]
    const matches = all.filter(([, name]) => name === foreignName || name.split(':').at(-1) === foreignName)
    if (matches.length === 1) return matches[0]?.[0]
    return matches.find(([, name]) => name === foreignName)?.[0] ?? this.inherited?.presetOf(foreignName)
  }

  /** Wait until the tool offers its current agents (a config update restarts the tool). */
  async settled(): Promise<void> {
    await this.fiber?.await()
  }

  /**
   * Collect several `add` calls into one tool start. A tool mounted in an
   * agent's context does not take config updates (the preset owns its rows),
   * so a session's project agents are offered all at once.
   */
  hold(): void {
    this.holding = true
  }

  /** End a {@link hold}: the tool starts once with every agent added meanwhile. */
  resume(): void {
    if (!this.holding) return
    this.holding = false
    this.refresh()
  }

  async dispose(): Promise<void> {
    this.inherited?.scoped.delete(this)
    const fiber = this.fiber
    this.fiber = undefined
    await fiber?.dispose()
  }

  private refresh(): void {
    if (this.holding) return
    for (const tool of this.scoped) tool.refresh()
    // A session tool exists only while the session has agents of its own.
    const ids = this.presets.size === 0
      ? []
      : [...new Set([...this.inherited?.presets.keys() ?? [], ...this.presets.keys()])].sort((a, b) => a.localeCompare(b, 'en'))
    if (ids.length === 0) {
      const fiber = this.fiber
      this.fiber = undefined
      void fiber?.dispose()
      return
    }
    const config = { provider: 'spawn', toolName: AGENT_TOOL_NAME, allowedAgentPresets: ids }
    if (this.fiber === undefined) this.fiber = this.ctx.plugin(subagentTool as never, config as never) as never
    else this.fiber.update(config)
  }
}
