/**
 * A user's own Codex assets, outside any plugin, as one plugin
 * `codex:user` (`scope: "user"`):
 *
 * - skills of `$CODEX_HOME/skills/<name>/SKILL.md` (Codex's own `.system`
 *   skills stay with Codex), with their `agents/openai.yaml` metadata;
 * - custom prompts of `$CODEX_HOME/prompts/*.md`, invoked as `/prompts:<name>`;
 * - agent roles of `$CODEX_HOME/agents/*.toml` and `config.toml` `[agents.<name>]`
 *   (`spawn_agent`'s `agent_type`), as agents;
 * - the MCP servers of `config.toml` `[mcp_servers.*]`;
 * - the execution-policy rules of `$CODEX_HOME/rules/*.rules`
 *   (`prefix_rule(pattern=[...], decision=...)`) as permission rules;
 * - `notify`, the program Codex runs when a turn completes;
 * - `hooks.json`, Codex's hooks;
 * - the global instructions `AGENTS.override.md`, else `AGENTS.md`.
 * @module @kirkchinese/harness-forge-core
 */
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { childId, pluginId, shortHash, uniqueName } from '../../naming.js'
import { fingerprintPlugin } from '../../fingerprint.js'
import { parseSkillFrontmatter, readMarkdownAsset } from '../../frontmatter.js'
import { codexSkillPolicy } from './skill-policy.js'
import { isDirectory, isFile, isPlainObject, readText, stem, toPosix } from '../../paths.js'
import { settingsHooksComponent } from '../claude-code/user-assets.js'
import type { AgentComponent, CommandComponent, ForeignComponent, HookComponent, ForeignPlugin, McpComponent, OtherComponent, SettingsComponent, SkillComponent } from '../../types.js'

/** Where Codex keeps its configuration: `$CODEX_HOME`, else `~/.codex`. */
export function codexHome(home = homedir()): string {
  return process.env['CODEX_HOME'] ?? join(home, '.codex')
}

