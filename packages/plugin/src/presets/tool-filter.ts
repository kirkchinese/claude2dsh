/**
 * Tool-filter row mounted inside a generated agent preset. The preset's own
 * rows are already narrowed to the agent's `tools` (see `narrowRows`); this
 * row covers what rows cannot express: a tool a kept row registers but the
 * agent does not list, and the host's global tools (other plugins, MCP).
 * Visible global tools outside the list are hidden with `tools.restrict`; what
 * `restrict` cannot reach (a tool a kept row registers beside a listed one, a
 * tool another plugin registers on the agent itself, such as the capability
 * catalog's `skill`) is taken out of the agent's assembled tool list; and every
 * call outside the list is refused by a scoped `tools.guard`.
 *
 * MCP entries follow Claude Code: `mcp__server` names every tool of a server,
 * `mcp__server__*` too, `mcp__server__tool` one tool. A capability-catalog
 * call is judged as the MCP tool its id names.
 * @module @kirkchinese/harness-forge/preset-tool-filter
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'
import { CATALOG_CALL_TOOL, CATALOG_TOOLS, catalogToolName } from '../mcp/catalog.js'
import { onDsh } from '../dsh/host.js'

/** Tool names to allow and/or deny. */
export interface Config {
  allow?: string[]
  deny?: string[]
}

/** Schemastery validation for the filter row. */
export const Config = z.object({
  allow: z.array(z.string()),
  deny: z.array(z.string()),
}) as unknown as z<Config>

/** Cordis plugin name. */
export const name = 'harness-forge-tool-filter'

/** The filter needs the scoped tool registry. */
export const inject = ['tools']

const CATALOG = new Set<string>(CATALOG_TOOLS)

/** Whether an MCP entry of an agent's tool list names this MCP tool. */
export function mcpEntryMatches(entry: string, tool: string): boolean {
  const base = entry.endsWith('__*') ? entry.slice(0, -3) : entry
  return tool === base || tool.startsWith(`${base}__`)
}

/** Why a call is outside an agent's tool list, or undefined when it is inside. */
export function exclusion(config: Config, tool: string, args: unknown): string | undefined {
  const allow = config.allow
  const deny = config.deny ?? []
  const mcpAllow = (allow ?? []).filter(entry => entry.startsWith('mcp__'))
  const mcpDeny = deny.filter(entry => entry.startsWith('mcp__'))
  const refused = `${tool} is not available to this agent`
  if (CATALOG.has(tool)) {
    if (tool === CATALOG_CALL_TOOL) {
      const mcpName = catalogToolName((args as { id?: unknown } | undefined)?.id)
      if (mcpName !== undefined) {
        if (mcpDeny.some(entry => mcpEntryMatches(entry, mcpName))) return `${mcpName} is not available to this agent`
        if (allow !== undefined && !mcpAllow.some(entry => mcpEntryMatches(entry, mcpName))) return `${mcpName} is not available to this agent`
        return undefined
      }
    }
    return allow !== undefined && mcpAllow.length === 0 ? refused : undefined
  }
  if (tool.startsWith('mcp__')) {
    if (mcpDeny.some(entry => mcpEntryMatches(entry, tool))) return refused
    return allow !== undefined && !mcpAllow.some(entry => mcpEntryMatches(entry, tool)) ? refused : undefined
  }
  if (deny.includes(tool)) return refused
  return allow !== undefined && !allow.includes(tool) ? refused : undefined
}

/** Apply the restriction for the lifetime of the preset row. */
export function apply(ctx: Context, config: Config): void {
  if (config.allow === undefined && (config.deny ?? []).length === 0) return
  ctx.effect(() => ctx.tools.guard(execution => exclusion(config, execution.name, execution.arguments)), 'harness-forge.tool-guard')
  // A catalog meta-tool stays visible when any MCP tool is allowed; its calls are judged one by one.
  // `restrict` reaches global tools only; a tool a kept preset row registers beside a listed one
  // (`glob` beside `grep`) stays visible, and the guard refuses its calls. Global tools registered after
  // the preset started (a delegation tool, an MCP server that connected later) are hidden as they appear.
  const excluded = (tool: string): boolean => exclusion(config, tool, undefined) !== undefined && !(tool === CATALOG_CALL_TOOL && (config.allow ?? []).some(entry => entry.startsWith('mcp__')))
  const restricted = new Map<string, () => void>()
  let hiding = false
  const hide = (): void => {
    // Restricting changes the tools, which raises tools/change again: one pass at a time.
    if (hiding) return
    hiding = true
    try {
      hidePass()
    } finally {
      hiding = false
    }
  }
  const hidePass = (): void => {
    for (const tool of ctx.tools.schemas().map(schema => schema.name)) {
      if (restricted.has(tool)) continue
      if (!excluded(tool)) continue
      try {
        restricted.set(tool, ctx.tools.restrict({ deny: [tool] }))
      } catch {
        // A tool of this preset's own rows cannot be masked; the guard refuses its calls.
        restricted.set(tool, () => {})
      }
    }
  }
  hide()
  onDsh(ctx, 'tools/change', (() => { hide() }) as never)
  ctx.effect(() => () => { for (const dispose of restricted.values()) dispose() }, 'harness-forge.tool-filter')
}
