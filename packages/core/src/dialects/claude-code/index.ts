/**
 * The Claude Code dialect: `.claude-plugin/plugin.json` plugins (or the bare
 * plugin layout), the user's `~/.claude`, project `.claude/` directories, the
 * plugins Claude Code has installed and the marketplaces it added, and its
 * transcripts.
 * @module @kirkchinese/harness-forge-core
 */
import { join, resolve } from 'node:path'
import { cachePath } from '../codex/plugins.js'
import { hasLayoutDirectory, scanPlugin } from '../../manifest.js'
import { isFile, readJsonObject } from '../../paths.js'
import type { Dialect, HarnessMarketplace } from '../types.js'
import { installedClaudePlugins, isGlobalClaudeInstall, scanClaudeProjectAssets, scanClaudeUserAssets } from './user-assets.js'
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
    roots: home => [join(home, '.claude', 'plugins')],
    // A project- or local-scope install only loads in its project's sessions, so it is not one of the person's
    // plugins everywhere: discovery and "Migrate all" leave it out (see docs/user/compatibility.md).
    list: (home) => {
      const installed = installedClaudePlugins(home)
      return {
        entries: installed.plugins.filter(isGlobalClaudeInstall).map(plugin => ({ root: plugin.root, key: plugin.key, enabled: plugin.enabled, marketplace: plugin.marketplace })),
        unresolved: installed.unresolved.filter(isGlobalClaudeInstall).map(({ key, message }) => ({ key, message })),
        unread: installed.unread,
      }
    },
    marketplaces: home => claudeMarketplaces(home),
    identify: (home, root, name) => claudeInstallKey(home, root, name),
  },
  projectAssets: (cwd, home) => scanClaudeProjectAssets(cwd, home),
  sessions: claudeCodeAdapter,
}

/** The marketplaces Claude Code has added (`known_marketplaces.json`) whose local copy lists plugins. */
function claudeMarketplaces(home: string): HarnessMarketplace[] {
  const known = readJsonObject(join(home, '.claude', 'plugins', 'known_marketplaces.json')) ?? {}
  const out: HarnessMarketplace[] = []
  for (const [name, entry] of Object.entries(known)) {
    const location = typeof entry === 'object' && entry !== null ? (entry as { installLocation?: unknown }).installLocation : undefined
    if (typeof location !== 'string' || !isFile(join(location, '.claude-plugin', 'marketplace.json'))) continue
    out.push({ name, root: resolve(location) })
  }
  return out
}

/**
 * The `<name>@<marketplace>` a folder of Claude Code's own layout stands for: a version in its install cache
 * (`plugins/cache/<marketplace>/<name>/<version>`), or a plugin inside a marketplace's local copy
 * (`plugins/marketplaces/<marketplace>/…`, what Harness Forge 0.4.0 also migrated as an offer).
 */
function claudeInstallKey(home: string, root: string, name: string): string | undefined {
  const plugins = join(home, '.claude', 'plugins')
  const cached = cachePath(join(plugins, 'cache'), root)
  if (cached?.length === 3) return `${cached[1]!}@${cached[0]!}`
  const offered = cachePath(join(plugins, 'marketplaces'), root)
  return offered !== undefined && offered.length >= 2 ? `${name}@${offered[0]!}` : undefined
}