/** `config.toml`, parsed; empty when absent or unreadable. */
export function readCodexConfig(root: string): Record<string, unknown> {
  const text = readText(join(root, 'config.toml'))
  if (text === undefined) return {}
  try {
    return parseToml(text) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * The user's own Codex assets as one plugin.
 * @returns undefined when `$CODEX_HOME` holds nothing to bring over.
 */
export function scanCodexUserAssets(home = homedir()): ForeignPlugin | undefined {
  const root = codexHome(home)
  if (!isDirectory(root)) return undefined
  const id = pluginId('codex', 'user')
  const components: ForeignComponent[] = []
  const config = readCodexConfig(root)

  const usedSkills = new Set<string>()
  const skillsRoot = join(root, 'skills')
  for (const child of entries(skillsRoot)) {
    if (child.startsWith('.')) continue
    const bodyPath = join(skillsRoot, child, 'SKILL.md')
    const asset = isFile(bodyPath) ? readMarkdownAsset(bodyPath) : undefined
    if (asset === undefined) continue
    const policy = codexSkillPolicy(join(skillsRoot, child))
    const parsed = parseSkillFrontmatter(asset.data, child)
    const frontmatter = {
      ...parsed.frontmatter,
      ...(parsed.frontmatter.description.length === 0 && policy.description !== undefined ? { description: policy.description } : {}),
      ...(policy.implicit === false ? { modelInvocable: false } : {}),
    }
    const name = uniqueName(frontmatter.name, usedSkills, `${id}:${bodyPath}`)
    usedSkills.add(name)
    const skill: SkillComponent = {
      id: childId(id, 'skill', name),
      kind: 'skill',
      name,
      path: toPosix(join('skills', child, 'SKILL.md')),
      description: frontmatter.description,
      bodyPath,
      resourceBase: join(skillsRoot, child),
      frontmatter,
    }
    components.push(skill)
  }

  const usedCommands = new Set<string>()
  const promptsRoot = join(root, 'prompts')
  for (const file of entries(promptsRoot)) {
    if (!file.toLowerCase().endsWith('.md')) continue
    const path = join(promptsRoot, file)
    const asset = readMarkdownAsset(path)
    if (asset === undefined) continue
    const local = stem(file)
    const name = uniqueName(local, usedCommands, `${id}:${path}`)
    usedCommands.add(name)
    const command: CommandComponent = {
      id: childId(id, 'command', name),
      kind: 'command',
      name,
      path: toPosix(join('prompts', file)),
      description: typeof asset.data['description'] === 'string' ? asset.data['description'] : '',
      invocationName: `prompts:${local}`,
      syntax: 'codex',
      bodyPath: path,
      body: asset.body,
      frontmatter: asset.data,
    }
    components.push(command)
  }

  components.push(...codexAgentRoles(id, root, config))

  const servers = isPlainObject(config['mcp_servers']) ? config['mcp_servers'] : {}
  components.push(...codexMcpComponents(id, servers))

  const hooks = codexHooks(id, join(root, 'hooks.json'))
  if (hooks !== undefined) components.push(hooks)

  const rules = codexRules(join(root, 'rules'))
  if (rules.allow.length + rules.ask.length + rules.deny.length > 0) {
    const settings: SettingsComponent = {
      id: childId(id, 'settings', 'rules'),
      kind: 'settings',
      name: 'rules',
      path: 'rules',
      description: 'Codex execution-policy rules (prefix_rule)',
      files: rules.files,
      permissions: { allow: rules.allow, ask: rules.ask, deny: rules.deny },
      env: {},
    }
    components.push(settings)
  }

  const notify = Array.isArray(config['notify']) ? config['notify'].filter((item): item is string => typeof item === 'string') : []
  if (notify.length > 0) {
    const component: OtherComponent = {
      id: childId(id, 'other', 'notify'),
      kind: 'other',
      originalKind: 'codex-notify',
      name: 'notify',
      path: 'config.toml',
      description: `runs ${basename(notify[0] ?? '')} when a turn completes`,
    }
    components.push(component)
  }

  const instructions = [join(root, 'AGENTS.override.md'), join(root, 'AGENTS.md')].find(isFile)
  if (instructions !== undefined && (readText(instructions) ?? '').trim().length > 0) {
    const component: OtherComponent = {
      id: childId(id, 'other', 'agents-md'),
      kind: 'other',
      originalKind: 'codex-instructions',
      name: 'agents-md',
      path: basename(instructions),
      description: 'Codex global instructions',
    }
    components.push(component)
  }

  if (components.length === 0) return undefined
  const manifest = {
    name: 'user',
    scope: 'user',
    description: 'Codex user assets (~/.codex)',
    // Kept so that changes to them change the fingerprint.
    mcp_servers: servers,
    notify,
  }
  const plugin: ForeignPlugin = {
    id,
    source: 'codex',
    name: 'user',
    description: manifest.description,
    root,
    ref: { kind: 'codex', root, manifestPath: join(root, 'config.toml'), manifestKind: 'codex' },
    components,
    warnings: [],
    manifest,
  }
  return { ...plugin, fingerprint: fingerprintPlugin(plugin) }
}

/**
 * The Codex project assets of a session that starts in `cwd`, as one plugin
 * `codex:project-<hash>` (`scope: "project"`): each `.codex/` from the
 * project root (the nearest directory with `.git`) down to `cwd`, nearer
 * ones winning: `config.toml` MCP servers and `[agents]`, and
 * `agents/*.toml` roles. Skills of `.agents/skills` and `AGENTS.md` files
 * DSH loads itself.
 * @returns undefined when no `.codex/` brings anything.
 */
export function scanCodexProjectAssets(cwd: string, home = homedir()): ForeignPlugin | undefined {
  const start = resolve(cwd)
  const dirs: string[] = []
  for (let current = start; ; current = dirname(current)) {
    // `~/.codex` is the user's own configuration, not a project's.
    if (current.toLowerCase() === resolve(home).toLowerCase()) break
    dirs.unshift(current)
    if (isDirectory(join(current, '.git')) || isFile(join(current, '.git')) || dirname(current) === current) break
  }
  const name = `project-${shortHash(start.toLowerCase(), 8)}`
  const id = `codex:${name}`
  const servers: Record<string, unknown> = {}
  const roles = new Map<string, AgentComponent>()
  for (const dir of dirs) {
    const dotCodex = join(dir, '.codex')
    if (!isDirectory(dotCodex)) continue
    const config = readCodexConfig(dotCodex)
    if (isPlainObject(config['mcp_servers'])) Object.assign(servers, config['mcp_servers'])
    for (const role of codexAgentRoles(id, dotCodex, config)) roles.set(role.name, role)
  }
  // The nearest `.codex/hooks.json`'s hooks, run in the session's directory.
  const hooksFile = [...dirs].reverse().map(dir => join(dir, '.codex', 'hooks.json')).find(isFile)
  const hooks = hooksFile === undefined ? undefined : codexHooks(id, hooksFile)
  const components: ForeignComponent[] = [...codexMcpComponents(id, servers), ...roles.values(), ...(hooks !== undefined ? [hooks] : [])]
  if (components.length === 0) return undefined
  const manifest = { name, scope: 'project', projectRoot: start, description: `Codex project assets of ${start}`, mcp_servers: servers }
  const plugin: ForeignPlugin = {
    id,
    source: 'codex',
    name,
    description: manifest.description,
    root: start,
    ref: { kind: 'codex', root: start, manifestPath: join(start, '.codex', 'config.toml'), manifestKind: 'codex' },
    components,
    warnings: [],
    manifest,
  }
  return { ...plugin, fingerprint: fingerprintPlugin(plugin) }
}

/** Codex hooks (`hooks.json`, Codex's hook events and handlers) as a hooks component. */
export function codexHooks(pluginIdValue: string, file: string): HookComponent | undefined {
  const text = readText(file)
  if (text === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/u, ''))
  } catch {
    return undefined
  }
  return isPlainObject(parsed) ? settingsHooksComponent(pluginIdValue, file, parsed, 'hooks') : undefined
}

