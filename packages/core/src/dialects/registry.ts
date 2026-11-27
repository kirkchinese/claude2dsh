/**
 * The dialect registry. Built in, in detection order: Claude Code, Codex,
 * OpenCode, then the common formats (Agent Plugins, Agent Skills). A
 * community dialect is added with {@link registerDialect}.
 * @module @kirkchinese/harness-forge-core
 */
import { scanPlugin } from '../manifest.js'
import type { ForeignPlugin, SourceId } from '../types.js'
import type { Dialect, DialectMarker } from './types.js'
import { claudeCodeDialect } from './claude-code/index.js'
import { codexDialect } from './codex/index.js'
import { openCodeDialect } from './opencode/index.js'
import { agentPluginsDialect } from './agent-plugins/index.js'
import { agentSkillsDialect } from './agent-skills/index.js'

const registry: Dialect[] = [claudeCodeDialect, codexDialect, openCodeDialect, agentPluginsDialect, agentSkillsDialect]

/** The source a folder no dialect claims is read as. */
export const FALLBACK_SOURCE: SourceId = 'agent-plugins'

const TIERS: ReadonlyArray<DialectMarker['tier']> = ['manifest', 'layout', 'fallback']

/**
 * Add a dialect. It is checked after the built-in dialects of each tier, so
 * it cannot take a folder a built-in dialect claims more strongly.
 * @returns a function that removes it again.
 */
export function registerDialect(dialect: Dialect): () => void {
  if (registry.some(known => known.id === dialect.id)) throw new Error(`dialect ${dialect.id} is already registered`)
  registry.push(dialect)
  return () => {
    const index = registry.indexOf(dialect)
    if (index >= 0) registry.splice(index, 1)
  }
}

/** Every registered dialect, in detection order. */
export function dialects(): readonly Dialect[] {
  return [...registry]
}

/** The dialect with this id. */
export function dialectOf(id: SourceId): Dialect | undefined {
  return registry.find(dialect => dialect.id === id)
}

/** The ids of every registered dialect. */
export function dialectIds(): SourceId[] {
  return registry.map(dialect => dialect.id)
}

/**
 * The dialect a folder speaks: the first match of the strongest tier, in
 * registry order; the fallback format when nothing matches.
 * @param listed - whether the user listed this folder, so markers that only count there do.
 */
export function detectDialect(directory: string, listed = true): Dialect | undefined {
  for (const tier of TIERS) {
    for (const dialect of registry) {
      if (dialect.markers.some(marker => marker.tier === tier && (listed || marker.listedOnly !== true) && marker.test(directory))) return dialect
    }
  }
  return undefined
}

/** Whether discovery stops at this folder as a plugin root. */
export function isPluginRoot(directory: string, listed: boolean): boolean {
  return registry.some(dialect => dialect.markers.some(marker => marker.pluginRoot !== false && (listed || marker.listedOnly !== true) && marker.test(directory)))
}

/**
 * Read a plugin root through the dialect it speaks, or through `source` to
 * read a multi-harness root as one of them. A source no dialect registers is
 * read with the shared plugin scanner under that id.
 */
export function scanRoot(root: string, source?: SourceId, options: { readonly name?: string } = {}): ForeignPlugin {
  const dialect = source !== undefined ? dialectOf(source) : detectDialect(root)
  if (dialect !== undefined) return dialect.scan(root, options)
  return scanPlugin(root, { source: source ?? FALLBACK_SOURCE, ...options }).plugin
}
