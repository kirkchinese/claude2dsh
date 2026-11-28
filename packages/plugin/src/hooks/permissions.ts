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
 * - Tool-specific specifiers (`WebFetch(domain:…)`) are read before
 *   parameter rules.
 * - Allow rules accept a tool-name glob only after a literal `mcp__<server>__`.
 * - A `/path` file rule anchors at the directory of the settings source that
 *   defines it; a rule without one anchors there at the working directory.
 * - Shell rules match the argv; a redirection's file is checked as Claude Code
 *   checks it (https://code.claude.com/docs/en/permissions#redirections): a
 *   file written needs an `Edit` allow rule and one read outside the working
 *   directory a `Read` allow rule, a target with `~`, a glob or an expansion is
 *   never approved, and `Edit`/`Read` deny rules deny the call.
 * @module @kirkchinese/harness-forge
 */
import { isAbsolute, relative, resolve } from 'node:path'
import { conditionMatches, isFileCall, realPathOf, redirectFiles, shellOf, type RedirectFile } from './condition.js'
import { Glob, wildcard } from './glob.js'
import { shellCommands } from './shell-commands.js'
import { isShellTool, type ForeignTool } from './vocabulary.js'

/** A rule in Claude Code's syntax, with the directory its `/path` file patterns anchor at (see `conditionMatches`). */
export type PermissionRule = string | { readonly rule: string; readonly root: string }

/** Rules in Claude Code's syntax. */
export interface PermissionRuleSet {
  readonly allow: readonly PermissionRule[]
  readonly deny: readonly PermissionRule[]
  readonly ask: readonly PermissionRule[]
}

/** The decision rules make for one call; undefined leaves it to the host. */
export type RuleVerdict = { readonly kind: 'deny' | 'ask' | 'allow'; readonly rule: string } | undefined

const PRIMARY_FIELDS = new Set(['command', 'file_path', 'path', 'notebook_path', 'url'])
/**
 * Specifier prefixes a tool reads itself, which are not input parameters
 * (https://code.claude.com/docs/en/permissions#webfetch). `Agent(Name)` and
 * `Skill(skill:…)` need no entry: a name has no colon, and `skill` is a parameter.
 */
const TOOL_SPECIFIERS: Readonly<Record<string, readonly string[]>> = { WebFetch: ['domain'] }

interface Rule {
  readonly text: string
  readonly root: string | undefined
}

function ruleOf(rule: PermissionRule): Rule {
  return typeof rule === 'string' ? { text: rule, root: undefined } : { text: rule.rule, root: rule.root }
}

/** Evaluate rules against one call. */
export function ruleVerdict(rules: PermissionRuleSet, tool: ForeignTool, cwd: string): RuleVerdict {
  const own = callVerdict(rules, tool, cwd)
  if (!isShellTool(tool.dshName)) return own
  const files = redirectionsOf(tool)
  // Each redirection target is the file call that would read or write it, with that call's own verdict.
  const parts = [own, ...(files ?? []).flatMap(file => fileToolsOf(file).map(call => targetVerdict(rules, file, call, cwd)))]
  for (const kind of ['deny', 'ask'] as const) {
    const found = parts.find(part => part?.kind === kind)
    if (found !== undefined) return found
  }
  // An unreadable command approves nothing; an allow needs every part allowed.
  return files !== undefined && parts.every(part => part?.kind === 'allow') ? own : undefined
}

/**
 * One call's verdict: deny, then ask, then allow. A file call's path is
 * allowed only when the path as spelled and its real path both are, each by
 * an allow rule or, with `insideApproves`, by lying inside the working
 * directory (the real path inside the real one); deny and ask rules match
 * either path (see `conditionMatches`).
 */
function callVerdict(rules: PermissionRuleSet, tool: ForeignTool, cwd: string, insideApproves = false): RuleVerdict {
  const deny = rules.deny.map(ruleOf).find(rule => restrictiveMatch(rule, tool, cwd))
  if (deny !== undefined) return { kind: 'deny', rule: deny.text }
  const ask = rules.ask.map(ruleOf).find(rule => restrictiveMatch(rule, tool, cwd))
  if (ask !== undefined) return { kind: 'ask', rule: ask.text }
  const allowRules = rules.allow.map(ruleOf)
  if (!isFileCall(tool)) {
    const allow = allowMatch(allowRules, tool, cwd)
    return allow === undefined ? undefined : { kind: 'allow', rule: allow.text }
  }
  const target = resolve(cwd, String(tool.input['file_path'] ?? tool.input['path']))
  const approved = (path: 'spelled' | 'real'): string | undefined => {
    const within = path === 'spelled' ? inside(cwd, target) : inside(realPathOf(resolve(cwd), cwd), realPathOf(target, cwd))
    return insideApproves && within ? INSIDE_WORKING_DIRECTORY : allowMatch(allowRules, tool, cwd, path)?.text
  }
  const asSpelled = approved('spelled')
  return asSpelled !== undefined && approved('real') !== undefined ? { kind: 'allow', rule: asSpelled } : undefined
}

/** Why a read inside the working directory is approved without a `Read` rule, as in Claude Code. */
const INSIDE_WORKING_DIRECTORY = 'a read inside the working directory'

/**
 * A redirection target's verdict, as the file call `call` would get it. A
 * target that is not plain (`~`, a glob, an expansion) is never approved; a
 * read inside the working directory needs no `Read` allow rule.
 */
function targetVerdict(rules: PermissionRuleSet, file: RedirectFile, call: ForeignTool, cwd: string): RuleVerdict {
  const verdict = callVerdict(rules, call, cwd, call.name === 'Read')
  return !file.plain && verdict?.kind === 'allow' ? undefined : verdict
}

/** Whether `path` lies in `directory`; a real path that cannot be known (undefined) lies nowhere. */
function inside(directory: string | undefined, path: string | undefined): boolean {
  if (directory === undefined || path === undefined) return false
  const rel = relative(directory, path)
  return !rel.startsWith('..') && !isAbsolute(rel)
}

/** The files a shell call's redirections read or write; undefined when its words cannot be read. */
function redirectionsOf(tool: ForeignTool): RedirectFile[] | undefined {
  const parsed = shellCommands(String(tool.input['command'] ?? ''), shellOf(tool))
  if (parsed === undefined) return undefined
  const files: RedirectFile[] = []
  for (const command of parsed.commands) {
    const found = redirectFiles(command, shellOf(tool))
    if (found === undefined) return undefined
    files.push(...found)
  }
  return files
}

/** The `Read` and `Write` calls that would read or write a redirection's file. */
function fileToolsOf(file: RedirectFile): ForeignTool[] {
  return [
    ...file.reads ? [{ dshName: 'read', name: 'Read', aliases: ['Read'], input: { file_path: file.path } }] : [],
    ...file.writes ? [{ dshName: 'write', name: 'Write', aliases: ['Write'], input: { file_path: file.path } }] : [],
  ]
}

function split(rule: string): { name: string; specifier: string | undefined } | undefined {
  const match = /^\s*([A-Za-z0-9_\-:.*]+?)\s*(?:\((.*)\))?\s*$/su.exec(rule)
  return match === null ? undefined : { name: match[1] ?? '', specifier: match[2] }
}

/** A deny or ask rule: tool-name globs, parameter rules, then the `if`-rule match. */
function restrictiveMatch({ text: rule, root }: Rule, tool: ForeignTool, cwd: string): boolean {
  const parts = split(rule)
  if (parts === undefined) return false
  const { name, specifier } = parts
  if (name.includes('*') && !name.startsWith('mcp__')) {
    // Over budget a restricting rule matches.
    if (!(globName(name).match(tool.name) ?? true) && !tool.aliases.some(alias => globName(name).match(alias) ?? true)) return false
    return specifier === undefined || specifier.trim() === '' || specifier.trim() === '*'
  }
  if (name.startsWith('mcp__') && name.includes('*')) {
    // `mcp__*`, `mcp__server__*`, `mcp__server__get_*`.
    return specifier === undefined && (globName(name).match(tool.name) ?? true)
  }
  const parameter = specifier === undefined ? undefined : /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/su.exec(specifier)
  const toolSpecific = parameter !== null && parameter !== undefined && TOOL_SPECIFIERS[name]?.includes(parameter[1] ?? '') === true
  if (parameter !== null && parameter !== undefined && !toolSpecific && !specifier!.trim().endsWith(':*')) {
    const key = parameter[1] ?? ''
    if (Object.hasOwn(tool.input, key) || !isShellTool(tool.dshName)) {
      if (PRIMARY_FIELDS.has(key)) return false
      if (!conditionMatches(name, tool, cwd, true, { root, restricts: true })) return false
      const value = tool.input[key]
      if (value === undefined || (typeof value === 'object' && value !== null)) return false
      return globName((parameter[2] ?? '').trimEnd()).match(String(value)) ?? true
    }
  }
  return conditionMatches(rule, tool, cwd, true, { root, restricts: true })
}

/** The allow rule that approves the call, if any; `path` picks the path a file rule matches (see `RuleUse.path`). */
function allowMatch(rules: readonly Rule[], tool: ForeignTool, cwd: string, path?: 'spelled' | 'real'): Rule | undefined {
  const usable = rules.filter(({ text: rule }) => {
    const parts = split(rule)
    if (parts === undefined) return false
    // An unanchored tool-name glob never auto-approves.
    if (parts.name.includes('*')) return /^mcp__[^*_][^*]*?__/u.test(parts.name)
    return true
  })
  if (usable.length === 0) return undefined
  if (isShellTool(tool.dshName)) {
    const whole = usable.find((rule) => {
      const parts = split(rule.text)!
      return (parts.specifier === undefined || parts.specifier.trim() === '*') && conditionMatches(parts.name, tool, cwd, false)
    })
    if (whole !== undefined) return whole
    const parsed = shellCommands(String(tool.input['command'] ?? ''), shellOf(tool))
    if (parsed === undefined || parsed.dynamic || parsed.commands.length === 0) return undefined
    let first: Rule | undefined
    for (const command of parsed.commands) {
      const single: ForeignTool = { ...tool, input: { ...tool.input, command } }
      const rule = usable.find(candidate => conditionMatches(candidate.text, single, cwd, false))
      if (rule === undefined) return undefined
      first ??= rule
    }
    return first
  }
  return usable.find(({ text: rule, root }) => {
    const parts = split(rule)!
    if (parts.name.startsWith('mcp__')) {
      // An MCP allow rule with a specifier matches no call.
      return parts.specifier === undefined && (parts.name.includes('*') ? globName(parts.name).match(tool.name) ?? false : conditionMatches(rule, tool, cwd, false))
    }
    return conditionMatches(rule, tool, cwd, false, { ...(root !== undefined ? { root } : {}), ...(path !== undefined ? { path } : {}) })
  })
}

function globName(pattern: string): Glob {
  return wildcard(pattern)
}
