/**
 * A user's own Claude Code assets, outside any plugin: `~/.claude/skills`,
 * `agents`, `commands` and `output-styles`, the hooks, permission rules and
 * environment of `~/.claude/settings.json`, and the user-scope MCP servers of
 * `~/.claude.json`. They are read as one plugin, `claude-code:user`, whose
 * manifest carries `scope: "user"`: Claude Code names user commands, agents
 * and MCP servers without a plugin prefix, and so does DSH.
 *
 * Installed plugins come from `~/.claude/plugins/installed_plugins.json`,
 * the list Claude Code itself loads, with the enabled state from settings
 * resolved in Claude Code's precedence.
 * @module @kirkchinese/harness-forge-core
 */
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { scanPlugin } from '../../manifest.js'
import { childId, shortHash } from '../../naming.js'
import { fingerprintPlugin } from '../../fingerprint.js'
import { isDirectory, isFile, isPlainObject, LEADS_TO_SHARE, leadsToShare, readJsonObject, readJsonRecord, stringArrayField, stringField } from '../../paths.js'
import type { ForeignComponent, ForeignPlugin, HookComponent, McpComponent, PermissionRules, SettingsComponent } from '../../types.js'

/** One plugin Claude Code has installed, in one scope. */
export interface InstalledClaudePlugin {
  /** `name@marketplace`. */
  readonly key: string
  readonly name: string
  readonly marketplace: string
  readonly root: string
  readonly version?: string
  /** `user`, or `project` / `local` for an install that only one project's sessions load. */
  readonly scope: string
  /** The project a `project` or `local` install belongs to. */
  readonly projectPath?: string
  /** Whether Claude Code loads it where it applies: `enabledPlugins` resolved as Claude Code resolves it. */
  readonly enabled: boolean
  readonly gitCommitSha?: string
}

/**
 * The install scopes that bind a plugin to one project: Claude Code installs with `--scope project` or
 * `--scope local` record the project they were run in, and only that project's sessions load them
 * (https://code.claude.com/docs/en/plugins/loading#find-where-a-plugin-is-enabled).
 */
const PROJECT_SCOPES: ReadonlySet<string> = new Set(['project', 'local'])

/** Whether an install applies to every session (user scope), rather than to one project's. */
export function isGlobalClaudeInstall(plugin: Pick<InstalledClaudePlugin, 'scope' | 'projectPath'>): boolean {
  return !PROJECT_SCOPES.has(plugin.scope) && plugin.projectPath === undefined
}

/** What Claude Code records as installed, and how much of that could be read. */
export interface ClaudeInstalls {
  readonly plugins: readonly InstalledClaudePlugin[]
  /** Installs recorded with no install folder left on disk: still installed, not readable now. */
  readonly unresolved: ReadonlyArray<Pick<InstalledClaudePlugin, 'key' | 'scope' | 'projectPath'> & { readonly message: string }>
  /** What could not be read: `installed_plugins.json`, an entry of it, or a settings file that decides what is on. */
  readonly unread: readonly string[]
}

/**
 * The plugins Claude Code has installed, from `installed_plugins.json` (which records each install with its
 * `scope`, `installPath` and `version`, https://code.claude.com/docs/en/plugins/loading#check-which-stage-a-plugin-reached):
 * the newest existing install per plugin and scope (and project, for a project-bound scope). A user-scope
 * install never gives way to a newer one of another project. A missing index records nothing; one that does not
 * parse (Claude Code may be writing it) is `unread`, never "nothing installed".
 * @param managedDir - the system directory of Claude Code's managed settings (see {@link claudeManagedSettingsDir}).
 */
