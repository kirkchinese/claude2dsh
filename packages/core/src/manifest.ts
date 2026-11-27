/**
 * Read-only plugin scanner for the portable Agent Plugins format and the
 * Claude Code / Codex dialects. It never executes a foreign file and never
 * writes to the plugin root.
 * @module @kirkchinese/harness-forge-core
 */
import { readdirSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import {
  booleanValue,
  parseSkillFrontmatter,
  readMarkdownAsset,
  toolList,
  type MarkdownAsset,
} from './frontmatter.js'
import { childId, kebabCase, pluginId, uniqueName } from './naming.js'
import { fingerprintPlugin } from './fingerprint.js'
import { detectLicense } from './license.js'
import { codexSkillPolicy } from './dialects/codex/skill-policy.js'
import { usesAgentMcpSchema, usesAgentPluginSchema, validateAgentMcp, validateAgentPlugin } from './schema.js'
import {
  childDirectories,
  isDirectory,
  isFile,
  isInside,
  isPlainObject,
  readJsonObject,
  readText,
  realOrLexical,
  resolveInside,
  stem,
  stringArrayField,
  stringField,
  toPosix,
} from './paths.js'
import type {
  AgentComponent,
  CodeComponent,
  CommandComponent,
  ComponentKind,
  ForeignComponent,
  ForeignPlugin,
  HookComponent,
  ManifestKind,
  McpComponent,
  PluginWarning,
  SkillComponent,
  SourceId,
  SourceRef,
  UiComponent,
} from './types.js'

const AGENT_PLUGINS_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'

/** A manifest discovered at a plugin root. */
export interface DetectedManifest {
  readonly kind: ManifestKind
  readonly path: string
  readonly data: Record<string, unknown>
  /** A manifest file that is there but is not a JSON object: the plugin cannot be read as its author meant. */
  readonly invalid?: string
}

/** Options for {@link scanPlugin}. */
export interface ScanOptions {
  /** The connector that requested the scan; used for ids and provenance. */
  readonly source: SourceId
  /** Marketplace identity to attach to the source ref. */
  readonly market?: SourceRef['market']
  /** Explicit manifest path; otherwise auto-detected. */
  readonly manifestPath?: string
  /** Plugin name to use instead of the manifest's (user and project asset sets). */
  readonly name?: string
  /** A manifest a dialect builds for a folder that has none on disk, used instead of detection. */
  readonly manifest?: { readonly kind: ManifestKind; readonly data: Record<string, unknown> }
}

/** The result of a scan, including non-fatal warnings. */
export interface ScanResult {
  readonly plugin: ForeignPlugin
}

/** Detect the manifest convention at a plugin root. */
export function detectManifest(root: string, explicitPath?: string, source?: SourceId): DetectedManifest | undefined {
  const defaultCandidates: Array<{ path: string; kind: ManifestKind }> = source === 'claude-code'
    ? [
        { path: join(root, '.claude-plugin', 'plugin.json'), kind: 'claude-code' },
        { path: join(root, 'plugin.json'), kind: 'agent-plugins' },
        { path: join(root, 'package.json'), kind: 'package' },
      ]
    : source === 'codex'
      ? [
          { path: join(root, 'plugin.json'), kind: 'agent-plugins' },
          { path: join(root, '.codex-plugin', 'plugin.json'), kind: 'codex' },
          { path: join(root, 'package.json'), kind: 'package' },
        ]
      : source === 'opencode'
        ? [
            { path: join(root, 'opencode.json'), kind: 'opencode' },
            { path: join(root, 'opencode.jsonc'), kind: 'opencode' },
            { path: join(root, 'package.json'), kind: 'package' },
          ]
        : [
            { path: join(root, 'plugin.json'), kind: 'agent-plugins' },
            { path: join(root, '.codex-plugin', 'plugin.json'), kind: 'codex' },
            { path: join(root, '.claude-plugin', 'plugin.json'), kind: 'claude-code' },
            { path: join(root, 'opencode.json'), kind: 'opencode' },
            { path: join(root, 'opencode.jsonc'), kind: 'opencode' },
            { path: join(root, 'package.json'), kind: 'package' },
          ]
  const candidates: Array<{ path: string; kind: ManifestKind }> = explicitPath === undefined
    ? defaultCandidates
    : [{
        path: explicitPath,
        kind: explicitPath.includes('.claude-plugin') ? 'claude-code'
          : explicitPath.includes('.codex-plugin') ? 'codex'
            : explicitPath.endsWith('.jsonc') ? 'opencode' : 'unknown',
      }]
  let invalid: string | undefined
  for (const candidate of candidates) {
    if (!isFile(candidate.path)) continue
    if (candidate.path.endsWith('.jsonc')) {
      // JSONC is not parsed here; the OpenCode connector owns comment handling.
      return { kind: 'opencode', path: candidate.path, data: {} }
    }
    const data = readJsonObject(candidate.path)
    if (data === undefined) {
      // package.json is only a fallback; a broken plugin manifest is the author's mistake to report.
      if (candidate.kind !== 'package') invalid ??= candidate.path
      continue
    }
    const kind = candidate.kind === 'agent-plugins'
      ? classifyPortableManifest(data)
      : candidate.kind === 'unknown' && candidate.path.endsWith('plugin.json')
        ? classifyPortableManifest(data)
        : candidate.kind
    // A valid fallback (package.json, a portable root manifest) does not hide a broken plugin manifest before it.
    return { kind, path: candidate.path, data, ...(invalid !== undefined ? { invalid } : {}) }
  }
  // A Claude plugin may omit plugin.json and rely on the standard layout.
  if (source !== 'codex' && source !== 'opencode' && looksLikeClaudeLayout(root)) {
    return { kind: 'claude-code', path: join(root, '.claude-plugin', 'plugin.json'), data: {}, ...(invalid !== undefined ? { invalid } : {}) }
  }
  return invalid === undefined ? undefined : { kind: 'unknown', path: invalid, data: {}, invalid }
}

function classifyPortableManifest(data: Record<string, unknown>): ManifestKind {
  const schema = stringField(data, '$schema')
  if (schema === AGENT_PLUGINS_SCHEMA) return 'agent-plugins'
  // Codex accepts the portable schema; a root plugin.json without a recognized
  // schema is reported as unknown rather than silently treated as portable.
  if (schema !== undefined && schema.includes('agent-plugins.org')) return 'agent-plugins'
  return 'unknown'
}

function looksLikeClaudeLayout(root: string): boolean {
  return hasLayoutDirectory(root, ['skills', 'commands', 'agents', 'hooks', 'output-styles', 'workflows']) || isFile(join(root, '.mcp.json'))
}

/**
 * Whether `root` holds one of the named plugin-layout directories. A directory
 * that is itself a skill (it has a `SKILL.md`) is a skill folder that happens
 * to be called `agents` or `hooks`, not a layout directory.
 */
export function hasLayoutDirectory(root: string, names: readonly string[]): boolean {
  return names.some(name => isDirectory(join(root, name)) && !isFile(join(root, name, 'SKILL.md')))
}

/**
 * Scan one plugin directory. The scan is read-only and tolerant: a malformed
 * component produces a warning, not a thrown error.
 * @param root - absolute plugin root.
 * @param options - connector identity and optional marketplace facts.
 * @returns a fully populated {@link ForeignPlugin}.
 */
export function scanPlugin(root: string, options: ScanOptions): ScanResult {
  const warnings: PluginWarning[] = []
  const detected: DetectedManifest | undefined = options.manifest !== undefined
    ? { kind: options.manifest.kind, path: root, data: options.manifest.data }
    : detectManifest(root, options.manifestPath, options.source)
  let manifest = detected?.data ?? {}
  let manifestKind = detected?.kind ?? 'unknown'
  // Codex can combine a portable root plugin.json with a .codex-plugin
  // overlay. Only the Codex dialect merges it; a Claude scan must not be
  // shadowed by a co-located Codex overlay.
  const overlay = options.source === 'codex' || manifestKind === 'codex'
    ? readJsonObject(join(root, '.codex-plugin', 'plugin.json'))
    : undefined
  if (overlay !== undefined) {
    manifest = {
      ...manifest,
      ...overlay,
      skills: overlay['skills'] ?? manifest['skills'],
      mcpServers: overlay['mcpServers'] ?? manifest['mcpServers'],
      hooks: overlay['hooks'] ?? manifest['hooks'],
    }
    manifestKind = 'codex'
  }
  const rawName = options.name ?? stringField(manifest, 'name') ?? basename(root)
  const name = kebabCase(rawName)
  const id = pluginId(options.source, name)
  const components: ForeignComponent[] = []
  const usedSkillNames = new Set<string>()
  const usedCommandNames = new Set<string>()
  const usedAgentNames = new Set<string>()

  const push = (component: ForeignComponent): void => {
    components.push(component)
  }
  const warn = (code: string, message: string, extra: Partial<PluginWarning> = {}): void => {
    warnings.push({ code, message, ...extra })
  }
  if (detected?.invalid !== undefined) warn('manifest-invalid', `${toPosix(relative(root, detected.invalid))} is not valid JSON`, { path: toPosix(relative(root, detected.invalid)) })
  // A manifest that names a schema nobody here knows is not a plugin this scanner can read as meant; judged as found,
  // before a Codex overlay is merged over it (which would make the result look like a Codex manifest).
  const schema = stringField(detected?.data ?? {}, '$schema')
  if (detected?.kind === 'unknown' && schema !== undefined) warn('manifest-schema-unknown', `${toPosix(relative(root, detected?.path ?? root))} declares an unknown schema: ${schema}`, { path: toPosix(relative(root, detected?.path ?? root)) })

  if (usesAgentPluginSchema(manifest)) {
    for (const error of validateAgentPlugin(manifest)) warn('schema-invalid', `plugin.json: ${error}`, { path: 'plugin.json' })
  }

  addSkills(root, id, manifest, manifestKind, push, warn, usedSkillNames)
  // A folder of Agent Skills holds skills and MCP servers only: its `commands/` or `agents/` is a skill, not a plugin directory.
  const skillsOnly = manifestKind === 'agent-skills'
  if (!skillsOnly) {
    addCommands(root, id, manifest, manifestKind, push, warn, usedCommandNames)
    addAgents(root, id, manifest, manifestKind, push, warn, usedAgentNames)
    addHooks(root, id, manifest, manifestKind, push, warn)
  }
  addMcp(root, id, manifest, manifestKind, push, warn)
  if (!skillsOnly) addUi(root, id, manifest, manifestKind, push, warn)
  addCode(root, id, manifest, manifestKind, components, push, warn)
  // A hooks file that only lists a mod's modules has no hooks of its own: the modules are the code components.
  for (let index = components.length - 1; index >= 0; index--) {
    const component = components[index]
    if (component?.kind === 'hooks' && component.events.length === 0 && component.modules.length > 0) components.splice(index, 1)
  }
  addUnmapped(root, id, manifest, push)

  const ref: SourceRef = {
    kind: options.source,
    root,
    manifestPath: detected?.path ?? join(root, 'plugin.json'),
    manifestKind,
    ...(options.market !== undefined ? { market: options.market } : {}),
  }
  const version = stringField(manifest, 'version')
  const description = stringField(manifest, 'description')
  const license = stringField(manifest, 'license') ?? detectLicense(root)
  const homepage = stringField(manifest, 'homepage')
  const repository = stringField(manifest, 'repository')
  const plugin: ForeignPlugin = {
    id,
    source: options.source,
    name,
    ...(version !== undefined ? { version } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(license !== undefined ? { license } : {}),
    ...(homepage !== undefined ? { homepage } : {}),
    ...(repository !== undefined ? { repository } : {}),
    root,
    ref,
    components,
    warnings,
    manifest,
  }
  return { plugin: { ...plugin, fingerprint: fingerprintPlugin(plugin) } }
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

function addSkills(
  root: string,
  plugin: string,
  manifest: Record<string, unknown>,
  kind: ManifestKind,
  push: (component: SkillComponent) => void,
  warn: (code: string, message: string, extra?: Partial<PluginWarning>) => void,
  used: Set<string>,
): void {
  const roots = new Set<string>([join(root, 'skills')])
  for (const extra of stringArrayField(manifest, 'skills')) {
    const resolved = resolveInside(root, extra)
    if (resolved === undefined) {
      warn('path-escape', `skills path escapes the plugin root: ${extra}`)
      continue
    }
    if (isFile(resolved) && /SKILL\.md$/iu.test(resolved)) {
      addSkillFile(root, plugin, resolved, stem(dirname(resolved)), push, warn, used)
      continue
    }
    if (isDirectory(resolved)) {
      roots.add(resolved)
      continue
    }
    warn('skill-missing', `skills path is neither a directory nor SKILL.md: ${extra}`)
  }
  // Claude: a root SKILL.md is a single skill when there is no skills/ or
  // manifest skills key.
  if (kind === 'claude-code' && !isDirectory(join(root, 'skills')) && !Array.isArray(manifest['skills']) && isFile(join(root, 'SKILL.md'))) {
    addSkillFile(root, plugin, join(root, 'SKILL.md'), kebabCase(basename(root)), push, warn, used)
  }
  for (const skillsRoot of roots) {
    if (!isDirectory(skillsRoot)) continue
    for (const child of childDirectories(skillsRoot)) {
      const body = join(skillsRoot, child, 'SKILL.md')
      if (isFile(body)) addSkillFile(root, plugin, body, child, push, warn, used)
    }
    // Flat `<name>.md` skills are accepted by DSH but not Agent Plugins; they
    // are useful for DSH's own provider and harmless to report.
    for (const entry of safeEntries(skillsRoot)) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        addSkillFile(root, plugin, join(skillsRoot, entry.name), stem(entry.name), push, warn, used)
      }
    }
  }
}

function addSkillFile(
  root: string,
  plugin: string,
  bodyPath: string,
  fallbackName: string,
  push: (component: SkillComponent) => void,
  warn: (code: string, message: string, extra?: Partial<PluginWarning>) => void,
  used: Set<string>,
): void {
  const relativePath = toPosix(relative(root, bodyPath))
  if (!isInsideRoot(root, bodyPath)) {
    warn('path-escape', `skill path escapes the plugin root: ${relativePath}`, { path: relativePath })
    return
  }
  const asset = readMarkdownAsset(bodyPath)
  if (asset === undefined) {
    warn('skill-unreadable', `cannot read skill: ${relativePath}`, { path: relativePath })
    return
  }
  const parsed = parseSkillFrontmatter(asset.data, fallbackName)
  for (const warning of parsed.warnings) warn(warning.code, warning.message, { path: relativePath })
  // Codex's `agents/openai.yaml`: a skill Codex may not choose on its own, and its short description.
  const policy = codexSkillPolicy(dirname(bodyPath))
  const frontmatter = {
    ...parsed.frontmatter,
    ...(parsed.frontmatter.description.length === 0 && policy.description !== undefined ? { description: policy.description } : {}),
    ...(policy.implicit === false ? { modelInvocable: false } : {}),
  }
  const name = uniqueName(frontmatter.name, used, `${plugin}:${relativePath}`)
  used.add(name)
  push({
    id: childId(plugin, 'skill', name),
    kind: 'skill',
    name,
    path: relativePath,
    description: frontmatter.description,
    bodyPath,
    resourceBase: dirname(bodyPath),
    frontmatter,
    ...(frontmatter.metadata !== undefined ? { metadata: frontmatter.metadata } : {}),
  })
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function addCommands(
  root: string,
  plugin: string,
  manifest: Record<string, unknown>,
  kind: ManifestKind,
  push: (component: CommandComponent) => void,
  warn: (code: string, message: string, extra?: Partial<PluginWarning>) => void,
  used: Set<string>,
): void {
  const commandsKey = manifest['commands']
  if (isPlainObject(commandsKey)) {
    for (const [name, entry] of Object.entries(commandsKey)) {
      if (!isPlainObject(entry)) {
        warn('command-invalid', `command "${name}" is not an object`)
        continue
      }
      const source = stringField(entry, 'source')
      const content = stringField(entry, 'content')
      if (source !== undefined && content !== undefined) {
        warn('command-invalid', `command "${name}" declares both source and content`)
        continue
      }
      if (source !== undefined) {
        const path = resolveInside(root, source)
        if (path === undefined || !isFile(path)) {
          warn('command-missing', `command "${name}" source is missing or escapes the plugin root: ${source}`)
          continue
        }
        addCommandFile(root, plugin, path, name, push, warn, used)
      } else if (content !== undefined) {
        const target = uniqueName(name, used, `${plugin}:inline:${name}`)
        used.add(target)
        push({
          id: childId(plugin, 'command', target),
          kind: 'command',
          name: target,
          description: stringField(entry, 'description') ?? '',
          body: content,
          bodyPath: '',
          frontmatter: entry,
        })
      } else {
        warn('command-invalid', `command "${name}" has neither source nor content`)
      }
    }
    // An explicit command map replaces the default directory scan for every
    // dialect; otherwise the same manifest would produce different components.
    return
  }
  const replaced = Array.isArray(manifest['commands']) || typeof manifest['commands'] === 'string'
  const paths = new Set<string>()
  if (replaced) {
    for (const entry of stringArrayField(manifest, 'commands')) {
      const resolved = resolveInside(root, entry)
      if (resolved === undefined) {
        warn('path-escape', `commands path escapes the plugin root: ${entry}`)
        continue
      }
      paths.add(resolved)
    }
  } else {
    paths.add(join(root, 'commands'))
  }
  for (const commandsPath of paths) {
    if (isFile(commandsPath)) {
      addCommandFile(root, plugin, commandsPath, stem(commandsPath), push, warn, used, dirname(commandsPath))
    } else if (isDirectory(commandsPath)) {
      for (const file of walkMarkdown(commandsPath)) {
        const relativePath = relative(commandsPath, file).replace(/\\/gu, '/')
        const namespace = relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : undefined
        addCommandFile(root, plugin, file, stem(file), push, warn, used, commandsPath, namespace)
      }
    }
  }
}

function addCommandFile(
  root: string,
  plugin: string,
  path: string,
  fallbackName: string,
  push: (component: CommandComponent) => void,
  warn: (code: string, message: string, extra?: Partial<PluginWarning>) => void,
  used: Set<string>,
  namespaceRoot?: string,
  namespace?: string,
): void {
  if (!isInsideRoot(root, path)) {
    warn('path-escape', `command path escapes the plugin root: ${toPosix(relative(root, path))}`)
    return
  }
  const asset = readMarkdownAsset(path)
  if (asset === undefined) {
    warn('command-unreadable', `cannot read command: ${toPosix(relative(root, path))}`)
    return
  }
  const rawName = stringField(asset.data, 'name') ?? fallbackName
  const target = uniqueName(namespace === undefined ? rawName : `${namespace.replace(/\//gu, '-')}-${rawName}`, used, `${plugin}:${path}`)
  used.add(target)
  const description = stringField(asset.data, 'description') ?? ''
  push({
    id: childId(plugin, 'command', target),
    kind: 'command',
    name: target,
    path: toPosix(relative(root, path)),
    description,
    ...(namespace !== undefined ? { namespace } : {}),
    invocationName: namespace === undefined ? rawName : `${namespace.replace(/\//gu, ':')}:${rawName}`,
    bodyPath: path,
    body: asset.body,
    frontmatter: asset.data,
  })
  void namespaceRoot
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

function addAgents(
  root: string,
  plugin: string,
  manifest: Record<string, unknown>,
  kind: ManifestKind,
  push: (component: AgentComponent) => void,
  warn: (code: string, message: string, extra?: Partial<PluginWarning>) => void,
  used: Set<string>,
): void {
  const paths = new Set<string>()
  const declared = stringArrayField(manifest, 'agents')
  if (declared.length > 0) {
    for (const entry of declared) {
      const resolved = resolveInside(root, entry)
      if (resolved === undefined) {
        warn('path-escape', `agents path escapes the plugin root: ${entry}`)
        continue
      }
      paths.add(resolved)
    }
  } else {
    paths.add(join(root, 'agents'))
  }
  for (const agentPath of paths) {
    const files = isDirectory(agentPath) ? walkMarkdown(agentPath) : isFile(agentPath) ? [agentPath] : []
    for (const file of files) {
      const asset = readMarkdownAsset(file)
      if (asset === undefined) {
        warn('agent-unreadable', `cannot read agent: ${toPosix(relative(root, file))}`)
        continue
      }
      const rawName = stringField(asset.data, 'name') ?? stem(file)
      const name = uniqueName(rawName, used, `${plugin}:${file}`)
      used.add(name)
      push({
        id: childId(plugin, 'agent', name),
        kind: 'agent',
        name,
        path: toPosix(relative(root, file)),
        description: stringField(asset.data, 'description') ?? '',
        bodyPath: file,
        body: asset.body,
        frontmatter: asset.data,
      })
    }
  }
  void kind
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

function addHooks(
  root: string,
  plugin: string,
  manifest: Record<string, unknown>,
  kind: ManifestKind,
  push: (component: HookComponent) => void,
  warn: (code: string, message: string, extra?: Partial<PluginWarning>) => void,
): void {
  const configs = new Set<string>()
  const addConfig = (entry: unknown): void => {
    if (typeof entry === 'string') {
      const resolved = resolveInside(root, entry)
      if (resolved === undefined) warn('path-escape', `hooks path escapes the plugin root: ${entry}`)
      else if (isFile(resolved)) configs.add(resolved)
      else warn('hooks-missing', `hooks file is missing: ${entry}`)
    } else if (isPlainObject(entry)) {
      // Inline hooks are retained as a synthetic component below.
      addInlineHooks(root, plugin, entry, push, warn)
    } else if (Array.isArray(entry)) {
      for (const item of entry) addConfig(item)
    }
  }
  const declared = manifest['hooks']
  if (declared !== undefined) addConfig(declared)
  const defaultHooks = join(root, 'hooks', 'hooks.json')
  if (isFile(defaultHooks)) configs.add(defaultHooks)
  for (const path of configs) {
    const data = readJsonObject(path)
    if (data === undefined) {
      warn('hooks-unreadable', `cannot parse hooks file: ${toPosix(relative(root, path))}`)
      continue
    }
    const hooks = isPlainObject(data['hooks']) ? data['hooks'] : data
    const events: string[] = []
    const handlerTypes = new Set<string>()
    for (const [event, groups] of Object.entries(hooks)) {
      if (event === 'modules') continue
      if (!Array.isArray(groups)) continue
      events.push(event)
      for (const group of groups) {
        if (!isPlainObject(group)) continue
        const handlers = group['hooks']
        if (!Array.isArray(handlers)) continue
        for (const handler of handlers) {
          if (isPlainObject(handler) && typeof handler['type'] === 'string') handlerTypes.add(handler['type'])
        }
      }
    }
    const modules: string[] = []
    if (Array.isArray(data['modules'])) {
      for (const modulePath of data['modules']) {
        if (typeof modulePath !== 'string') continue
        const resolved = resolve(dirname(path), modulePath)
        if (!isInside(root, resolved)) warn('path-escape', `hook module escapes the plugin root: ${modulePath}`)
        else modules.push(resolved)
      }
    }
    push({
      id: childId(plugin, 'hooks', stem(path)),
      kind: 'hooks',
      name: stem(path),
      path: toPosix(relative(root, path)),
      configPath: path,
      events: [...new Set(events)].sort(),
      handlerTypes: [...handlerTypes].sort(),
      modules,
      description: `${events.length} event(s)`,
    })
  }
  void kind
}

function addInlineHooks(
  root: string,
  plugin: string,
  data: Record<string, unknown>,
  push: (component: HookComponent) => void,
  warn: (code: string, message: string, extra?: Partial<PluginWarning>) => void,
): void {
  const events: string[] = []
  const handlerTypes = new Set<string>()
  for (const [event, groups] of Object.entries(data)) {
    if (!Array.isArray(groups)) continue
    events.push(event)
    for (const group of groups) {
      if (!isPlainObject(group)) continue
      const handlers = group['hooks']
      if (!Array.isArray(handlers)) continue
      for (const handler of handlers) {
        if (isPlainObject(handler) && typeof handler['type'] === 'string') handlerTypes.add(handler['type'])
      }
    }
  }
  if (events.length === 0) warn('hooks-invalid', 'inline hooks have no event groups')
  push({
    id: childId(plugin, 'hooks', 'inline'),
    kind: 'hooks',
    name: 'inline',
    configPath: '',
    inline: data,
    events: [...new Set(events)].sort(),
    handlerTypes: [...handlerTypes].sort(),
    modules: [],
    description: 'inline hook configuration',
  })
  void root
}

// ---------------------------------------------------------------------------
// Parts with no DSH mapping yet
// ---------------------------------------------------------------------------

/**
 * LSP servers, app connectors, `bin/` executables and install-time user
 * config have no DSH mapping yet. They become `other` components so the gap
 * is visible instead of the plugin looking smaller than it is.
 */
function addUnmapped(
  root: string,
  plugin: string,
  manifest: Record<string, unknown>,
  push: (component: ForeignComponent) => void,
): void {
  const add = (originalKind: string, name: string, description: string, path?: string): void => {
    push({
      id: childId(plugin, 'other', `${originalKind}-${name}`),
      kind: 'other',
      originalKind,
      name: `${originalKind}-${name}`,
      description,
      ...(path !== undefined ? { path } : {}),
    })
  }
  const lsp = isPlainObject(manifest['lspServers']) ? manifest['lspServers'] : readJsonObject(join(root, '.lsp.json'))
  for (const name of Object.keys(lsp ?? {})) add('lsp-server', kebabCase(name), `LSP server "${name}"`, isFile(join(root, '.lsp.json')) ? '.lsp.json' : undefined)
  if (isFile(join(root, '.app.json')) || manifest['apps'] !== undefined) add('app-connector', 'apps', 'Hosted app connector; runs only inside its own harness', isFile(join(root, '.app.json')) ? '.app.json' : undefined)
  if (isDirectory(join(root, 'bin'))) add('bin', 'path', 'Executables the harness adds to PATH for shell tools', 'bin')
  if (isPlainObject(manifest['userConfig'])) add('user-config', 'settings', `Install-time settings: ${Object.keys(manifest['userConfig']).join(', ')}`)
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

function addMcp(
  root: string,
  plugin: string,
  manifest: Record<string, unknown>,
  kind: ManifestKind,
  push: (component: McpComponent) => void,
  warn: (code: string, message: string, extra?: Partial<PluginWarning>) => void,
): void {
  const maps: Array<{ path: string; data: Record<string, unknown> }> = []
  for (const file of [join(root, 'mcp.json'), join(root, '.mcp.json')]) {
    const data = readJsonObject(file)
    if (data === undefined) continue
    if (usesAgentMcpSchema(data)) {
      for (const error of validateAgentMcp(data)) warn('schema-invalid', `${basename(file)}: ${error}`, { path: basename(file) })
    }
    const map = isPlainObject(data['mcpServers']) ? data['mcpServers'] : data
    maps.push({ path: file, data: map })
  }
  const declared = manifest['mcpServers']
  if (typeof declared === 'string') {
    const resolved = resolveInside(root, declared)
    if (resolved === undefined) warn('path-escape', `mcpServers path escapes the plugin root: ${declared}`)
    else {
      const data = readJsonObject(resolved)
      if (data !== undefined) maps.push({ path: resolved, data: isPlainObject(data['mcpServers']) ? data['mcpServers'] : data })
    }
  } else if (isPlainObject(declared)) {
    maps.push({ path: join(root, 'plugin.json'), data: declared })
  } else if (Array.isArray(declared)) {
    for (const entry of declared) {
      if (typeof entry === 'string') {
        const resolved = resolveInside(root, entry)
        const data = resolved === undefined ? undefined : readJsonObject(resolved)
        if (data !== undefined) maps.push({ path: resolved!, data: isPlainObject(data['mcpServers']) ? data['mcpServers'] : data })
      } else if (isPlainObject(entry)) {
        maps.push({ path: join(root, 'plugin.json'), data: entry })
      }
    }
  }
  const seen = new Set<string>()
  const seenMaps = new Set<string>()
  const seenConfigs = new Set<string>()
  for (const map of maps) {
    if (seenMaps.has(map.path)) continue
    seenMaps.add(map.path)
    for (const [name, raw] of Object.entries(map.data)) {
      if (!isPlainObject(raw)) {
        warn('mcp-invalid', `MCP server "${name}" is not an object`)
        continue
      }
      const configText = JSON.stringify(raw)
      const configKey = `${name}\0${configText}`
      if (seenConfigs.has(configKey)) continue
      seenConfigs.add(configKey)
      const serverName = uniqueName(name, seen, `${plugin}:${map.path}:${name}`)
      seen.add(serverName)
      const transport = mcpTransport(raw)
      const command = stringField(raw, 'command')
      const url = stringField(raw, 'url')
      const args = stringArrayField(raw, 'args')
      const env = stringRecord(raw['env'])
      const headers = stringRecord(raw['headers'])
      const cwd = stringField(raw, 'cwd')
      push({
        id: childId(plugin, 'mcp', serverName),
        kind: 'mcp',
        name: serverName,
        path: toPosix(relative(root, map.path)),
        description: stringField(raw, 'description') ?? `${transport} MCP server`,
        transport,
        ...(command !== undefined ? { command } : {}),
        ...(args.length > 0 ? { args } : {}),
        ...(env !== undefined ? { env } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
        ...(url !== undefined ? { url } : {}),
        ...(headers !== undefined ? { headers } : {}),
      })
    }
  }
  void kind
}

function mcpTransport(raw: Record<string, unknown>): McpComponent['transport'] {
  const declared = stringField(raw, 'type') ?? stringField(raw, 'transport')
  if (declared === 'stdio' || declared === 'streamable-http' || declared === 'sse') return declared
  if (declared === 'http' || declared === 'streamableHttp') return 'streamable-http'
  if (stringField(raw, 'command') !== undefined) return 'stdio'
  if (stringField(raw, 'url') !== undefined) return 'streamable-http'
  return 'unknown'
}

function stringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isPlainObject(value)) return undefined
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

// ---------------------------------------------------------------------------
// UI / workflows / monitors
// ---------------------------------------------------------------------------

function addUi(
  root: string,
  plugin: string,
  manifest: Record<string, unknown>,
  kind: ManifestKind,
  push: (component: UiComponent) => void,
  warn: (code: string, message: string, extra?: Partial<PluginWarning>) => void,
): void {
  const add = (surface: UiComponent['surface'], path: string, name: string): void => {
    const inside = path.length > 0 && isInsideRoot(root, path)
    const relativePath = inside ? toPosix(relative(root, path)) : undefined
    // A plugin's one status line is "statusline", not "statusline-statusline".
    const label = name === surface ? surface : `${surface}-${name}`
    push({
      id: childId(plugin, 'ui', label),
      kind: 'ui',
      name: label,
      surface,
      ...(relativePath !== undefined ? { path: relativePath } : {}),
      ...(inside ? { specPath: path } : {}),
      description: surface,
    })
  }
  for (const file of walkFiles(join(root, 'output-styles'), name => name.endsWith('.md'))) add('output-style', file, stem(file))
  for (const file of walkFiles(join(root, 'themes'), name => name.endsWith('.json'))) add('theme', file, stem(file))
  for (const file of walkFiles(join(root, 'workflows'), name => name.endsWith('.js'))) add('workflow', file, stem(file))
  for (const file of walkFiles(join(root, 'monitors'), name => name.endsWith('.json'))) add('monitor', file, stem(file))
  const statusLine = manifest['statusLine']
  if (isPlainObject(statusLine)) {
    const manifestFile = isFile(join(root, '.claude-plugin', 'plugin.json'))
      ? join(root, '.claude-plugin', 'plugin.json')
      : join(root, 'plugin.json')
    add('statusline', isFile(manifestFile) ? manifestFile : '', 'statusline')
  } else if (kind === 'claude-code') {
    // Plugins cannot set statusLine themselves; one that ships a status line has a script that writes
    // it into the user's settings.json (claude-hud's install.mjs). That script names the surface.
    const installer = walkFiles(root, name => /\.(?:mjs|cjs|js|ts)$/u.test(name), 1)
      .filter(file => !/[\\/](?:node_modules|tests?|dist|src|verify|maintainer)[\\/]/u.test(relative(root, file)))
      // The installer itself names the surface best: install/setup scripts first.
      .sort((a, b) => Number(/install|setup/iu.test(stem(b))) - Number(/install|setup/iu.test(stem(a))))
      .find(file => /\bstatusLine\b/u.test(readText(file) ?? '') && /settings\.json/u.test(readText(file) ?? ''))
    if (installer !== undefined) add('statusline', installer, 'statusline')
  }
  void kind
  void warn
}

// ---------------------------------------------------------------------------
// Code plugins
// ---------------------------------------------------------------------------

function addCode(
  root: string,
  plugin: string,
  manifest: Record<string, unknown>,
  kind: ManifestKind,
  components: readonly ForeignComponent[],
  push: (component: CodeComponent) => void,
  warn: (code: string, message: string, extra?: Partial<PluginWarning>) => void,
): void {
  const used = new Set<string>()
  const seen = new Set<string>()
  for (const component of components) {
    if (component.kind !== 'hooks') continue
    for (const modulePath of component.modules) {
      if (seen.has(modulePath)) continue
      seen.add(modulePath)
      if (!isInsideRoot(root, modulePath)) {
        warn('path-escape', `code module escapes the plugin root: ${toPosix(relative(root, modulePath))}`)
        continue
      }
      const name = uniqueName(stem(modulePath), used, modulePath)
      used.add(name)
      push({
        id: childId(plugin, 'code', name),
        kind: 'code',
        name,
        runtime: 'claude-mod',
        entryPath: modulePath,
        path: toPosix(relative(root, modulePath)),
        apiVersion: typeof manifest['types'] === 'string' ? 'claude-mod-types' : 'claude-mod',
        description: 'Claude Code mod hooks module',
      })
    }
  }
  void kind
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function safeEntries(root: string): Array<{ name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }> {
  try {
    return readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
}

function walkMarkdown(root: string): string[] {
  return walkFiles(root, name => name.toLowerCase().endsWith('.md'))
}

/** Files under a directory, following linked directories and files once each. */
/** Files under `root` whose name passes `predicate`; `maxDepth` levels of directories below it (all by default). */
function walkFiles(root: string, predicate: (name: string) => boolean, maxDepth = Number.POSITIVE_INFINITY): string[] {
  const out: string[] = []
  const visited = new Set<string>()
  const visit = (dir: string, depth: number): void => {
    const real = realOrLexical(dir)
    if (visited.has(real)) return
    visited.add(real)
    for (const entry of safeEntries(dir)) {
      const path = join(dir, entry.name)
      const linked = entry.isSymbolicLink()
      if (entry.isDirectory() || (linked && isDirectory(path))) {
        if (depth < maxDepth && entry.name !== 'node_modules' && entry.name !== '.git') visit(path, depth + 1)
      }
      else if ((entry.isFile() || (linked && isFile(path))) && predicate(entry.name)) out.push(path)
    }
  }
  if (isDirectory(root)) visit(root, 0)
  return out.sort((a, b) => a.localeCompare(b, 'en'))
}

function isInsideRoot(root: string, path: string): boolean {
  return isInside(root, path)
}

// Re-exported here to keep the scanner self-contained for new connectors.
export type { MarkdownAsset }
