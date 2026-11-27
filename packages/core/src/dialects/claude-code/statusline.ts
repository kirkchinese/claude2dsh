import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { childId } from '../../naming.js'
import { isFile, isInside, isPlainObject, readJsonObject, realOrLexical } from '../../paths.js'
import type { ForeignPlugin, UiComponent } from '../../types.js'

/** A settings entry that configures a Claude Code plugin's status line. */
export interface ClaudeStatusLineProvider {
  readonly plugin: ForeignPlugin
  readonly component: UiComponent
}

/** Read a direct executable or interpreter + script without running any shell code. */
function commandFile(command: string, home: string): string | undefined {
  // Keep quoted paths whole; don't scan later arguments for something that merely looks like a plugin file.
  const words = command.trim().match(/(?:"[^"]*"|'[^']*'|\\[^\r\n]|[^\s"'\\;&|<>])+/gu)
    ?.map(word => word.replace(/"([^"]*)"|'([^']*)'|\\([ \t])/gu, (_match, double: string | undefined, single: string | undefined, escaped: string | undefined) => double ?? single ?? escaped ?? '')) ?? []
  while (/^\w+=/u.test(words[0] ?? '')) words.shift()
  if (words[0] !== undefined && basename(words[0]) === 'env') {
    words.shift()
    while (/^\w+=/u.test(words[0] ?? '')) words.shift()
  }
  const first = words[0]
  if (first === undefined) return undefined
  const runner = /^(?:node(?:js)?|bun|deno|bash|sh|zsh|python(?:\d(?:\.\d+)?)?|ruby|perl)(?:\.exe)?$/u.test(basename(first))
  const word = words[runner ? (words[1] === '--' || (words[1] === 'run' && /^(?:bun|deno)$/u.test(basename(first))) ? 2 : 1) : 0]
  if (word === undefined) return undefined
  const path = word.replace(/^(?:~|\$HOME|\$\{HOME\})(?=[\\/])/u, home)
  return isAbsolute(path) && isFile(path) ? path : undefined
}

/** Locate the owner among the plugins Forge actually discovered, not arbitrary cache entries. */
export function claudeStatusLineProvider(command: string, plugins: readonly ForeignPlugin[], home: string): ClaudeStatusLineProvider | undefined {
  const file = commandFile(command, home)
  if (file === undefined) return undefined
  const claudePlugins = plugins.filter(plugin => plugin.source === 'claude-code' && plugin.manifest['scope'] !== 'user' && plugin.manifest['scope'] !== 'project')
  const index = readJsonObject(join(home, '.claude', 'plugins', 'installed_plugins.json'))?.['plugins']
  const installed = isPlainObject(index) ? Object.entries(index) : []
  const realFile = realOrLexical(file)
  // Prefer the deepest root when discovered directories overlap.
  const matches = claudePlugins.flatMap(plugin => {
    const roots = [plugin.root]
    for (const [key, records] of installed) {
      if (!Array.isArray(records)) continue
      const paths = records.flatMap(record => isPlainObject(record) && typeof record['installPath'] === 'string' && isAbsolute(record['installPath']) ? [record['installPath']] : [])
      if (!paths.some(path => realOrLexical(path) === realOrLexical(plugin.root))) continue
      roots.push(...paths)
      const [name, market] = key.split('@')
      const segment = (value: string | undefined): value is string => value !== undefined && value !== '' && value !== '.' && value !== '..' && !/[\\/]/u.test(value)
      if (segment(name) && segment(market)) roots.push(join(home, '.claude', 'plugins', 'cache', market, name))
    }
    const depth = Math.max(0, ...roots.filter(root => isInside(root, file) || isInside(realOrLexical(root), realFile)).map(root => root.length))
    return depth === 0 ? [] : [{ plugin, depth }]
  }).sort((a, b) => b.depth - a.depth)
  const plugin = matches[0]?.plugin
  if (plugin === undefined) return undefined
  const declared = plugin.components.find((part): part is UiComponent => part.kind === 'ui' && part.surface === 'statusline')
  const component: UiComponent = declared ?? {
    id: childId(plugin.id, 'ui', 'statusline'),
    kind: 'ui',
    surface: 'statusline',
    name: 'statusline',
    specPath: file,
    ...(isInside(plugin.root, file) ? { path: relative(plugin.root, file).split(sep).join('/') } : {}),
    description: 'status line configured in Claude Code settings',
  }
  return { plugin, component }
}

export function claudeSettingsStatusLine(plugin: ForeignPlugin): { readonly component: UiComponent; readonly command: string } | undefined {
  if (plugin.source !== 'claude-code' || plugin.manifest['scope'] !== 'user') return undefined
  const component = plugin.components.find((part): part is UiComponent => part.kind === 'ui' && part.name === 'statusline-settings' && part.surface === 'statusline')
  const spec = component?.metadata?.['statusLine']
  return component !== undefined && isPlainObject(spec) && typeof spec['command'] === 'string' ? { component, command: spec['command'] } : undefined
}
