/**
 * The Claude Code dialect: `.claude-plugin/plugin.json` plugins (or the bare
 * plugin layout), the user's `~/.claude`, project `.claude/` directories, the
 * plugins and marketplaces Claude Code records, and its transcripts.
 * @module @kirkchinese/harness-forge-core
 */
import { join, resolve } from 'node:path'
import { hasLayoutDirectory, scanPlugin } from '../../manifest.js'
import { isDirectory, isFile, readJsonObject } from '../../paths.js'
import type { Dialect, HarnessPluginEntry } from '../types.js'
import { installedClaudePlugins, scanClaudeProjectAssets, scanClaudeUserAssets } from './user-assets.js'
import { claudeCodeAdapter } from './sessions/adapter.js'

export const claudeCodeDialect: Dialect = {
  id: 'claude-code',
  label: 'Claude Code',
  markers: [
    { tier: 'manifest', test: directory => isFile(join(directory, '.claude-plugin', 'plugin.json')) },
    {
      tier: 'layout',
      pluginRoot: false,
      test: directory => hasLayoutDirectory(directory, ['skills', 'commands', 'agents', 'hooks']) || isFile(join(directory, '.mcp.json')),
    },
  ],
  scan: (root, options) => scanPlugin(root, { source: 'claude-code', ...options }).plugin,
  discoveryRoots: home => [join(home, '.claude', 'plugins')],
  user: {
    root: home => join(home, '.claude'),
    anchor: home => join(home, '.claude', 'plugins'),
    scan: home => scanClaudeUserAssets(home),
    emptyMessage: 'holds no Claude Code skills, agents, commands, settings or MCP servers',
  },
  harnessPlugins: {
    root: home => join(home, '.claude', 'plugins'),
    list: home => claudeHarnessPlugins(home),
  },
  projectAssets: (cwd, home) => scanClaudeProjectAssets(cwd, home),
  sessions: claudeCodeAdapter,
}

/**
 * Claude Code's plugin directory read the way Claude Code reads it: the
 * installed plugins of `installed_plugins.json` (one version each) and the
 * plugins its added marketplaces offer, instead of every cached version.
 */
function claudeHarnessPlugins(home: string): HarnessPluginEntry[] {
  const out: HarnessPluginEntry[] = []
  const installed = installedClaudePlugins(home)
  const installedKeys = new Set(installed.map(plugin => plugin.key))
  for (const plugin of installed) out.push({ root: plugin.root, origin: 'installed', enabled: plugin.enabled, marketplace: plugin.marketplace })
  for (const offer of claudeMarketplaceOffers(home)) {
    if (installedKeys.has(`${offer.name}@${offer.marketplace}`)) continue
    out.push({ root: offer.root, origin: 'marketplace', marketplace: offer.marketplace })
  }
  return out
}

/** Plugins listed by the marketplaces Claude Code has added, with a local copy. */
function claudeMarketplaceOffers(home: string): Array<{ name: string; marketplace: string; root: string }> {
  const known = readJsonObject(join(home, '.claude', 'plugins', 'known_marketplaces.json')) ?? {}
  const out: Array<{ name: string; marketplace: string; root: string }> = []
  for (const [marketplace, entry] of Object.entries(known)) {
    const location = typeof entry === 'object' && entry !== null ? (entry as { installLocation?: unknown }).installLocation : undefined
    if (typeof location !== 'string' || !isDirectory(location)) continue
    const manifest = readJsonObject(join(location, '.claude-plugin', 'marketplace.json'))
    const listed = Array.isArray(manifest?.['plugins']) ? manifest['plugins'] : []
    for (const item of listed) {
      if (typeof item !== 'object' || item === null) continue
      const { name, source } = item as { name?: unknown; source?: unknown }
      if (typeof name !== 'string' || typeof source !== 'string') continue
      const root = resolve(location, source)
      if (isDirectory(root)) out.push({ name, marketplace, root })
    }
  }
  return out
}
