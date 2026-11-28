/**
 * Read-only OpenCode project scanner. OpenCode plugins are code, so this
 * scanner reports executable entries as `code`/`other` components and only
 * promotes skills, commands and MCP declarations to importable assets.
 * @module @kirkchinese/harness-forge-core
 */
import { readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { openCodeConfigFiles, openCodeInventory, pluginEntryOf, type OpenCodeLocation, type OpenCodePluginEntry } from './inventory.js'
import type { PluginIdProblem } from './plugin-id.js'
import type { UserEnablement } from '../types.js'
import { childId, kebabCase, pluginId, uniqueName } from '../../naming.js'
import { fingerprintPlugin } from '../../fingerprint.js'
import {
  childDirectories,
  isDirectory,
  isFile,
  isInside,
  isPlainObject,
  leadsToShare,
  readJsonObject,
  readText,
  stem,
  toPosix,
} from '../../paths.js'
import { parseSkillFrontmatter, readMarkdownAsset } from '../../frontmatter.js'
import type {
  CodeComponent,
  CommandComponent,
  ForeignComponent,
  ForeignPlugin,
  HookComponent,
  McpComponent,
  OtherComponent,
  SkillComponent,
} from '../../types.js'

/** Strip JSONC comments and trailing commas without touching string literals. */
export function stripJsonc(text: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? ''
    const next = text[index + 1] ?? ''
    if (inString) {
      out += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1
      out += '\n'
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1
      index += 1
      continue
    }
    out += char
  }
  // Remove trailing commas outside string literals, preserving commas that
  // are part of a JSON string value.
  let cleaned = ''
  let quoted = false
  let escapedClean = false
  for (let index = 0; index < out.length; index += 1) {
    const char = out[index] ?? ''
    if (quoted) {
      cleaned += char
      if (escapedClean) escapedClean = false
      else if (char === '\\') escapedClean = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') {
      quoted = true
      cleaned += char
      continue
    }
    if (char === ',') {
      let lookahead = index + 1
      while (lookahead < out.length && /\s/u.test(out[lookahead] ?? '')) lookahead += 1
      if (out[lookahead] === '}' || out[lookahead] === ']') continue
    }
    cleaned += char
  }
  return cleaned
}

