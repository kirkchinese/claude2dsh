/**
 * The workbench's read side: settings, discovery, capabilities and context
 * cost, the overview and diagnostics, and migrating a whole harness. It keeps
 * no state; the workbench row and the `/harness` command both read through it.
 * @module @kirkchinese/harness-forge
 */
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { assess, claudeSettingsStatusLine, claudeStatusLineProvider, discoverPlugins, pluginId, type CompatibilityVector, type DiscoveredPlugin, type ForeignPlugin, type Gap } from '@kirkchinese/harness-forge-core'
import { itemOf, overviewOf, unreadableItemOf, type AdapterCoverage, type Overview, type OverviewItem } from './overview.js'
import { adapterCoverage, enabledAdapters, type PluginManagerLike } from './adapter-coverage.js'
import { readSettings, writeSettings, type HarnessSettings } from './settings.js'
import { messageOf } from '../shared/util.js'
import { dshService, type DshService } from '../dsh/host.js'
import type { HarnessForge } from '../forge/service.js'
import type { InstalledPluginRecord } from '../forge/state.js'
import { findBun } from '../opencode/bun.js'

/** A package's version as this process resolves it, if it resolves. */
function versionOf(specifier: string): string | undefined {
  try {
    return (createRequire(import.meta.url)(specifier) as { version?: string }).version
  } catch {
    return undefined
  }
}

/** One component exposed by an installed plugin. */
export interface CapabilityItem {
  readonly pluginId: string
  readonly pluginName: string
  readonly kind: string
  readonly name: string
  readonly description?: string
  readonly source: string
}

/** Per-plugin capability summary. */
export interface PluginCapabilities {
  readonly pluginId: string
  readonly name: string
  readonly source: string
  readonly items: readonly CapabilityItem[]
  readonly compat: CompatibilityVector
  readonly residentTokens: number
}

/** Aggregate capability and context budget view. */
export interface CapabilityCatalog {
  readonly plugins: readonly PluginCapabilities[]
  readonly totals: Readonly<Record<string, number>>
  readonly residentTokens: number
  readonly toolCount?: number
  readonly toolTokens?: number
  readonly budgetTokens?: number
  readonly overBudget: boolean
  readonly basis: string
}

/** Services the compatibility layer can use when present. */
export interface HostCapabilities {
  readonly skills: boolean
  readonly commands: boolean
  readonly agentPresets: boolean
  readonly shell: boolean
  readonly webServer: boolean
  readonly workingDirectory: boolean
}

/** Read the current host's optional services. */
export function probeHostCapabilities(ctx: Context): HostCapabilities {
  const has = (name: DshService): boolean => dshService(ctx, name) !== undefined
  return {
    skills: has('skills'),
    commands: has('commands'),
    agentPresets: has('agentPresets'),
    shell: has('shell'),
    webServer: has('webServer'),
    workingDirectory: has('workingDirectory'),
  }
}


/** Workbench views over the installations. */
export class Workbench {
  private readonly installs: HarnessForge['ledger']

  constructor(private readonly forge: HarnessForge) {
    this.installs = forge.ledger
  }

  /** Read the persisted workbench settings. */
  settings(): HarnessSettings {
    return readSettings(this.installs.statePath)
  }

  /** Save workbench settings; only known fields are accepted. */
  saveSettings(input: {
    readonly discoveryRoots?: unknown
    readonly autoDiscover?: unknown
    readonly contextBudgetTokens?: unknown
  }): HarnessSettings {
    const current = this.settings()
    const roots = Array.isArray(input.discoveryRoots)
      ? [...new Set(input.discoveryRoots
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          .map(value => resolve(value)))]
      : current.discoveryRoots
    const autoDiscover = typeof input.autoDiscover === 'boolean' ? input.autoDiscover : current.autoDiscover
    const contextBudgetTokens = typeof input.contextBudgetTokens === 'number'
      && Number.isFinite(input.contextBudgetTokens)
      && input.contextBudgetTokens > 0
      ? Math.round(input.contextBudgetTokens)
      : undefined
    const next: HarnessSettings = {
      schemaVersion: 1,
      discoveryRoots: roots.length > 0 ? roots : current.discoveryRoots,
      autoDiscover,
      ...(contextBudgetTokens !== undefined ? { contextBudgetTokens } : {}),
    }
    writeSettings(this.installs.statePath, next)
    return next
  }

