/**
 * The Codex dialect: `.codex-plugin/plugin.json` plugins (merged over a
 * portable root `plugin.json`), the user's `$CODEX_HOME` and project
 * `.codex/` directories, and the plugins Codex has installed (see `plugins.ts`).
 * @module @kirkchinese/harness-forge-core
 */
import { join } from 'node:path'
import { scanPlugin } from '../../manifest.js'
import { isFile } from '../../paths.js'
import type { Dialect } from '../types.js'
import { codexHome, scanCodexProjectAssets, scanCodexUserAssets } from './user-assets.js'
import { codexInstallKey, codexMarketplaces, installedCodexPlugins } from './plugins.js'

export const codexDialect: Dialect = {
  id: 'codex',
  label: 'Codex',
  markers: [{ tier: 'manifest', test: directory => isFile(join(directory, '.codex-plugin', 'plugin.json')) }],
  scan: (root, options) => scanPlugin(root, { source: 'codex', ...options }).plugin,
  discoveryRoots: home => [join(home, '.codex', 'plugins')],
  user: {
    root: home => codexHome(home),
    anchor: home => join(home, '.codex', 'plugins'),
    scan: home => scanCodexUserAssets(home),
    emptyMessage: 'holds no Codex skills, prompts, MCP servers, rules or instructions',
  },
  harnessPlugins: {
    roots: home => [join(home, '.codex', 'plugins')],
    list: home => installedCodexPlugins(home),
    marketplaces: home => codexMarketplaces(home),
    identify: (home, root) => codexInstallKey(root, home),
  },
  projectAssets: (cwd, home) => scanCodexProjectAssets(cwd, home),
}
