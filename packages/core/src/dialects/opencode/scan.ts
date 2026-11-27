/**
 * Read-only OpenCode project scanner. OpenCode plugins are code, so this
 * scanner reports executable entries as `code`/`other` components and only
 * promotes skills, commands and MCP declarations to importable assets.
 * @module @kirkchinese/harness-forge-core
 */
import { readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { childId, kebabCase, pluginId, uniqueName } from '../../naming.js'
import { fingerprintPlugin } from '../../fingerprint.js'
import {
  childDirectories,
  isDirectory,
  isFile,
  isInside,
  isPlainObject,
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
      transport: type === 'remote' || url !== undefined ? 'streamable-http' : command !== undefined ? 'stdio' : 'unknown',
      ...(command !== undefined ? { command } : {}),
      ...(url !== undefined ? { url } : {}),
      ...(Array.isArray(raw['args']) ? { args: raw['args'].filter((arg): arg is string => typeof arg === 'string') } : {}),
      ...(isPlainObject(raw['environment']) ? { env: stringMap(raw['environment']) } : {}),
      ...(isPlainObject(raw['headers']) ? { headers: stringMap(raw['headers']) } : {}),
    }
    components.push(component)
  }

  // Plugin entries: local directories become code components; package entries
  // are reported as other components until the code shim can load them.
  const pluginEntries = Array.isArray(config['plugins']) ? config['plugins'] : Array.isArray(config['plugin']) ? config['plugin'] : []
  for (const entry of pluginEntries) {
    const spec = typeof entry === 'string' ? entry : isPlainObject(entry) && typeof entry['package'] === 'string' ? entry['package'] : undefined
    if (spec === undefined) continue
    const local = spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('file:')
    const path = local ? join(root, spec.replace(/^file:/u, '')) : undefined
    const entryPath = path !== undefined && isInside(root, path) && isDirectory(path) ? pluginEntryOf(path) : undefined
    if (path !== undefined && entryPath !== undefined) {
      const codeName = uniqueName(stem(path), usedCodeNames, path)
      usedCodeNames.add(codeName)
      const component: CodeComponent = {
        id: childId(id, 'code', codeName),
        kind: 'code',
        name: codeName,
        runtime: 'opencode-plugin',
        entryPath,
        path: toPosix(entryPath.slice(root.length + 1)),
      }
      components.push(component)
    } else if (path === undefined || isDirectory(path)) {
      const component: OtherComponent = {
        id: childId(id, 'other', spec),
        kind: 'other',
        originalKind: 'opencode-plugin-package',
        name: spec,
        description: path === undefined
          ? 'OpenCode npm/git plugin package; not loaded by the preview shim'
          : 'OpenCode local plugin has no index/server entry',
      }
      components.push(component)
    }
  }

  // Plugins OpenCode discovers on its own: files and package directories under `.opencode/plugin(s)/`.
  for (const dir of [join(root, '.opencode', 'plugins'), join(root, '.opencode', 'plugin')]) {
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries.sort((a, b) => a.localeCompare(b, 'en'))) {
      const path = join(dir, entry)
      const entryPath = isFile(path) && /\.(ts|tsx|js|mjs)$/u.test(entry) ? path : isDirectory(path) ? pluginEntryOf(path) : undefined
      if (entryPath === undefined || !isInside(root, entryPath)) continue
      const codeName = uniqueName(stem(entry), usedCodeNames, entryPath)
      usedCodeNames.add(codeName)
      components.push({ id: childId(id, 'code', codeName), kind: 'code', name: codeName, runtime: 'opencode-plugin', entryPath, path: toPosix(entryPath.slice(root.length + 1)) })
    }
  }

  // The directory is itself a plugin package: it depends on OpenCode's plugin SDK.
  const declared = {
    ...(packageJson !== undefined && isPlainObject(packageJson['dependencies']) ? packageJson['dependencies'] : {}),
    ...(packageJson !== undefined && isPlainObject(packageJson['peerDependencies']) ? packageJson['peerDependencies'] : {}),
  }
  const isCodePackage = Object.keys(declared).some(name => name === '@opencode-ai/plugin' || name === '@opencode/plugin')
  if (isCodePackage && !components.some(component => component.kind === 'code')) {
    const entryPath = pluginEntryOf(root)
    if (entryPath !== undefined && isInside(root, entryPath)) {
      const codeName = uniqueName(stem(entryPath), usedCodeNames, entryPath)
      usedCodeNames.add(codeName)
      components.push({
        id: childId(id, 'code', codeName),
        kind: 'code',
        name: codeName,
        runtime: 'opencode-plugin',
        entryPath,
        path: toPosix(entryPath.slice(root.length + 1)),
      })
    }
  }

  const problems = components.length === 0 ? ['no OpenCode components found'] : []
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
    warnings: problems.map(message => ({ code: 'opencode-empty', message })),
    manifest: config,
  }
  return { plugin: { ...plugin, fingerprint: fingerprintPlugin(plugin) }, warnings: problems }
}

/**
 * A plugin package's server entry, as OpenCode loads it: `exports` `./server`
 * or `.`, else `main`/`module`, else `server` or `index` at its root. A
 * source checkout whose build output is absent runs from its TypeScript
 * source (`dist/x.js` → `src/x.ts` or `x.ts`), as Bun runs it.
 */
function pluginEntryOf(directory: string): string | undefined {
  const packageJson = readJsonObject(join(directory, 'package.json'))
  const targets: string[] = []
  const exportsField = packageJson?.['exports']
  const conditional = (value: unknown): string | undefined => {
    if (typeof value === 'string') return value
    if (!isPlainObject(value)) return undefined
    for (const key of ['bun', 'import', 'default', 'node', 'require']) {
      const found = conditional(value[key])
      if (found !== undefined) return found
    }
    return undefined
  }
  if (typeof exportsField === 'string') targets.push(exportsField)
  else if (isPlainObject(exportsField)) {
    for (const key of ['./server', '.']) {
      const target = conditional(exportsField[key])
      if (target !== undefined) targets.push(target)
    }
  }
  for (const key of ['main', 'module']) if (typeof packageJson?.[key] === 'string') targets.push(packageJson[key])
  for (const target of targets) {
    const resolved = resolve(directory, target)
    if (isFile(resolved)) return resolved
    const source = sourceOf(directory, target)
    if (source !== undefined) return source
  }
  for (const name of ['server.ts', 'server.tsx', 'server.js', 'index.ts', 'index.tsx', 'index.js', 'index.mjs']) {
    const candidate = join(directory, name)
    if (isFile(candidate)) return candidate
  }
  return undefined
}

/** The TypeScript source of a build output path, when the checkout has it. */
function sourceOf(directory: string, target: string): string | undefined {
  const relative = target.replace(/^\.\//u, '').replace(/^(dist|build|lib|out)\//u, '').replace(/\.(m|c)?js$/u, '')
  for (const candidate of [`src/${relative}.ts`, `src/${relative}.tsx`, `${relative}.ts`, `${relative}.tsx`]) {
    const path = join(directory, candidate)
    if (isFile(path)) return path
  }
  return undefined
}

function walkMarkdown(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
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