export function installedClaudePlugins(home = homedir(), managedDir = claudeManagedSettingsDir()): ClaudeInstalls {
  const unread: string[] = []
  const settingsOf = (path: string): Record<string, boolean> => {
    const read = readJsonRecord(path)
    if (read.problem !== undefined) unread.push(read.problem)
    return enabledPluginsOf(read.value)
  }
  const indexPath = join(home, '.claude', 'plugins', 'installed_plugins.json')
  const index = readJsonRecord(indexPath)
  if (index.problem !== undefined) unread.push(index.problem)
  const listed = index.value?.['plugins']
  if (listed !== undefined && !isPlainObject(listed)) unread.push(`${indexPath}: "plugins" is not an object`)
  const plugins = isPlainObject(listed) ? listed : {}
  const managed = managedEnabledPlugins(managedDir, unread)
  const user = settingsOf(join(home, '.claude', 'settings.json'))
  const out: InstalledClaudePlugin[] = []
  const unresolved: Array<Pick<InstalledClaudePlugin, 'key' | 'scope' | 'projectPath'> & { message: string }> = []
  for (const [key, entries] of Object.entries(plugins)) {
    if (!Array.isArray(entries)) {
      unread.push(`${indexPath}: the entry of ${key} is not a list`)
      continue
    }
    const newest = new Map<string, Record<string, unknown>>()
    const missing = new Map<string, { scope: string; projectPath?: string; path: string }>()
    for (const record of entries) {
      if (!isPlainObject(record) || typeof record['installPath'] !== 'string') {
        unread.push(`${indexPath}: an install of ${key} has no install folder`)
        continue
      }
      const scope = stringField(record, 'scope') ?? 'user'
      const project = PROJECT_SCOPES.has(scope) ? stringField(record, 'projectPath') : undefined
      const group = `${scope}\0${project === undefined ? '' : resolve(project)}`
      if (!isDirectory(record['installPath'])) {
        missing.set(group, { scope, ...(project !== undefined ? { projectPath: resolve(project) } : {}), path: record['installPath'] })
        continue
      }
      const known = newest.get(group)
      if (known === undefined || updatedAt(record).localeCompare(updatedAt(known)) > 0) newest.set(group, record)
    }
    for (const [group, gone] of missing) {
      if (!newest.has(group)) unresolved.push({ key, scope: gone.scope, ...(gone.projectPath !== undefined ? { projectPath: gone.projectPath } : {}), message: `Claude Code records ${key} at ${gone.path}, which is not there` })
    }
    const [name = key, marketplace = ''] = key.split('@')
    for (const record of newest.values()) {
      const scope = stringField(record, 'scope') ?? 'user'
      const projectPath = PROJECT_SCOPES.has(scope) ? stringField(record, 'projectPath') : undefined
      // Lowest precedence first: user, then the project's `settings.json` and `settings.local.json`, then managed. A
      // project's settings decide only that project's installs, which the global view leaves out: they cost no completeness.
      const layers = [user, ...(projectPath === undefined ? [] : ['settings.json', 'settings.local.json'].map(file => enabledPluginsOf(readJsonObject(join(projectPath, '.claude', file))))), managed]
      const version = stringField(record, 'version')
      const sha = stringField(record, 'gitCommitSha')
      out.push({
        key,
        name,
        marketplace,
        root: resolve(String(record['installPath'])),
        ...(version !== undefined ? { version } : {}),
        scope,
        ...(projectPath !== undefined ? { projectPath: resolve(projectPath) } : {}),
        enabled: resolveEnabled(key, layers),
        ...(sha !== undefined ? { gitCommitSha: sha } : {}),
      })
    }
  }
  out.sort((a, b) => a.key.localeCompare(b.key, 'en') || a.scope.localeCompare(b.scope, 'en') || (a.projectPath ?? '').localeCompare(b.projectPath ?? '', 'en'))
  return { plugins: out, unresolved, unread: [...new Set(unread)] }
}

function updatedAt(record: Record<string, unknown>): string {
  return String(record['lastUpdated'] ?? record['installedAt'] ?? '')
}

/**
 * Claude Code merges `enabledPlugins` key by key: the value from the highest-precedence source that mentions
 * the plugin applies (https://code.claude.com/docs/en/plugins/loading#find-where-a-plugin-is-enabled). An
 * installed plugin that no source mentions is on.
 * @param layers - lowest precedence first.
 */
function resolveEnabled(key: string, layers: ReadonlyArray<Readonly<Record<string, boolean>>>): boolean {
  let enabled = true
  for (const layer of layers) if (key in layer) enabled = layer[key]!
  return enabled
}

