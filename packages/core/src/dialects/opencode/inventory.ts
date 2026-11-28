/**
 * The OpenCode plugins one config directory loads, enumerated the way OpenCode
 * finds them (https://opencode.ai/docs/plugins/, and the V1 docs at
 * https://opencode.ai/v1/docs/plugins.md):
 *
 * - `.ts`/`.js`/`.mjs` files and package directories right inside its
 *   `plugins/` folder (V1 also read `plugin/`; V2 discovers both);
 * - the `plugins` (V2) or `plugin` (V1) entries of its `opencode.json(c)`:
 *   local paths, resolved from the config file and required to be
 *   directories, and npm package specs, found where OpenCode installed them:
 *   `node_modules` of the config directory that declared them, else OpenCode's
 *   cache `~/.cache/opencode/node_modules`.
 *
 * Nothing below those folders is searched: a package's own files are its own.
 * @module @kirkchinese/harness-forge-core
 */
import { readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { contentPath, isDirectory, isFile, isPlainObject, reachesNewShare, readJsonObject, readText } from '../../paths.js'
import { stripJsonc } from './scan.js'
import { declaredPluginId, type PluginIdProblem, type PluginIdRead } from './plugin-id.js'

/** One plugin OpenCode loads from a config directory, and where it is. */
export type OpenCodePlugin =
  /** A plugin file right inside a plugins folder. */
  | { readonly kind: 'file'; readonly path: string }
  /**
   * A plugin package directory: in a plugins folder, a configured local directory, or an installed npm package,
   * with the server entry OpenCode runs (none for a configured directory without one; a folder's directory without
   * one is no plugin and not listed).
   */
  | { readonly kind: 'package'; readonly root: string; readonly spec?: string; readonly entryPath?: string }
  /**
   * A configured entry with nothing on disk to read: a package OpenCode has not installed, or a git spec. `candidates`
   * are the folders it would be in (a local path, or `node_modules/<name>` of the config and cache folders); none for a
   * spec no folder can be named for.
   */
  | { readonly kind: 'unresolved'; readonly spec: string; readonly candidates?: readonly string[] }

/** Whether OpenCode runs a plugin, or, when that cannot be told, why. */
export type OpenCodeEnablement =
  | { readonly enabled: boolean }
  /**
   * An entry that switches plugins by id may or may not apply: the id of this plugin, or of one loaded after it
   * that could share its id, cannot be told from the source ({@link declaredPluginId}).
   */
  | { readonly enabled: undefined; readonly unknownBecause: PluginIdProblem }

/** One plugin OpenCode loads from a config directory, with whether it runs. */
export type OpenCodePluginEntry = OpenCodePlugin & OpenCodeEnablement

/** Where one OpenCode config directory keeps its plugins. */
export interface OpenCodeLocation {
  /** `~/.config/opencode`, or a project's `.opencode`. */
  readonly configDir: string
  /** The `opencode.json(c)` files whose plugin entries apply, lowest precedence first. */
  readonly configFiles: readonly string[]
  /** OpenCode's package cache (`~/.cache/opencode`), where V1 installed npm plugins. */
  readonly cacheDir?: string
}

/** The plugins of one config directory, and the entries that could not be read. */
export interface OpenCodeInventory {
  readonly entries: readonly OpenCodePluginEntry[]
  /** One per configured entry that could not be resolved, naming it; the entry is skipped. */
  readonly warnings: readonly string[]
  /**
   * What of the chain's configuration could not be read (a config file that does not parse, a plugins folder that
   * cannot be listed): while any, a plugin missing from `entries` may only be unreadable.
   */
  readonly unread: readonly string[]
}

/** The plugin folders of a config directory: V2's `plugins`, and V1's `plugin`, which V2 still reads. */
export const OPENCODE_PLUGIN_FOLDERS: readonly string[] = ['plugins', 'plugin']

/** The files OpenCode loads as plugins from a plugins folder. */
const PLUGIN_FILE = /\.(ts|tsx|js|mjs)$/u

/** The config files of a directory, as OpenCode names them. */
export function openCodeConfigFiles(directory: string): string[] {
  return ['opencode.json', 'opencode.jsonc'].map(name => join(directory, name)).filter(isFile)
}

/** Read one `opencode.json` or `opencode.jsonc`. */
export function readOpenCodeConfigFile(path: string): Record<string, unknown> | undefined {
  if (path.endsWith('.json')) return readJsonObject(path)
  const text = readText(path)
  if (text === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(stripJsonc(text))
    return isPlainObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * One plugin entry of a config, as OpenCode reads it (`parse` in its `config/plugin/source.ts`): `-<target>`
 * removes, anything else adds; an add whose target is a plugin id or a selector (`*`, `<prefix>.*`) switches
 * plugins on instead of loading one ({@link openCodeInventory}).
 */
type PluginOperation = { readonly type: 'add' | 'remove'; readonly target: string }

/** The plugin entries of a config, in order: V2 `plugins` (strings or `{ package }`), else V1 `plugin` (strings or `[spec, options]`). */
function configuredOperations(config: Record<string, unknown>): PluginOperation[] {
  const entries = Array.isArray(config['plugins']) ? config['plugins'] : Array.isArray(config['plugin']) ? config['plugin'] : []
  const operations: PluginOperation[] = []
  for (const entry of entries) {
    const spec = typeof entry === 'string' ? entry
      : isPlainObject(entry) && typeof entry['package'] === 'string' ? entry['package']
        : Array.isArray(entry) && typeof entry[0] === 'string' ? entry[0] : undefined
    // A lone `-` names nothing to remove (OpenCode refuses it).
    if (spec === undefined || spec.length === 0 || spec === '-') continue
    operations.push(typeof entry === 'string' && spec.startsWith('-') ? { type: 'remove', target: spec.slice(1) } : { type: 'add', target: spec })
  }
  return operations
}

/** The plugin specs a config loads: its entries that add, not those that switch plugins on or off by id. */
export function configuredPluginSpecs(config: Record<string, unknown>): string[] {
  return configuredOperations(config).flatMap(operation => operation.type === 'add' && !isSelector(operation.target) ? [operation.target] : [])
}

/** Whether a target selects plugins by id pattern rather than naming one: `*`, `<prefix>.*`, or a built-in `opencode.` id. */
function isSelector(target: string): boolean {
  return target === '*' || target.endsWith('.*') || target.startsWith('opencode.')
}

/** Whether a selector matches a plugin id: `*` any, `<prefix>.*` ids starting with `<prefix>.`, else the id itself. */
function matches(selector: string, id: string): boolean {
  if (selector === '*') return true
  return selector.endsWith('.*') ? id.startsWith(selector.slice(0, -1)) : selector === id
}

/**
 * Every plugin `location` loads, each with whether OpenCode runs it, resolved the way OpenCode resolves them
 * (`scan` in `packages/core/src/config/plugin/source.ts` and `resolve` in `packages/core/src/plugin/supervisor.ts`
 * of https://github.com/anomalyco/opencode; documented at https://opencode.ai/docs/plugins/#control):
 *
 * - OpenCode reads its config directories lowest precedence first: the global one, then a project's (`inherited`
 *   are those it reads before `location`). Their plugins folders come first, then the entries of their config
 *   files, in order ("Plugin arrays from applicable config files are applied from lowest to highest precedence").
 * - Each entry is processed in order. `-<id>` switches off the plugins loaded so far whose id it matches; `*`
 *   matches every id, `<prefix>.*` the ids starting with `<prefix>.`. An entry that matches the id of a plugin
 *   loaded so far, or is a selector, switches the matching plugins on again ("A later ID re-enables a plugin");
 *   any other entry loads a plugin, on.
 * - A plugin's id is what its server part declares ({@link declaredPluginId}). Whether an entry applies to a plugin
 *   whose id cannot be told is not guessed: `*` and `-*` apply to every plugin, but after any other entry that
 *   could switch it, by id or by loading a plugin that could share its id, its state is unknown, with why.
 *
 * Only `location`'s own plugins are returned. A configured entry that cannot be resolved is skipped, with a warning
 * when it is `location`'s.
 */
export function openCodeInventory(location: OpenCodeLocation, inherited: readonly OpenCodeLocation[] = []): OpenCodeInventory {
  type State = OpenCodeEnablement
  interface Loaded { readonly entry: OpenCodePlugin; readonly id: PluginIdRead; readonly owner: OpenCodeLocation; state: State }
  const loaded = new Map<string, Loaded>()
  const warnings: string[] = []
  const unread: string[] = []
  const on: State = { enabled: true }
  const off: State = { enabled: false }
  /** An entry that might switch `plugin` to `to`, as `because` says: it does not change a state already `to`. */
  const perhaps = (plugin: Loaded, to: boolean, because: PluginIdProblem): void => {
    if (plugin.state.enabled !== to) plugin.state = { enabled: undefined, unknownBecause: because }
  }
  /** Switch the plugins `target` selects to `to`: surely those whose id it matches, perhaps those whose id is not known. */
  const select = (target: string, to: boolean): Loaded[] => {
    const selected: Loaded[] = []
    for (const plugin of loaded.values()) {
      if ('id' in plugin.id) {
        if (!matches(target, plugin.id.id)) continue
        plugin.state = to ? on : off
        selected.push(plugin)
      } else if (target === '*') plugin.state = to ? on : off
      else perhaps(plugin, to, plugin.id.problem)
    }
    return selected
  }
  const load = (entry: OpenCodePlugin, owner: OpenCodeLocation): void => {
    const key = entry.kind === 'file' ? entry.path : entry.kind === 'package' ? entry.root : `spec:${entry.spec}`
    const plugin = loaded.get(key) ?? { entry, id: pluginIdOf(entry), owner, state: on }
    loaded.set(key, plugin)
    plugin.state = on
    // Loading a plugin switches on its id: every plugin that shares it, and perhaps one whose id is not known.
    for (const other of loaded.values()) {
      if (other === plugin) continue
      const problem = 'id' in other.id ? ('id' in plugin.id ? undefined : plugin.id.problem) : other.id.problem
      if (problem !== undefined) perhaps(other, true, problem)
      else if (idOf(other) === idOf(plugin)) other.state = on
    }
  }
  const idOf = (plugin: Loaded): string | undefined => 'id' in plugin.id ? plugin.id.id : undefined
  const chain = [...inherited, location]
  for (const owner of chain) for (const entry of folderPlugins(owner.configDir, unread)) load(entry, owner)
  for (const owner of chain) {
    for (const file of owner.configFiles) {
      const config = readOpenCodeConfigFile(file)
      if (config === undefined) {
        // Listed because it exists: it does not parse (OpenCode may be writing it). What it configures is not known.
        const problem = `${file} could not be read as OpenCode configuration; its plugin entries are not known`
        unread.push(problem)
        if (owner === location) warnings.push(problem)
        continue
      }
      for (const operation of configuredOperations(config)) {
        if (operation.type === 'remove') {
          select(operation.target, false)
          continue
        }
        const known = [...loaded.values()].some(plugin => 'id' in plugin.id && matches(operation.target, plugin.id.id))
        if (known || isSelector(operation.target)) {
          select(operation.target, true)
          continue
        }
        try {
          load(resolveSpec(operation.target, dirname(file), owner), owner)
        } catch (error: unknown) {
          // Reported once, by the listing of the config directory whose entry it is.
          if (owner === location) warnings.push(`OpenCode plugin entry "${operation.target}" in ${file} cannot be resolved and is skipped: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  }
  const entries = [...loaded.values()]
    .filter(plugin => plugin.owner === location)
    .map(plugin => ({ ...plugin.entry, ...plugin.state }))
  return { entries, warnings, unread }
}

/** The plugins right inside a config directory's plugins folders: files, and package directories with an entry. */
function folderPlugins(configDir: string, unread: string[]): Array<OpenCodePlugin> {
  const out: Array<OpenCodePlugin> = []
  for (const folder of OPENCODE_PLUGIN_FOLDERS) {
    const dir = join(configDir, folder)
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch (error: unknown) {
      // No such folder holds no plugins; one that cannot be listed holds unknown ones.
      const code = (error as { code?: unknown }).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') unread.push(`${dir} could not be listed (${error instanceof Error ? error.message : String(error)})`)
      continue
    }
    for (const name of names.sort((a, b) => a.localeCompare(b, 'en'))) {
      const path = join(dir, name)
      if (isFile(path) && PLUGIN_FILE.test(name)) out.push({ kind: 'file', path })
      else if (isDirectory(path)) {
        const entryPath = pluginEntryOf(path)
        if (entryPath !== undefined) out.push({ kind: 'package', root: path, entryPath })
      }
    }
  }
  return out
}

/**
 * A plugin's id: the one its server entry declares ({@link declaredPluginId}), else, for a package without a server
 * entry, its package name (https://opencode.ai/docs/build/plugins: "A package with a GUI part and no server part
 * takes its package name (or a local directory's name) as its `id`"). An entry with nothing on disk declares none.
 */
function pluginIdOf(entry: OpenCodePlugin): PluginIdRead {
  if (entry.kind === 'unresolved') return { problem: 'missing' }
  const entryPath = entry.kind === 'file' ? entry.path : entry.entryPath
  if (entryPath !== undefined) return declaredPluginId(readText(entryPath) ?? '')
  if (entry.kind !== 'package') return { problem: 'missing' }
  const name = readJsonObject(join(entry.root, 'package.json'))?.['name']
  return { id: typeof name === 'string' ? name : basename(entry.root) }
}

/**
 * A configured spec, resolved as OpenCode resolves it. Throws for a spec no path can be made of (a `file:` URL with
 * a host, outside Windows) and for one that leads to a network share the configuration is not on: on Windows,
 * reading it would sign in to that server.
 */
function resolveSpec(spec: string, base: string, location: OpenCodeLocation): OpenCodePlugin {
  const local = spec.startsWith('file:') ? fileURLToPath(spec.startsWith('file://') ? spec : `file://${resolve(base, spec.slice('file:'.length))}`)
    : spec.startsWith('.') || spec.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(spec) ? resolve(base, spec) : undefined
  if (local !== undefined && (reachesNewShare(spec, base) || contentPath(local, base) === undefined)) throw new Error(`${spec} is on a network share; Harness Forge does not read plugins from one`)
  if (local !== undefined) return isDirectory(local) ? packageAt(local, spec) : { kind: 'unresolved', spec, candidates: [local] }
  const name = packageName(spec)
  if (name === undefined) return { kind: 'unresolved', spec }
  const candidates = [location.configDir, location.cacheDir]
    .filter((dir): dir is string => dir !== undefined)
    .map(dir => join(dir, 'node_modules', ...name.split('/')))
  const installed = candidates.find(dir => isFile(join(dir, 'package.json')))
  return installed !== undefined ? packageAt(installed, spec) : { kind: 'unresolved', spec, candidates }
}

function packageAt(root: string, spec: string): OpenCodePlugin {
  const entryPath = pluginEntryOf(root)
  return { kind: 'package', root, spec, ...(entryPath !== undefined ? { entryPath } : {}) }
}

/** The npm package name of a spec (`name`, `name@1.2.0`, `@scope/name@^1`); undefined for git and URL specs. */
export function packageName(spec: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/iu.test(spec)) return undefined
  const match = /^((?:@[^/@\s]+\/)?[^/@\s]+)(?:@[^\s]*)?$/u.exec(spec)
  return match?.[1]
}

/**
 * A plugin package's server entry, as OpenCode loads it: `exports` `./server`
 * or `.`, else `main`/`module`, else `server` or `index` at its root. A
 * source checkout whose build output is absent runs from its TypeScript
 * source (`dist/x.js` → `src/x.ts` or `x.ts`), as Bun runs it.
 */
export function pluginEntryOf(directory: string): string | undefined {
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
    // A field of the package's own `package.json`: checked against the package's folder (see `contentPath`).
    const resolved = contentPath(target, directory)
    if (resolved === undefined) continue
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