  /**
   * A plugin the overview lists, by id, read from disk now, with its gaps:
   * an installed plugin's recorded ones, else those its scan shows.
   */
  findPlugin(id: string): { readonly plugin: ForeignPlugin; readonly gaps: readonly Gap[] } {
    const { scanned, link } = this.overviewSources(id)
    const found = scanned.find(({ plugin }) => plugin.id === id)
    if (found !== undefined) {
      const { plugin, record } = found
      const gaps = record?.compat?.gaps ?? assess(plugin).gaps
      if (link !== undefined && plugin.components.some(part => part.id === link.settingsId)) {
        return { plugin: { ...plugin, components: plugin.components.filter(part => part.id !== link.settingsId) }, gaps: gaps.filter(gap => gap.componentId !== link.settingsId) }
      }
      return { plugin, gaps }
    }
    throw new Error(`no plugin ${id} is installed or discovered`)
  }

  /** Discover plugin roots using the saved settings. */
  discover(): { settings: HarnessSettings; plugins: Array<DiscoveredPlugin & { installed: boolean }>; missingRoots: readonly string[] } {
    const settings = this.settings()
    const result = discoverPlugins(settings.discoveryRoots)
    const installedRoots = new Set([...this.installs.live.values()].map(install => resolve(install.record.root)))
    return {
      settings,
      plugins: result.plugins.map(plugin => ({
        ...plugin,
        installed: installedRoots.has(resolve(plugin.root)) || this.installs.live.has(pluginId(plugin.source, plugin.name)),
      })),
      missingRoots: result.missingRoots,
    }
  }

  /** Aggregate capabilities and context cost for installed plugins. */
  capabilities(): CapabilityCatalog {
    const settings = this.settings()
    const meter = dshService(this.installs.ctx, 'tokenMeter') as { estimateMessage(message: unknown): number } | undefined
    const estimate = (text: string): number => {
      if (meter === undefined) return Math.ceil(text.length / 4)
      try {
        return meter.estimateMessage({ role: 'user', content: [{ type: 'text', text }] })
      } catch {
        return Math.ceil(text.length / 4)
      }
    }
    const plugins: PluginCapabilities[] = []
    const totals: Record<string, number> = {}
    let residentTokens = 0
    for (const install of this.installs.live.values()) {
      const plugin = this.installs.scanRoot(install.record.root, install.record.source)
      const compat = assess(plugin, [...install.outcomes.values()])
      const items: CapabilityItem[] = plugin.components.map((component) => {
        const description = 'description' in component ? component.description : undefined
        return {
          pluginId: plugin.id,
          pluginName: plugin.name,
          kind: component.kind,
          name: component.name,
          ...(description !== undefined ? { description } : {}),
          source: plugin.source,
        }
      })
      for (const item of items) totals[item.kind] = (totals[item.kind] ?? 0) + 1
      const measured = items.reduce((sum, item) => (
        item.kind === 'skill' || item.kind === 'command' || item.kind === 'agent'
          ? sum + estimate(`${item.name}\n${item.description ?? ''}`)
          : sum
      ), 0)
      residentTokens += measured
      plugins.push({ pluginId: plugin.id, name: plugin.name, source: plugin.source, items, compat, residentTokens: measured })
    }
    const budgetTokens = settings.contextBudgetTokens
    const tools = dshService(this.installs.ctx, 'tools') as { schemas(): unknown[] } | undefined
    let toolCount = 0
    let toolTokens = 0
    try {
      const schemas = tools?.schemas() ?? []
      toolCount = schemas.length
      toolTokens = schemas.reduce<number>((sum, schema) => sum + estimate(JSON.stringify(schema)), 0)
    } catch {
      // A composition without tool schema projection reports zero tools.
    }
    const totalResident = residentTokens + toolTokens
    return {
      plugins,
      totals,
      residentTokens: totalResident,
      ...(toolCount > 0 ? { toolCount } : {}),
      ...(toolTokens > 0 ? { toolTokens } : {}),
      ...(budgetTokens !== undefined ? { budgetTokens } : {}),
      overBudget: budgetTokens !== undefined && totalResident > budgetTokens,
      basis: `${meter === undefined ? 'bytes/4' : 'ctx.tokenMeter'} over catalog text + visible tool schemas`,
    }
  }

  /** Current optional host services, for diagnostics. */
  hostCapabilities(): HostCapabilities {
    return probeHostCapabilities(this.forge.ctx)
  }

  /** The adapter packages installed in this DSH profile (see `adapter-coverage.ts`), read from disk now. */
  adapters(): AdapterCoverage[] {
    const profile = dshService(this.installs.ctx, 'profileContext') as { readonly dir?: string } | undefined
    return adapterCoverage(profile?.dir !== undefined && profile.dir.length > 0 ? profile.dir : undefined)
  }

  /**
   * The adapters on disk that DSH lists as installed and enabled: what `harness_verify_port` requires too, so a link
   * left by a failed install covers nothing.
   */
  enabledAdapters(): Promise<AdapterCoverage[]> {
    return enabledAdapters(this.adapters(), dshService(this.forge.ctx, 'pluginManager') as PluginManagerLike | undefined)
  }