/** The `enabledPlugins` entries of one settings document. */
function enabledPluginsOf(settings: Record<string, unknown> | undefined): Record<string, boolean> {
  const value = settings?.['enabledPlugins']
  if (!isPlainObject(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'))
}

/**
 * The system directory of Claude Code's file-based managed settings
 * (https://code.claude.com/docs/en/managed-settings.md#where-each-mechanism-stores-the-policy). MDM profiles,
 * the registry and server-managed settings are not files Harness Forge can read.
 */
export function claudeManagedSettingsDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode'
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode'
  return '/etc/claude-code'
}

/**
 * `enabledPlugins` of the managed settings files: `managed-settings.json`, then `managed-settings.d/*.json` in name
 * order, later ones winning. What could not be read is added to `unread`.
 */
function managedEnabledPlugins(dir: string, unread: string[]): Record<string, boolean> {
  let drop: string[] = []
  const dropIns = join(dir, 'managed-settings.d')
  // A drop-in folder on a link to a network share it is not on cannot be listed (see `leadsToShare`).
  if (leadsToShare(dropIns)) unread.push(`${dropIns} could not be listed (${LEADS_TO_SHARE})`)
  else try {
    drop = readdirSync(dropIns).filter(file => file.endsWith('.json') && !file.startsWith('.')).sort()
  } catch (error: unknown) {
    // No drop-in directory is none to read; one that cannot be listed is not.
    const code = (error as { code?: unknown }).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') unread.push(`${join(dir, 'managed-settings.d')} could not be listed (${error instanceof Error ? error.message : String(error)})`)
  }
  const files = [join(dir, 'managed-settings.json'), ...drop.map(file => join(dir, 'managed-settings.d', file))]
  return Object.assign({}, ...files.map((file) => {
    const read = readJsonRecord(file)
    if (read.problem !== undefined) unread.push(read.problem)
    return enabledPluginsOf(read.value)
  })) as Record<string, boolean>
}

/**
 * The user's own Claude Code assets as one plugin.
 * @returns undefined when `~/.claude` holds nothing to bring over.
 */
export function scanClaudeUserAssets(home = homedir()): ForeignPlugin | undefined {
  const root = join(home, '.claude')
  if (!isDirectory(root)) return undefined
  const base = scanPlugin(root, { source: 'claude-code', name: 'user' }).plugin
  // The scanner reads plugin layout; a user directory has no plugin hooks
  // file or plugin MCP map, so only the user-level parts are kept.
  const components: ForeignComponent[] = base.components.filter(component => ['skill', 'command', 'agent', 'ui'].includes(component.kind))
  const settingsPath = join(root, 'settings.json')
  const settings = readJsonObject(settingsPath) ?? {}
  const settingsComponent = claudeSettingsComponent(base.id, [settingsPath], [settings], root)
  if (settingsComponent !== undefined) components.push(settingsComponent)
  const hooks = settingsHooksComponent(base.id, settingsPath, settings)
  if (hooks !== undefined) components.push(hooks)
  // The user's status line (`statusLine`): DSH draws none of its own, so it is a surface to port.
  const statusLine = settings['statusLine']
  if (isPlainObject(statusLine) && typeof statusLine['command'] === 'string') {
    components.push({
      id: childId(base.id, 'ui', 'statusline-settings'),
      kind: 'ui',
      name: 'statusline-settings',
      surface: 'statusline',
      path: 'settings.json',
      specPath: settingsPath,
      description: `status line: ${statusLine['command']}`,
      metadata: { statusLine },
    })
  }
  const claudeJson = readJsonObject(join(home, '.claude.json'))
  const mcpServers = isPlainObject(claudeJson?.['mcpServers']) ? claudeJson['mcpServers'] : {}
  components.push(...mcpComponents(base.id, mcpServers, 'user'))
  if (components.length === 0) return undefined
  const manifest = {
    name: 'user',
    scope: 'user',
    description: 'Claude Code user assets (~/.claude)',
    // The MCP map is kept in the manifest so its changes change the
    // fingerprint; the rest of ~/.claude.json changes on every run.
    mcpServers,
  }
  const plugin: ForeignPlugin = {
    ...base,
    description: manifest.description,
    components,
    manifest,
    ref: { ...base.ref, manifestPath: settingsPath, manifestKind: 'claude-code' },
  }
  return { ...plugin, fingerprint: fingerprintPlugin(plugin) }
}

/**
 * The Claude Code project assets of a session that starts in `cwd`, as one
 * plugin `claude-code:project-<hash>` whose manifest carries
 * `scope: "project"`:
 *
 * - skills, commands, agents and output styles from `.claude/` in `cwd` and
 *   each parent directory below the home directory, nearest first;
 * - hooks, permission rules and `env` from `cwd/.claude/settings.json` and
 *   `settings.local.json` (no parent fallback, as in Claude Code);
 * - project MCP servers from `cwd/.mcp.json` and local ones from
 *   `~/.claude.json` `projects[cwd].mcpServers`, local winning.
 *
 * In the home directory itself `.claude/` is the user's assets, so only the
 * MCP servers count there.
 * @returns undefined when the directory has no Claude Code project assets.
 */
export function scanClaudeProjectAssets(cwd: string, home = homedir()): ForeignPlugin | undefined {
  const root = resolve(cwd)
  const atHome = samePath(root, home)
  const name = `project-${shortHash(root.toLowerCase(), 8)}`
  const pluginId = `claude-code:${name}`
  const components: ForeignComponent[] = []
  const seen = new Set<string>()
  if (!atHome) {
    for (const directory of ancestorsBelowHome(root, home)) {
      const dotClaude = join(directory, '.claude')
      if (!isDirectory(dotClaude)) continue
      const scanned = scanPlugin(dotClaude, { source: 'claude-code', name }).plugin
      for (const component of scanned.components) {
        if (!['skill', 'command', 'agent', 'ui'].includes(component.kind)) continue
        const key = `${component.kind}:${component.name}`
        if (seen.has(key)) continue
        seen.add(key)
        components.push(component)
      }
    }
    const settingsFiles = ['settings.json', 'settings.local.json'].map(file => join(root, '.claude', file)).filter(isFile)
    const settingsValues = settingsFiles.map(file => readJsonObject(file) ?? {})
    const settings = claudeSettingsComponent(pluginId, settingsFiles, settingsValues, root)
    if (settings !== undefined) components.push(settings)
    for (const [index, file] of settingsFiles.entries()) {
      const hooks = settingsHooksComponent(pluginId, file, settingsValues[index] ?? {}, index === 0 ? 'settings' : 'settings-local')
      if (hooks !== undefined) components.push(hooks)
    }
  }
  const projectMap = readJsonObject(join(root, '.mcp.json'))
  const projectServers = isPlainObject(projectMap?.['mcpServers']) ? projectMap['mcpServers'] : {}
  const claudeJson = readJsonObject(join(home, '.claude.json'))
  const projects = isPlainObject(claudeJson?.['projects']) ? claudeJson['projects'] : {}
  const entry = Object.entries(projects).find(([path]) => samePath(path, root))?.[1]
  const localServers = isPlainObject(entry) && isPlainObject(entry['mcpServers']) ? entry['mcpServers'] : {}
  const local = mcpComponents(pluginId, localServers, 'local')
  const localNames = new Set(local.map(component => component.name))
  components.push(...mcpComponents(pluginId, projectServers, 'project').filter(component => !localNames.has(component.name)), ...local)
  if (components.length === 0) return undefined
  const manifest = { name, scope: 'project', projectRoot: root, description: `Claude Code project assets of ${root}`, mcpServers: { ...projectServers, ...localServers } }
  const plugin: ForeignPlugin = {
    id: pluginId,
    name,
    source: 'claude-code',
    root,
    description: manifest.description,
    components,
    warnings: [],
    manifest,
    ref: { kind: 'claude-code', root, manifestPath: join(root, '.claude', 'settings.json'), manifestKind: 'claude-code' },
  }
  return { ...plugin, fingerprint: fingerprintPlugin(plugin) }
}

/** `dir`, then each parent, stopping below the home directory and at the filesystem root. */
function ancestorsBelowHome(dir: string, home: string): string[] {
  const out: string[] = []
  let current = resolve(dir)
  for (;;) {
    if (samePath(current, home)) break
    out.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return out
}

function samePath(left: string, right: string): boolean {
  const normalize = (path: string): string => {
    const value = resolve(path).replace(/[\\/]+$/u, '')
    return process.platform === 'win32' ? value.toLowerCase() : value
  }
  return normalize(left) === normalize(right)
}

/**
 * The permission rules and environment of one or more settings files, merged in order.
 * @param ruleRoot - where the files' `/path` file rules anchor (see `SettingsComponent.ruleRoot`).
 */
export function claudeSettingsComponent(pluginId: string, files: readonly string[], values: readonly Record<string, unknown>[], ruleRoot: string): SettingsComponent | undefined {
  const permissions: { allow: string[]; deny: string[]; ask: string[] } = { allow: [], deny: [], ask: [] }
  const env: Record<string, string> = {}
  let disableAllHooks: boolean | undefined
  let outputStyle: string | undefined
  for (const value of values) {
    const rules = isPlainObject(value['permissions']) ? value['permissions'] : {}
    for (const key of ['allow', 'deny', 'ask'] as const) permissions[key].push(...stringArrayField(rules, key))
    if (isPlainObject(value['env'])) {
      for (const [key, item] of Object.entries(value['env'])) if (typeof item === 'string') env[key] = item
    }
    if (typeof value['disableAllHooks'] === 'boolean') disableAllHooks = value['disableAllHooks']
    const style = stringField(value, 'outputStyle')
    if (style !== undefined) outputStyle = style
  }
  const ruleCount = permissions.allow.length + permissions.deny.length + permissions.ask.length
  if (ruleCount === 0 && Object.keys(env).length === 0 && disableAllHooks === undefined && outputStyle === undefined) return undefined
  const dedupe = (rules: string[]): string[] => [...new Set(rules)]
  const merged: PermissionRules = { allow: dedupe(permissions.allow), deny: dedupe(permissions.deny), ask: dedupe(permissions.ask) }
  return {
    id: childId(pluginId, 'settings', 'settings'),
    kind: 'settings',
    name: 'settings',
    description: `${String(ruleCount)} permission rule(s), ${String(Object.keys(env).length)} environment variable(s)`,
    files: files.filter(isFile),
    permissions: merged,
    ruleRoot,
    env,
    ...(disableAllHooks !== undefined ? { disableAllHooks } : {}),
    ...(outputStyle !== undefined ? { outputStyle } : {}),
  }
}

/** The `hooks` of a settings file as an inline hooks component. */
export function settingsHooksComponent(pluginId: string, path: string, settings: Record<string, unknown>, name = 'settings'): HookComponent | undefined {
  const hooks = settings['hooks']
  if (!isPlainObject(hooks)) return undefined
  const events = Object.keys(hooks).filter(event => Array.isArray(hooks[event]))
  if (events.length === 0) return undefined
  const handlerTypes = new Set<string>()
  for (const event of events) {
    for (const group of hooks[event] as unknown[]) {
      if (!isPlainObject(group) || !Array.isArray(group['hooks'])) continue
      for (const handler of group['hooks']) if (isPlainObject(handler) && typeof handler['type'] === 'string') handlerTypes.add(handler['type'])
    }
  }
  return {
    id: childId(pluginId, 'hooks', name),
    kind: 'hooks',
    name,
    configPath: '',
    inline: { hooks },
    events: events.sort(),
    handlerTypes: [...handlerTypes].sort(),
    modules: [],
    description: `hooks from ${path}`,
    metadata: { origin: 'settings', file: path },
  }
}

/** MCP servers of a user or project map, named as Claude Code names them. */
export function mcpComponents(pluginId: string, servers: Record<string, unknown>, scope: 'user' | 'project' | 'local'): McpComponent[] {
  const out: McpComponent[] = []
  for (const [name, raw] of Object.entries(servers)) {
    if (!isPlainObject(raw)) continue
    const declared = stringField(raw, 'type') ?? stringField(raw, 'transport')
    const transport: McpComponent['transport'] = declared === 'stdio' || declared === 'sse' ? declared
      : declared === 'http' || declared === 'streamable-http' ? 'streamable-http'
        : stringField(raw, 'command') !== undefined ? 'stdio'
          : stringField(raw, 'url') !== undefined ? 'streamable-http' : 'unknown'
    const strings = (value: unknown): Readonly<Record<string, string>> | undefined => {
      if (!isPlainObject(value)) return undefined
      const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      return entries.length > 0 ? Object.fromEntries(entries) : undefined
    }
    const command = stringField(raw, 'command')
    const url = stringField(raw, 'url')
    const args = stringArrayField(raw, 'args')
    const env = strings(raw['env'])
    const headers = strings(raw['headers'])
    const cwd = stringField(raw, 'cwd')
    out.push({
      id: childId(pluginId, 'mcp', name),
      kind: 'mcp',
      name,
      declaredName: name,
      description: `${scope}-scope ${transport} MCP server`,
      transport,
      ...(command !== undefined ? { command } : {}),
      ...(args.length > 0 ? { args } : {}),
      ...(env !== undefined ? { env } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(url !== undefined ? { url } : {}),
      ...(headers !== undefined ? { headers } : {}),
      metadata: { scope },
    })
  }
  return out
}
