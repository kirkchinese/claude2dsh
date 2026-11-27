/**
 * The OpenCode dialect: projects with `opencode.json(c)` and npm packages
 * built on OpenCode's plugin API.
 * @module @kirkchinese/harness-forge-core
 */
import { join } from 'node:path'
import { isFile, readJsonObject } from '../../paths.js'
import type { Dialect } from '../types.js'
import { scanOpenCodeProject } from './scan.js'

export const openCodeDialect: Dialect = {
  id: 'opencode',
  label: 'OpenCode',
  markers: [{
    tier: 'manifest',
    test: directory => isFile(join(directory, 'opencode.json')) || isFile(join(directory, 'opencode.jsonc')) || isOpenCodePackage(directory),
  }],
  scan: (root, options) => scanOpenCodeProject(root, options).plugin,
  discoveryRoots: home => [join(home, '.config', 'opencode', 'plugins'), join(home, '.opencode', 'plugins')],
}

function isOpenCodePackage(directory: string): boolean {
  const packageJson = readJsonObject(join(directory, 'package.json'))
  if (packageJson === undefined) return false
  const dependencies = [packageJson['dependencies'], packageJson['peerDependencies'], packageJson['devDependencies']]
    .filter((value): value is Record<string, unknown> => typeof value === 'object' && value !== null)
  return dependencies.some(value => '@opencode-ai/plugin' in value || '@opencode/plugin' in value)
}