  /** Scan the roots the overview lists, and attribute the user's configured status line. */
  private overviewSources(requiredId?: string) {
    const scanned: Array<{ plugin: ForeignPlugin; record?: InstalledPluginRecord }> = []
    const unreadable: OverviewItem[] = []
    const seen = new Set<string>()
    for (const record of this.installs.list()) {
      seen.add(resolve(record.root).toLowerCase())
      try {
        scanned.push({ plugin: this.installs.scan(record.root, record.source), record })
      } catch (error: unknown) {
        if (record.id === requiredId) throw error
        // Its files are gone or unreadable: it stays listed, every part an error, with why.
        unreadable.push(unreadableItemOf(record, messageOf(error)))
      }
    }
    for (const found of this.discover().plugins) {
      if (found.installed || seen.has(resolve(found.root).toLowerCase())) continue
      try {
        scanned.push({ plugin: this.installs.scan(found.root, found.source) })
      } catch {
        // An unreadable root has nothing to show.
      }
    }
    const settings = scanned.map(({ plugin }) => claudeSettingsStatusLine(plugin)).find(item => item !== undefined)
    const provider = settings === undefined ? undefined : claudeStatusLineProvider(settings.command, scanned.map(({ plugin }) => plugin), homedir())
    if (provider === undefined || settings === undefined) return { scanned, unreadable }
    const source = scanned.find(item => item.plugin === provider.plugin)!
    if (!source.plugin.components.some(part => part.id === provider.component.id)) {
      source.plugin = { ...source.plugin, components: [...source.plugin.components, provider.component] }
      if (source.record?.compat !== undefined) {
        const gap = assess(source.plugin).gaps.find(item => item.componentId === provider.component.id)
        if (gap !== undefined) source.record = { ...source.record, compat: { ...source.record.compat, gaps: [...source.record.compat.gaps, gap] } }
      }
    }
    return { scanned, unreadable, link: { settingsId: settings.component.id, providerId: provider.component.id, name: provider.plugin.name } }
  }

  /** The workbench's plain-language view of every harness: see `overview.ts`. */
  async overview(): Promise<Overview> {
    const adapters = await this.enabledAdapters()
    const { scanned, unreadable, link } = this.overviewSources()
    const items = scanned.map(({ plugin, record }) => itemOf(plugin, record, adapters))
    return overviewOf([...items, ...unreadable], link)
  }

  /** Read-only workbench diagnostics: host services, mounts, tool budget and row failures. */
  diagnostics(): Record<string, unknown> {
    const catalog = this.capabilities()
    return {
      host: this.hostCapabilities(),
      hookShell: { bash: this.forge.shell.bash ?? null, powershell: this.forge.shell.powershell, default: this.forge.shell.defaultKind },
      bun: findBun(this.installs.dataRoot) ?? null,
      versions: {
        forge: versionOf('../package.json') ?? null,
        dsh: versionOf('@deepseek-ai/dsh-session/package.json') ?? null,
        node: process.versions.node,
      },
      platform: process.platform,
      faults: this.forge.faults(),
      tools: { count: catalog.toolCount ?? 0, tokens: catalog.toolTokens ?? 0, residentTokens: catalog.residentTokens },
      skillRoots: this.listSkillRoots(),
      failedMounts: this.installs.list().flatMap(plugin => (plugin.mounts ?? [])
        .filter(mount => mount.status === 'failed')
        .map(mount => ({ pluginId: plugin.id, kind: mount.kind, name: mount.name, error: mount.error ?? '' }))),
      plugins: this.installs.list().map(plugin => ({ id: plugin.id, source: plugin.source, root: plugin.root, installedAt: plugin.installedAt })),
      statePath: this.installs.statePath,
      dataRoot: this.installs.dataRoot,
    }
  }

  /** List all skill roots the skills row serves (none while it is off). */
  listSkillRoots(): readonly string[] {
    return this.forge.lookup('skills')?.roots() ?? []
  }

  /** Migrate everything of one harness that is not migrated yet: its plugins and the person's own assets. */
  async migrate(source: 'claude-code' | 'codex' | 'opencode'): Promise<{ readonly installed: readonly string[]; readonly failed: ReadonlyArray<{ readonly name: string; readonly error: string }> }> {
    const installed: string[] = []
    const failed: Array<{ name: string; error: string }> = []
    for (const found of this.discover().plugins.filter(item => item.source === source && !item.installed)) {
      try {
        const report = await this.forge.install(found.root, found.source)
        installed.push(report.plugin.name)
      } catch (error: unknown) {
        failed.push({ name: found.name, error: messageOf(error) })
      }
    }
    return { installed, failed }
  }
}