/** Read `opencode.json` or `opencode.jsonc`, returning an object when valid. */
export function readOpenCodeConfig(root: string): Record<string, unknown> | undefined {
  const json = readJsonObject(join(root, 'opencode.json'))
  if (json !== undefined) return json
  const text = readText(join(root, 'opencode.jsonc'))
  if (text === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(stripJsonc(text))
    return isPlainObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Scan an OpenCode project root.
 * @param options.name - plugin name to use instead of the package's.
 */
export function scanOpenCodeProject(root: string, options: { readonly name?: string } = {}): { plugin: ForeignPlugin; warnings: string[] } {
  const warnings: string[] = []
  const config = readOpenCodeConfig(root) ?? {}
  const packageJson = readJsonObject(join(root, 'package.json'))
  const name = kebabCase(options.name ?? (typeof packageJson?.['name'] === 'string' ? packageJson['name'] : basename(root)))
  const id = pluginId('opencode', name)
  const components: ForeignComponent[] = []
  const usedSkillNames = new Set<string>()
  const usedCommandNames = new Set<string>()
  const usedCodeNames = new Set<string>()

  // Skills: OpenCode discovers `.opencode/skills`, plus Claude/Agents roots.
  for (const skillsRoot of [
    join(root, '.opencode', 'skills'),
    join(root, '.claude', 'skills'),
    join(root, '.agents', 'skills'),
  ]) {
    for (const child of childDirectories(skillsRoot)) {
      const bodyPath = join(skillsRoot, child, 'SKILL.md')
      if (!isFile(bodyPath) || !isInside(root, bodyPath)) continue
      const asset = readMarkdownAsset(bodyPath)
      if (asset === undefined) continue
      const parsed = parseSkillFrontmatter(asset.data, child)
      if (parsed.frontmatter.description.length === 0) continue
      const skillName = uniqueName(parsed.frontmatter.name, usedSkillNames, `${id}:${bodyPath}`)
      usedSkillNames.add(skillName)
      const component: SkillComponent = {
        id: childId(id, 'skill', skillName),
        kind: 'skill',
        name: skillName,
        path: toPosix(bodyPath.slice(root.length + 1)),
        description: parsed.frontmatter.description,
        bodyPath,
        resourceBase: dirname(bodyPath),
        frontmatter: parsed.frontmatter,
      }
      components.push(component)
    }
  }

  // Commands: OpenCode uses both `command` (singular) and legacy `commands`.
  for (const commandRoot of [
    join(root, '.opencode', 'command'),
    join(root, '.opencode', 'commands'),
  ]) {
    for (const file of walkMarkdown(commandRoot)) {
      if (!isInside(root, file)) continue
      const asset = readMarkdownAsset(file)
      if (asset === undefined) continue
      const rawName = typeof asset.data['name'] === 'string' ? asset.data['name'] : stem(file)
      const commandName = uniqueName(rawName, usedCommandNames, `${id}:${file}`)
      usedCommandNames.add(commandName)
      const component: CommandComponent = {
        id: childId(id, 'command', commandName),
        kind: 'command',
        name: commandName,
        path: toPosix(file.slice(root.length + 1)),
        description: typeof asset.data['description'] === 'string' ? asset.data['description'] : '',
        bodyPath: file,
        body: asset.body,
        frontmatter: asset.data,
      }
      components.push(component)
    }
  }

  // MCP servers declared in config.
  const mcp = isPlainObject(config['mcp']) ? config['mcp'] : isPlainObject(config['mcpServers']) ? config['mcpServers'] : {}
  const usedMcp = new Set<string>()
  for (const [serverName, raw] of Object.entries(mcp)) {
    if (!isPlainObject(raw)) continue
    const nameSafe = uniqueName(serverName, usedMcp, `${id}:${serverName}`)
    usedMcp.add(nameSafe)
    const type = typeof raw['type'] === 'string' ? raw['type'] : undefined
    const url = typeof raw['url'] === 'string' ? raw['url'] : undefined
    const command = typeof raw['command'] === 'string' ? raw['command'] : undefined
    const component: McpComponent = {
      id: childId(id, 'mcp', nameSafe),
      kind: 'mcp',
      name: nameSafe,
      declaredName: serverName,
      transport: type === 'remote' || url !== undefined ? 'streamable-http' : command !== undefined ? 'stdio' : 'unknown',
      ...(command !== undefined ? { command } : {}),
      ...(url !== undefined ? { url } : {}),
      ...(Array.isArray(raw['args']) ? { args: raw['args'].filter((arg): arg is string => typeof arg === 'string') } : {}),
      ...(isPlainObject(raw['environment']) ? { env: stringMap(raw['environment']) } : {}),
      ...(isPlainObject(raw['headers']) ? { headers: stringMap(raw['headers']) } : {}),
    }
    components.push(component)
  }

  // The plugins OpenCode loads for this project: configured entries and the `.opencode/plugin(s)/` folders.
  // Only what lies inside the project is read as its code; a package from elsewhere is reported by its spec.
  // A plugin the project's config switches off, or may switch off, is not surely OpenCode's to run here, and is left out.
  const inventory = openCodeInventory({ configDir: join(root, '.opencode'), configFiles: [...openCodeConfigFiles(root), ...openCodeConfigFiles(join(root, '.opencode'))] })
  warnings.push(...inventory.warnings)
  for (const entry of inventory.entries) {
    if (entry.enabled !== true) {
      warnings.push(leftOut(entry))
      continue
    }
    const entryPath = entry.kind === 'file' ? entry.path : entry.kind === 'package' ? entry.entryPath : undefined
    if (entryPath !== undefined && isInside(root, entryPath)) {
      components.push(codeComponent(id, root, entry.kind === 'package' ? entry.root : entryPath, entryPath, usedCodeNames))
    } else if (entry.kind !== 'file' && entry.spec !== undefined) {
      const local = entry.kind === 'package' && isInside(root, entry.root)
      components.push({
        id: childId(id, 'other', entry.spec),
        kind: 'other',
        originalKind: 'opencode-plugin-package',
        name: entry.spec,
        description: local ? 'OpenCode local plugin has no index/server entry' : 'OpenCode npm/git plugin package; not loaded by the preview shim',
      } satisfies OtherComponent)
    }
  }

  // The directory is itself a plugin package: it depends on OpenCode's plugin SDK, or it is a bare package
  // directory OpenCode loads from a plugins folder (no config of its own, no `.opencode/`).
  const declared = {
    ...(packageJson !== undefined && isPlainObject(packageJson['dependencies']) ? packageJson['dependencies'] : {}),
    ...(packageJson !== undefined && isPlainObject(packageJson['peerDependencies']) ? packageJson['peerDependencies'] : {}),
  }
  const bare = openCodeConfigFiles(root).length === 0 && !isDirectory(join(root, '.opencode'))
  const isCodePackage = bare || Object.keys(declared).some(name => name === '@opencode-ai/plugin' || name === '@opencode/plugin')
  if (isCodePackage && !components.some(component => component.kind === 'code')) {
    const entryPath = pluginEntryOf(root)
    if (entryPath !== undefined && isInside(root, entryPath)) components.push(codeComponent(id, root, entryPath, entryPath, usedCodeNames))
  }

  const problems = components.length === 0 ? ['no OpenCode components found'] : []
  warnings.push(...problems)
  const plugin: ForeignPlugin = {
    id,
    source: 'opencode',
    name,
    ...(typeof packageJson?.['version'] === 'string' ? { version: packageJson['version'] } : {}),
    ...(typeof packageJson?.['description'] === 'string' ? { description: packageJson['description'] } : {}),
    ...(typeof packageJson?.['license'] === 'string' ? { license: packageJson['license'] } : {}),
    root,
    ref: {
      kind: 'opencode',
      root,
      manifestPath: isFile(join(root, 'opencode.json')) ? join(root, 'opencode.json') : join(root, 'opencode.jsonc'),
      manifestKind: 'opencode',
    },
    components,
    warnings: [
      ...warnings.filter(message => !problems.includes(message)).map(message => ({ code: 'opencode-plugin', message })),
      ...problems.map(message => ({ code: 'opencode-empty', message })),
    ],
    manifest: config,
  }
  return { plugin: { ...plugin, fingerprint: fingerprintPlugin(plugin) }, warnings }
}

/** A code component OpenCode runs: `named` gives its name (a package directory, or the file itself). */
function codeComponent(id: string, root: string, named: string, entryPath: string, used: Set<string>): CodeComponent {
  const name = uniqueName(stem(named), used, entryPath)
  used.add(name)
  return { id: childId(id, 'code', name), kind: 'code', name, runtime: 'opencode-plugin', entryPath, path: toPosix(entryPath.slice(root.length + 1)) }
}

/** OpenCode's global config directory (https://opencode.ai/docs/plugins/: "Global plugins use the same discovery layout under the OpenCode config directory"). */
export function openCodeConfigDir(home: string): string {
  return join(home, '.config', 'opencode')
}

/** OpenCode's package cache, where V1 installed npm plugins (https://opencode.ai/v1/docs/plugins.md: "cached in ~/.cache/opencode/node_modules/"). */
export function openCodeCacheDir(home: string): string {
  return join(home, '.cache', 'opencode')
}

/** Where OpenCode keeps a global config directory's plugins, its npm cache included. */
export function openCodeGlobalLocation(home: string): OpenCodeLocation {
  const configDir = openCodeConfigDir(home)
  return { configDir, configFiles: openCodeConfigFiles(configDir), cacheDir: openCodeCacheDir(home) }
}

/** What a plugin of the inventory is called in a warning: its file, folder or spec. */
function pluginLabel(entry: OpenCodePluginEntry): string {
  return `OpenCode plugin ${entry.kind === 'file' ? entry.path : entry.kind === 'package' ? entry.root : entry.spec}`
}

/** Why a plugin OpenCode may not run is left out: it is switched off, or its id does not tell whether it is. */
function leftOut(entry: OpenCodePluginEntry): string {
  return !('unknownBecause' in entry)
    ? `${pluginLabel(entry)} is switched off in OpenCode's config and is left out`
    : `${pluginLabel(entry)} is left out: an entry in OpenCode's config switches plugins by id, and its id ${ID_PROBLEM_TEXT[entry.unknownBecause]}, so whether OpenCode runs it cannot be told`
}

/** How a warning says why a plugin's id cannot be told. */
const ID_PROBLEM_TEXT: Readonly<Record<PluginIdProblem, string>> = {
  missing: 'is declared by no Plugin.define({ id }) Harness Forge can read',
  ambiguous: 'is declared more than once',
  dynamic: 'is computed, not a plain string',
  escape: 'is written with an escape JavaScript refuses in a module',
}

/** The plugin files right in OpenCode's global plugins folder, with whether OpenCode runs each. */
function userPluginFiles(home: string): { files: Array<OpenCodePluginEntry & { kind: 'file' }>; warnings: readonly string[] } {
  const inventory = openCodeInventory(openCodeGlobalLocation(home))
  return { files: inventory.entries.filter((entry): entry is OpenCodePluginEntry & { kind: 'file' } => entry.kind === 'file'), warnings: inventory.warnings }
}

/**
 * Whether OpenCode runs the person's plugin files: on when it surely runs one; else not known when it may run one
 * (why, from the first such file), else off when its config switches off every one.
 */
export function openCodeUserEnablement(home: string): UserEnablement {
  const { files } = userPluginFiles(home)
  if (files.length === 0 || files.some(file => file.enabled === true)) return { enabled: true }
  for (const file of files) if ('unknownBecause' in file) return { enabledUnknown: file.unknownBecause }
  return { enabled: false }
}

/**
 * The plugin files a person keeps right in OpenCode's global plugins folder, as one plugin `opencode:user`
 * rooted at the config directory (where OpenCode installs their dependencies). Package directories and
 * configured packages are plugins of their own (`harnessPlugins`). When OpenCode surely runs some files, the others
 * (switched off, or not known to run) are left out, with why; else the plugin holds them all, and is off or not
 * known to run ({@link openCodeUserEnablement}).
 * @returns undefined when there is no such file.
 */
export function scanOpenCodeUser(home: string): ForeignPlugin | undefined {
  const root = openCodeConfigDir(home)
  const id = pluginId('opencode', 'user')
  const used = new Set<string>()
  const { files, warnings } = userPluginFiles(home)
  const running = files.some(file => file.enabled === true)
  const kept = running ? files.filter(file => file.enabled === true) : files
  const components: ForeignComponent[] = kept.map(file => codeComponent(id, root, file.path, file.path, used))
  if (components.length === 0) return undefined
  const manifest = { name: 'user', scope: 'user', description: 'OpenCode plugin files (~/.config/opencode/plugins)' }
  const left = running ? files.filter(file => file.enabled !== true).map(leftOut) : []
  const plugin: ForeignPlugin = {
    id,
    source: 'opencode',
    name: 'user',
    description: manifest.description,
    root,
    ref: { kind: 'opencode', root, manifestPath: join(root, 'opencode.json'), manifestKind: 'opencode' },
    components,
    warnings: [...warnings, ...left].map(message => ({ code: 'opencode-plugin', message })),
    manifest,
  }
  return { ...plugin, fingerprint: fingerprintPlugin(plugin) }
}

function walkMarkdown(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    if (leadsToShare(dir)) return
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(path)
      }
    } catch {
      return
    }
  }
  walk(root)
  return out.sort((a, b) => a.localeCompare(b, 'en'))
}

function stringMap(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

/** A hook component placeholder for OpenCode events, when one is reported. */
export function openCodeHooks(id: string, events: readonly string[]): HookComponent {
  return {
    id: childId(id, 'hooks', 'opencode'),
    kind: 'hooks',
    name: 'opencode',
    configPath: '',
    events,
    handlerTypes: ['event'],
    modules: [],
  }
}
