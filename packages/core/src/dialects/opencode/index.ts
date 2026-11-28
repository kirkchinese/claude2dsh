/**
 * The OpenCode dialect: projects with `opencode.json(c)` and npm packages
 * built on OpenCode's plugin API. What OpenCode itself loads globally is read
 * through one inventory (`inventory.ts`): the plugin files of the global
 * plugins folder are the person's own (`opencode:user`), and each plugin
 * package (a directory in a plugins folder, a configured local directory, an
 * npm package OpenCode installed) is a plugin of its own.
 * @module @kirkchinese/harness-forge-core
 */
import { dirname, join, resolve } from 'node:path'
import { isFile, readJsonObject } from '../../paths.js'
import type { Dialect } from '../types.js'
import { openCodeConfigFiles, openCodeInventory } from './inventory.js'
import { openCodeCacheDir, openCodeConfigDir, openCodeGlobalLocation, openCodeUserEnablement, scanOpenCodeProject, scanOpenCodeUser } from './scan.js'

const isOpenCodeRoot = (directory: string): boolean =>
  isFile(join(directory, 'opencode.json')) || isFile(join(directory, 'opencode.jsonc')) || isOpenCodePackage(directory)

/** The plugins folders discovery lists: the global one, and `~/.opencode/plugins` (the `.opencode` of a session in the home folder). */
const pluginFolders = (home: string): string[] => [join(openCodeConfigDir(home), 'plugins'), join(home, '.opencode', 'plugins')]

export const openCodeDialect: Dialect = {
  id: 'opencode',
  label: 'OpenCode',
  markers: [{ tier: 'manifest', test: isOpenCodeRoot }],
  scan: (root, options) => scanOpenCodeProject(root, options).plugin,
  discoveryRoots: pluginFolders,
  user: {
    root: home => openCodeConfigDir(home),
    anchor: home => join(openCodeConfigDir(home), 'plugins'),
    scan: home => scanOpenCodeUser(home),
    enablement: home => openCodeUserEnablement(home),
    emptyMessage: 'holds no OpenCode plugin files in plugins/ or plugin/',
  },
  harnessPlugins: {
    roots: pluginFolders,
    // The packages a config directory loads (see `inventory.ts`); its plugin files are the person's own assets.
    // Each with whether OpenCode runs it: `~/.opencode` is read after the global config, which can switch its plugins off.
    list: (home, root) => {
      const configDir = dirname(root)
      const global = openCodeGlobalLocation(home)
      const inventory = resolve(configDir) === resolve(global.configDir)
        ? openCodeInventory(global)
        : openCodeInventory({ configDir, configFiles: openCodeConfigFiles(configDir), cacheDir: openCodeCacheDir(home) }, [global])
      return {
        entries: inventory.entries.flatMap(entry => entry.kind === 'package' && entry.entryPath !== undefined ? [{ root: entry.root, key: resolve(entry.root), ...(entry.enabled !== undefined ? { enabled: entry.enabled } : { enabledUnknown: entry.unknownBecause }) }] : []),
        // A configured package not on disk is still configured: each folder it would be in stays installed. One no folder
        // can be named for (a git spec) could be any installed folder, so the read is not complete.
        unresolved: inventory.entries.flatMap(entry => entry.kind === 'unresolved' ? (entry.candidates ?? []).map(candidate => ({ key: resolve(candidate), message: `OpenCode configures ${entry.spec}, which is not installed at ${candidate}` })) : []),
        unread: [
          ...inventory.unread,
          ...inventory.warnings.filter(warning => !inventory.unread.includes(warning)),
          ...inventory.entries.flatMap(entry => entry.kind === 'unresolved' && entry.candidates === undefined ? [`OpenCode configures ${entry.spec}, which names no folder Harness Forge can find`] : []),
        ],
      }
    },
  },
}

function isOpenCodePackage(directory: string): boolean {
  const packageJson = readJsonObject(join(directory, 'package.json'))
  if (packageJson === undefined) return false
  const dependencies = [packageJson['dependencies'], packageJson['peerDependencies'], packageJson['devDependencies']]
    .filter((value): value is Record<string, unknown> => typeof value === 'object' && value !== null)
  return dependencies.some(value => '@opencode-ai/plugin' in value || '@opencode/plugin' in value)
}
