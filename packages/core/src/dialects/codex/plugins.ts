/**
 * The plugins Codex has installed and the marketplaces it added, read the way
 * Codex records them (https://developers.openai.com/plugins/build/plugins):
 * an installed plugin has a `[plugins."<name>@<marketplace>"]` entry in
 * `config.toml` (enabled or not) and its files in
 * `plugins/cache/<marketplace>/<name>/<version>/`. The cache also holds
 * plugins a marketplace offers that the person never installed; those are not
 * listed.
 * @module @kirkchinese/harness-forge-core
 */
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDirectory, isFile, isPlainObject, LEADS_TO_SHARE, leadsToShare } from '../../paths.js'
import type { HarnessMarketplace, HarnessPluginEntry, HarnessPluginList, UnresolvedHarnessPlugin } from '../types.js'
import { codexHome, readCodexConfig, readCodexConfigRecord } from './user-assets.js'

/**
 * The plugins `config.toml` lists, each at the cached version Codex loads. A listed plugin with no cached version is
 * `unresolved` (still installed); a `config.toml` that does not parse, or a cache folder that cannot be listed, is
 * `unread`, never "nothing installed".
 */
export function installedCodexPlugins(home = homedir()): HarnessPluginList {
  const root = codexHome(home)
  const config = readCodexConfigRecord(root)
  const unread: string[] = config.problem === undefined ? [] : [config.problem]
  const plugins = config.value?.['plugins']
  if (plugins !== undefined && !isPlainObject(plugins)) unread.push(`${join(root, 'config.toml')}: "plugins" is not a table`)
  const listed = isPlainObject(plugins) ? plugins : {}
  const entries: HarnessPluginEntry[] = []
  const unresolved: UnresolvedHarnessPlugin[] = []
  for (const [key, value] of Object.entries(listed)) {
    const at = key.lastIndexOf('@')
    if (at <= 0 || at === key.length - 1) continue
    const name = key.slice(0, at)
    const marketplace = key.slice(at + 1)
    const dir = join(root, 'plugins', 'cache', marketplace, name)
    const version = cachedVersion(dir)
    if (typeof version !== 'string') {
      if ('unread' in version) unread.push(version.unread)
      else unresolved.push({ key, message: `Codex lists ${key}, but ${dir} holds no version of it` })
      continue
    }
    entries.push({ root: version, key, enabled: !(isPlainObject(value) && value['enabled'] === false), marketplace })
  }
  return { entries, unresolved, unread }
}

/**
 * The `<name>@<marketplace>` a folder of Codex's cache (`plugins/cache/<marketplace>/<name>/<version>`) is a version
 * of, listed or not.
 */
export function codexInstallKey(root: string, home = homedir()): string | undefined {
  const parts = cachePath(join(codexHome(home), 'plugins', 'cache'), root)
  return parts?.length === 3 ? `${parts[1]!}@${parts[0]!}` : undefined
}

/** The folders from `cache` down to `root`, when `root` is below it. */
export function cachePath(cache: string, root: string): string[] | undefined {
  const path = relative(resolve(cache), resolve(root))
  if (path.length === 0 || path.startsWith('..') || isAbsolute(path)) return undefined
  return path.split(sep)
}

/**
 * The version folder Codex loads: `local` for a local plugin, else the newest
 * one. A `latest` link to one of them is not a version of its own. `none` when
 * the plugin's folder is missing or empty; `unread` when it cannot be listed.
 */
function cachedVersion(dir: string): string | { readonly none: true } | { readonly unread: string } {
  let entries
  if (leadsToShare(dir)) return { unread: `${dir} could not be listed (${LEADS_TO_SHARE})` }
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error: unknown) {
    const code = (error as { code?: unknown }).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { none: true }
    return { unread: `${dir} could not be listed (${error instanceof Error ? error.message : String(error)})` }
  }
  const versions = entries.filter(entry => entry.isDirectory()).map(entry => join(dir, entry.name))
  const local = versions.find(path => basename(path) === 'local')
  if (local !== undefined) return resolve(local)
  const newest = versions
    .map(path => ({ path, time: modified(path) }))
    .sort((a, b) => b.time - a.time || b.path.localeCompare(a.path, 'en'))[0]
  return newest === undefined ? { none: true } : resolve(newest.path)
}

function modified(path: string): number {
  if (leadsToShare(path)) return 0
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/** The local marketplaces `config.toml` adds (`[marketplaces.<name>]` with a local `source`). */
export function codexMarketplaces(home = homedir()): HarnessMarketplace[] {
  const config = readCodexConfig(codexHome(home))
  const listed = isPlainObject(config['marketplaces']) ? config['marketplaces'] : {}
  const out: HarnessMarketplace[] = []
  for (const [name, value] of Object.entries(listed)) {
    if (!isPlainObject(value) || typeof value['source'] !== 'string') continue
    if (value['source_type'] !== undefined && value['source_type'] !== 'local') continue
    const root = resolve(value['source'])
    if (!isDirectory(root)) continue
    if (!isFile(join(root, '.agents', 'plugins', 'marketplace.json')) && !isFile(join(root, '.claude-plugin', 'marketplace.json'))) continue
    out.push({ name, root })
  }
  return out
}