/**
 * Codex agent roles: each `agents/*.toml` file (a `name`, a `description`,
 * and the configuration the role runs with), and each `[agents.<name>]` of
 * `config.toml` (`description`, `config_file`). The role's
 * `developer_instructions` are its prompt; `model` and
 * `model_reasoning_effort` its model; a `read-only` sandbox makes it read-only.
 */
export function codexAgentRoles(pluginIdValue: string, root: string, config: Record<string, unknown>): AgentComponent[] {
  const roles = new Map<string, { file: string; table: Record<string, unknown>; description?: string }>()
  const read = (file: string): Record<string, unknown> | undefined => {
    const text = readText(file)
    if (text === undefined) return undefined
    try {
      const parsed = parseToml(text) as unknown
      return isPlainObject(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }
  for (const file of entries(join(root, 'agents'))) {
    if (!file.endsWith('.toml')) continue
    const path = join(root, 'agents', file)
    const table = read(path)
    const name = typeof table?.['name'] === 'string' ? table['name'].trim() : ''
    if (table === undefined || name.length === 0) continue
    roles.set(name, { file: path, table })
  }
  const declared = isPlainObject(config['agents']) ? config['agents'] : {}
  for (const [name, raw] of Object.entries(declared)) {
    if (!isPlainObject(raw)) continue
    const configFile = typeof raw['config_file'] === 'string' ? resolve(root, raw['config_file']) : undefined
    const table = configFile === undefined ? {} : read(configFile) ?? {}
    roles.set(name, { file: configFile ?? join(root, 'config.toml'), table, ...(typeof raw['description'] === 'string' ? { description: raw['description'] } : {}) })
  }
  const out: AgentComponent[] = []
  for (const [name, role] of roles) {
    const instructions = typeof role.table['developer_instructions'] === 'string' ? role.table['developer_instructions'] : ''
    const description = role.description ?? (typeof role.table['description'] === 'string' ? role.table['description'] : '')
    out.push({
      id: childId(pluginIdValue, 'agent', name),
      kind: 'agent',
      name,
      path: toPosix(role.file.startsWith(root) ? role.file.slice(root.length + 1) : role.file),
      description,
      bodyPath: role.file,
      body: instructions.length > 0 ? instructions : `You are the ${name} agent. ${description}`.trim(),
      frontmatter: {
        name,
        description,
        ...(typeof role.table['model'] === 'string' ? { model: role.table['model'] } : {}),
        ...(typeof role.table['model_reasoning_effort'] === 'string' ? { effort: role.table['model_reasoning_effort'] } : {}),
        ...(role.table['sandbox_mode'] === 'read-only' ? { permissionMode: 'plan' } : {}),
      },
    })
  }
  return out
}

/**
 * Codex's MCP servers (`[mcp_servers.<name>]`): `command`/`args`/`env`/
 * `env_vars`/`cwd` run a stdio server, `url` (with `bearer_token_env_var`,
 * `http_headers`, `env_http_headers`) a streamable-HTTP one; `enabled = false`
 * leaves a server out. Variables Codex passes through are referenced as
 * `${NAME}`, expanded when the server starts.
 */
export function codexMcpComponents(pluginIdValue: string, servers: Record<string, unknown>): McpComponent[] {
  const out: McpComponent[] = []
  for (const [name, raw] of Object.entries(servers)) {
    if (!isPlainObject(raw) || raw['enabled'] === false) continue
    const strings = (value: unknown): Record<string, string> => (isPlainObject(value)
      ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      : {})
    const command = typeof raw['command'] === 'string' ? raw['command'] : undefined
    const url = typeof raw['url'] === 'string' ? raw['url'] : undefined
    const args = Array.isArray(raw['args']) ? raw['args'].filter((arg): arg is string => typeof arg === 'string') : []
    const passed = Array.isArray(raw['env_vars']) ? raw['env_vars'].filter((item): item is string => typeof item === 'string') : []
    const env = { ...Object.fromEntries(passed.map(variable => [variable, `\${${variable}}`])), ...strings(raw['env']) }
    const headers = {
      ...strings(raw['http_headers']),
      ...Object.fromEntries(Object.entries(strings(raw['env_http_headers'])).map(([header, variable]) => [header, `\${${variable}}`])),
      ...(typeof raw['bearer_token_env_var'] === 'string' ? { Authorization: `Bearer \${${raw['bearer_token_env_var']}}` } : {}),
    }
    const transport: McpComponent['transport'] = command !== undefined ? 'stdio' : url !== undefined ? 'streamable-http' : 'unknown'
    out.push({
      id: childId(pluginIdValue, 'mcp', name),
      kind: 'mcp',
      name,
      description: `user-scope ${transport} MCP server`,
      transport,
      ...(command !== undefined ? { command } : {}),
      ...(args.length > 0 ? { args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(typeof raw['cwd'] === 'string' ? { cwd: raw['cwd'] } : {}),
      ...(url !== undefined ? { url } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    })
  }
  return out
}

/**
 * Codex execution-policy rules as permission rules: each
 * `prefix_rule(pattern=[...], decision="allow"|"prompt"|"forbidden")` is a
 * command prefix; a list inside the pattern is a set of alternatives.
 */
export function codexRules(dir: string): { files: string[]; allow: string[]; ask: string[]; deny: string[] } {
  const out = { files: [] as string[], allow: [] as string[], ask: [] as string[], deny: [] as string[] }
  for (const file of entries(dir)) {
    if (!file.endsWith('.rules')) continue
    const path = join(dir, file)
    const text = readText(path) ?? ''
    out.files.push(path)
    for (const call of text.matchAll(/prefix_rule\s*\(([\s\S]*?)\)\s*(?:\n|$)/gu)) {
      const body = call[1] ?? ''
      const at = /pattern\s*=\s*\[/u.exec(body)
      const pattern = at === null ? undefined : bracketed(body, at.index + at[0].length - 1)
      const decision = /decision\s*=\s*"(allow|prompt|forbidden)"/u.exec(body)?.[1] ?? 'allow'
      if (pattern === undefined) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(pattern)
      } catch {
        continue
      }
      if (!Array.isArray(parsed)) continue
      for (const prefix of expand(parsed)) {
        const rule = `Bash(${prefix}:*)`
        if (decision === 'forbidden') out.deny.push(rule)
        else if (decision === 'prompt') out.ask.push(rule)
        else out.allow.push(rule)
      }
    }
  }
  return out
}

/** The balanced `[...]` starting at `start` (brackets inside strings ignored). */
function bracketed(text: string, start: number): string | undefined {
  let depth = 0
  let quoted = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (char === '\\') index++
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === '[') depth++
    else if (char === ']' && --depth === 0) return text.slice(start, index + 1)
  }
  return undefined
}

/** Every command prefix a pattern with alternatives stands for. */
function expand(pattern: readonly unknown[]): string[] {
  let prefixes: string[][] = [[]]
  for (const token of pattern) {
    const choices = Array.isArray(token) ? token.filter((item): item is string => typeof item === 'string') : typeof token === 'string' ? [token] : []
    if (choices.length === 0) return []
    prefixes = prefixes.flatMap(prefix => choices.map(choice => [...prefix, choice]))
  }
  return prefixes.map(words => words.join(' '))
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir).sort((a, b) => a.localeCompare(b, 'en'))
  } catch {
    return []
  }
}
