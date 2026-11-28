/**
 * A server's own tool policy, from its configuration (Codex's
 * `enabled_tools`, `disabled_tools`, `default_tools_approval_mode` and
 * `tools.<tool>.approval_mode`): which of its tools may run and which ask the
 * user first. `@deepseek-ai/dsh-mcp-client` registers every tool a server
 * lists, so the MCP row enforces this when a call is made; the capability
 * catalog and remote servers also leave filtered tools out of the list.
 * @module @kirkchinese/harness-forge
 */
import type { McpComponent } from '@kirkchinese/harness-forge-core'
import { createHash } from 'node:crypto'

/** The longest public tool name, as `dsh-mcp-client` names tools. */
const MAX_PUBLIC_NAME_LENGTH = 64
/** Hex characters of the hash a normalized public tool name ends with, as `dsh-mcp-client` names tools. */
const HASH_LENGTH = 12

/**
 * How long one MCP tool call may run when the server's configuration does not
 * say (Codex `tool_timeout_sec`): long-running tools (builds, test runs) are
 * common, and the call can be cancelled like any other. Direct, catalog and
 * remote mounts all use it.
 */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 600_000

/** Same public naming contract as dsh-mcp-client: `mcp__<server>__<tool>`, normalized with a hash when needed. */
export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(/[^A-Za-z0-9_-]/gu, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

/** A mounted server's tool policy. */
export interface McpToolPolicy {
  /** Whether the raw tool may run at all. */
  runs(rawName: string): boolean
  /**
   * The raw name of a configured tool of this server, from the public name
   * `dsh-mcp-client` registers it under ({@link publicToolName}); undefined
   * for a tool the configuration does not name.
   */
  rawName(publicName: string): string | undefined
  /**
   * The decision for a call to one of this server's tools by its raw name
   * (undefined for a tool the configuration does not name): `deny` for a
   * filtered tool, `ask` for one that asks first, else undefined.
   * @param shownName - the tool as the reason names it.
   */
  decide(rawName: string | undefined, shownName: string): { readonly kind: 'deny' | 'ask'; readonly reason: string } | undefined
}

/** The policy of one server, or undefined when its configuration sets none. */
export function mcpToolPolicy(component: McpComponent, serverName: string): McpToolPolicy | undefined {
  const { enabledTools, disabledTools = [], toolApproval } = component
  if (enabledTools === undefined && disabledTools.length === 0 && toolApproval === undefined) return undefined
  const runs = (rawName: string): boolean => (enabledTools === undefined || enabledTools.includes(rawName)) && !disabledTools.includes(rawName)
  const configured = new Set([...enabledTools ?? [], ...disabledTools, ...Object.keys(toolApproval?.tools ?? {})])
  const byPublicName = new Map([...configured].map(tool => [publicToolName(serverName, tool), tool]))
  return {
    runs,
    rawName: publicName => byPublicName.get(publicName),
    decide(raw, toolName) {
      // A tool the configuration does not name is some other tool of the server: an allowlist refuses it.
      if (raw === undefined ? enabledTools !== undefined : !runs(raw)) {
        return { kind: 'deny', reason: `${toolName} is switched off by the configuration of MCP server "${component.name}" (enabled_tools / disabled_tools).` }
      }
      const own = raw !== undefined && toolApproval !== undefined && Object.hasOwn(toolApproval.tools, raw) ? toolApproval.tools[raw] : undefined
      const asks = own ?? toolApproval?.askByDefault === true
      return asks ? { kind: 'ask', reason: `MCP server "${component.name}" asks before running ${toolName} (approval_mode = "prompt").` } : undefined
    },
  }
}
