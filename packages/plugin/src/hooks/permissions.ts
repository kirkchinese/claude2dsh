/**
 * Claude Code permission rules (`permissions.allow` / `ask` / `deny` in
 * settings) evaluated against one tool call, as Claude Code evaluates them:
 * deny, then ask, then allow; the first match decides and rule specificity
 * does not change the order.
 *
 * - A shell call matches a deny or ask rule when any subcommand matches; it
 *   matches allow only when every subcommand matches an allow rule.
 * - Deny and ask rules may name a top-level input parameter,
 *   `Tool(param:value)` with `*` wildcards; an omitted parameter never matches.
 *   A tool's primary content field cannot be matched this way.
 * - Allow rules accept a tool-name glob only after a literal `mcp__<server>__`.
 * @module @kirkchinese/harness-forge
 */
import { conditionMatches } from './condition.js'
import { shellCommands } from './shell-commands.js'
import { isShellTool, type ForeignTool } from './vocabulary.js'

/** Rules in Claude Code's syntax. */
export interface PermissionRuleSet {
  readonly allow: readonly string[]
  readonly deny: readonly string[]
  readonly ask: readonly string[]
}

/** The decision rules make for one call; undefined leaves it to the host. */
export type RuleVerdict = { readonly kind: 'deny' | 'ask' | 'allow'; readonly rule: string } | undefined

const PRIMARY_FIELDS = new Set(['command', 'file_path', 'path', 'notebook_path', 'url'])

/** Evaluate rules against one call. */
export function ruleVerdict(rules: PermissionRuleSet, tool: ForeignTool, cwd: string): RuleVerdict {
  const deny = rules.deny.find(rule => restrictiveMatch(rule, tool, cwd))
  if (deny !== undefined) return { kind: 'deny', rule: deny }
  const ask = rules.ask.find(rule => restrictiveMatch(rule, tool, cwd))
  if (ask !== undefined) return { kind: 'ask', rule: ask }
  const allow = allowMatch(rules.allow, tool, cwd)
  return allow === undefined ? undefined : { kind: 'allow', rule: allow }
}

function split(rule: string): { name: string; specifier: string | undefined } | undefined {
  const match = /^\s*([A-Za-z0-9_\-:.*]+?)\s*(?:\((.*)\))?\s*$/su.exec(rule)
  return match === null ? undefined : { name: match[1] ?? '', specifier: match[2] }
}

/** A deny or ask rule: tool-name globs, parameter rules, then the `if`-rule match. */
function restrictiveMatch(rule: string, tool: ForeignTool, cwd: string): boolean {
  const parts = split(rule)
  if (parts === undefined) return false
  const { name, specifier } = parts
  if (name.includes('*') && !name.startsWith('mcp__')) {
    if (!globName(name).test(tool.name) && !tool.aliases.some(alias => globName(name).test(alias))) return false
    return specifier === undefined || specifier.trim() === '' || specifier.trim() === '*'
  }
  if (name.startsWith('mcp__') && name.includes('*')) {
    // `mcp__*`, `mcp__server__*`, `mcp__server__get_*`.
    return specifier === undefined && globName(name).test(tool.name)
  }
  const parameter = specifier === undefined ? undefined : /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*?)\s*$/su.exec(specifier)
  if (parameter !== null && parameter !== undefined && !specifier!.trim().endsWith(':*')) {
    const key = parameter[1] ?? ''
    if (Object.hasOwn(tool.input, key) || !isShellTool(tool.dshName)) {
      if (PRIMARY_FIELDS.has(key)) return false
      if (!conditionMatches(name, tool, cwd)) return false
      const value = tool.input[key]
      if (value === undefined || (typeof value === 'object' && value !== null)) return false
      return globName(parameter[2] ?? '').test(String(value))
    }
  }
  return conditionMatches(rule, tool, cwd)
}

/** The allow rule that approves the call, if any. */
function allowMatch(rules: readonly string[], tool: ForeignTool, cwd: string): string | undefined {
  const usable = rules.filter((rule) => {
    const parts = split(rule)
    if (parts === undefined) return false
    // An unanchored tool-name glob never auto-approves.
    if (parts.name.includes('*')) return /^mcp__[^*_][^*]*?__/u.test(parts.name)
    return true
  })
  if (usable.length === 0) return undefined
  if (isShellTool(tool.dshName)) {
    const whole = usable.find((rule) => {
      const parts = split(rule)!
      return (parts.specifier === undefined || parts.specifier.trim() === '*') && conditionMatches(parts.name, tool, cwd)
    })
    if (whole !== undefined) return whole
    const parsed = shellCommands(String(tool.input['command'] ?? ''))
    if (parsed === undefined || parsed.dynamic || parsed.commands.length === 0) return undefined
    let first: string | undefined
    for (const command of parsed.commands) {
      const single: ForeignTool = { ...tool, input: { ...tool.input, command } }
      const rule = usable.find(candidate => conditionMatches(candidate, single, cwd))
      if (rule === undefined) return undefined
      first ??= rule
    }
    return first
  }
  return usable.find((rule) => {
    const parts = split(rule)!
    if (parts.name.startsWith('mcp__')) {
      // An MCP allow rule with a specifier matches no call.
      return parts.specifier === undefined && (parts.name.includes('*') ? globName(parts.name).test(tool.name) : conditionMatches(rule, tool, cwd))
    }
    return conditionMatches(rule, tool, cwd)
  })
}

function globName(pattern: string): RegExp {
  return new RegExp(`^${pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&')).join('.*')}$`, 'su')
}
