/**
 * The portable Agent Plugins format: a root `plugin.json` with the
 * agent-plugins.org schema. It is the fallback for a folder no harness claims.
 * @module @kirkchinese/harness-forge-core
 */
import { join } from 'node:path'
import { scanPlugin } from '../../manifest.js'
import { isFile } from '../../paths.js'
import type { Dialect } from '../types.js'

export const agentPluginsDialect: Dialect = {
  id: 'agent-plugins',
  label: 'Agent Plugins',
  markers: [{ tier: 'fallback', test: directory => isFile(join(directory, 'plugin.json')) }],
  scan: (root, options) => scanPlugin(root, { source: 'agent-plugins', ...options }).plugin,
}
