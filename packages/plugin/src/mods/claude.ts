/**
 * Claude Code mods: an imported hooks module is bundled once, scanned as
 * Claude Code scans it, and handed to the mods service, which loads it into
 * every session's engine.
 * @module @kirkchinese/harness-forge
 */
import type { CodeComponent, ForeignPlugin } from '@kirkchinese/harness-forge-core'
import { bundleModule, scanBundleRefusal, scanBundleUses, type Bundler } from './loader.js'
import type { PluginTier } from './chain.js'
import type { ModsService } from './service.js'

/** The mods Claude Code builds in, by name: they sit where it seats them. */
const BUILT_IN_MODS = new Set(['diff', 'privacy', 'agents-md', 'telemetry'])

/**
 * Where a mod sits in the chain. Claude Code's own mods (Anthropic's, by the
 * names it ships) sit where Claude Code seats them: the guard outermost, the
 * others built in; every other mod is the person's.
 */
export function modTier(plugin: ForeignPlugin): PluginTier {
  const author = plugin.manifest['author']
  const authorName = typeof author === 'string' ? author : typeof author === 'object' && author !== null ? (author as { name?: unknown }).name : undefined
  const isAnthropic = typeof authorName === 'string' && /^anthropic$/iu.test(authorName.trim())
  if (isAnthropic && plugin.name === 'sec-default') return 'prepend'
  if (isAnthropic && BUILT_IN_MODS.has(plugin.name)) return 'builtin'
  return 'user'
}

/** The defaults the manifest's `userConfig` declares, as `register(on, options)` receives them. */
function optionsOf(plugin: ForeignPlugin): Record<string, unknown> {
  const config = plugin.manifest['userConfig']
  const options: Record<string, unknown> = {}
  if (typeof config !== 'object' || config === null) return options
  for (const [key, field] of Object.entries(config as Record<string, unknown>)) {
    if (typeof field === 'object' && field !== null && (field as { default?: unknown }).default !== undefined) options[key] = (field as { default: unknown }).default
  }
  return options
}

/** One loaded Claude mod. */
export interface ClaudeModMount {
  readonly name: string
  readonly tier: PluginTier
  readonly dispose: () => Promise<void>
}

/**
 * Bundle a mod's hooks module and add it to every session.
 * @param bundler - the bundler, which may still have to be installed (see `bundler.ts`).
 */
export async function mountClaudeMod(mods: ModsService, component: CodeComponent, plugin: ForeignPlugin, bundler: () => Promise<Bundler>): Promise<ClaudeModMount> {
  if (component.entryPath === undefined) throw new Error(`code component "${component.name}" has no entry path`)
  const tools = await bundler()
  const bundle = await bundleModule(component.entryPath, tools)
  const refusal = scanBundleRefusal(bundle, tools.parseAst)
  const tier = modTier(plugin)
  const version = typeof plugin.manifest['version'] === 'string' ? plugin.manifest['version'] : undefined
  const dispose = await mods.add({
    componentId: component.id,
    name: plugin.name,
    tier,
    root: plugin.root,
    bundle,
    options: optionsOf(plugin),
    uses: scanBundleUses(bundle),
    provenance: `${plugin.name}@${tier === 'user' ? 'harness-forge' : 'builtin'}`,
    ...(version !== undefined ? { version } : {}),
    ...(refusal !== undefined ? { refusal } : {}),
  })
  return { name: plugin.name, tier, dispose }
}
