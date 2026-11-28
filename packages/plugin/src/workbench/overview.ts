/**
 * The workbench's plain-language view: for each harness (Claude Code, Codex,
 * OpenCode) the person's plugins and own assets, and for each part one of
 * five states with the reason. Levels, plans and receipts stay in the
 * details; this is what a person who never heard of them reads.
 *
 * | State | When |
 * | --- | --- |
 * | `works` | set up in DSH (or covered by an installed adapter) with nothing known missing; `checked` says whether a run here was observed |
 * | `partial` | set up, but something it uses does not carry over, or a run of it failed in part |
 * | `needs-port` | DSH has no equivalent; DSH's creation mode can write an adapter from its brief |
 * | `unsupported` | DSH has no equivalent and none can be written from what the plugin declares |
 * | `failed` | setting it up or running it failed |
 * | `inactive` | the part of Harness Forge that runs it is switched off |
 * | `off` | the person switched this part off |
 *
 * A reason is a code the browser words in the person's language, plus the
 * specifics (event names, the error) as they are. A plugin not migrated yet
 * shows the states its parts would have, predicted from its scan.
 * @module @kirkchinese/harness-forge
 */
import { basename, dirname } from 'node:path'
import type { DetachedReason, InstalledPluginRecord } from '../forge/state.js'
import { adapterPackageName, assess, dialects, type ComponentOutcome, type ForeignComponent, type ForeignPlugin, type Gap, type PluginIdProblem } from '@kirkchinese/harness-forge-core'

export type PartState = 'works' | 'partial' | 'needs-port' | 'unsupported' | 'failed' | 'inactive' | 'off' | 'provided'

export type ReasonCode =
  | 'events-never-raised'
  | 'cannot-block'
  | 'handlers-inert'
  | 'output-style'
  | 'experimental-runtime'
  | 'no-equivalent-ui'
  | 'not-mapped'
  | 'hosted-connector'
  | 'unknown-transport'
  | 'disabled-in-plugin'
  | 'disabled-in-config'
  | 'disabled-in-claude-code'
  | 'needs-chatgpt-sign-in'
  | 'run-failed'
  | 'setup-failed'
  | 'unreadable'
  | 'folder-gone'
  | 'not-followed'
  | 'row-off'
  | 'other'

export interface OverviewPart {
  readonly id: string
  readonly kind: ForeignComponent['kind']
  readonly name: string
  readonly state: PartState
  /** Whether a run in DSH was observed (a `works` part that is only set up says so). */
  readonly checked: boolean
  readonly reasons: ReadonlyArray<{ readonly code: ReasonCode; readonly detail: string }>
  /** The gap an adapter can close (needs-port, and partial parts an adapter could complete). */
  readonly portGap?: string
  /** The installed adapter that covers this part. */
  readonly adapter?: string
  /** Another part supplies this settings entry; only that part counts toward the overview. */
  readonly providedBy?: { readonly name: string; readonly adapter?: string }
  /** It acts when a session starts (see {@link actsAtSessionStart}): a session already open keeps what it started with. */
  readonly atStart?: true
}

export interface OverviewItem {
  readonly id: string
  readonly name: string
  readonly source: string
  readonly root: string
  /** The person's own assets (`~/.claude`, `~/.codex`) rather than a plugin. */
  readonly own: boolean
  readonly installed: boolean
  readonly version?: string
  readonly parts: readonly OverviewPart[]
  readonly counts: Readonly<Record<PartState, number>>
  /** Of the parts that work, how many have run here and been checked. */
  readonly checked: number
  /** Installed from the network ("Get plugins"), not found in a harness's own folders. */
  readonly fetched?: true
  /**
   * Not migrated, and switched off in its own harness (Claude Code `enabledPlugins`, Codex `enabled = false`):
   * listed, but "Migrate all" leaves it out (see {@link migratable}).
   */
  readonly enabled?: false
  /**
   * Not migrated, and whether its harness runs it cannot be told, saying why: an OpenCode plugin whose id its source
   * does not settle, under an entry that switches plugins by id. "Migrate all" leaves it out too.
   */
  readonly enabledUnknown?: PluginIdProblem
  /** Migrated, but its harness no longer runs it (see `forge/follow.ts`): nothing of it runs until kept or removed. */
  readonly detached?: { readonly reason: DetachedReason; readonly harness: string; readonly folderGone: boolean }
  /** The last update its harness made, which the migrated plugin followed. */
  readonly updated?: { readonly harness: string; readonly from?: string; readonly to?: string; readonly at: string }
}

/**
 * Whether "Migrate all" takes a plugin: not migrated yet, and surely not switched off in the harness it came from.
 * The one rule for the overview's count, the button's label and the batch itself; a plugin it leaves out can still
 * be migrated on its own.
 */
export function migratable(item: { readonly installed: boolean; readonly enabled?: boolean; readonly enabledUnknown?: PluginIdProblem }): boolean {
  return !item.installed && item.enabled !== false && item.enabledUnknown === undefined
}

export interface OverviewHarness {
  readonly source: string
  /** Product name; not translated. */
  readonly label: string
  readonly items: readonly OverviewItem[]
  readonly counts: Readonly<Record<PartState, number>>
  /** Of the parts that work, how many have run here and been checked. */
  readonly checked: number
  /** How many items "Migrate all" takes ({@link migratable}). */
  readonly toMigrate: number
}

export interface Overview {
  /** What was found on this computer in each harness's own folders. */
  readonly harnesses: readonly OverviewHarness[]
  /** Plugins installed from the network: migrated, but in no harness's folders. */
  readonly fetched: readonly OverviewItem[]
}

/** An installed adapter and the parts it brings: plugin name and component name of the original. */
export interface AdapterCoverage {
  readonly name: string
  readonly ports: ReadonlyArray<{ readonly plugin: string; readonly component: string }>
  /** Its package directory (a local install's source directory). */
  readonly dir?: string
}

/** The installed adapter that covers a part: one declaring it in `harnessForge.ports`, or named for it (`adapterPackageName`). */
export function coveringAdapter(plugin: Pick<ForeignPlugin, 'name'>, component: Pick<ForeignComponent, 'name'>, adapters: readonly AdapterCoverage[]): string | undefined {
  return adapters.find(adapter =>
    adapter.name === adapterPackageName(plugin, component) || adapter.ports.some(port => port.plugin === plugin.name && port.component === component.name))?.name
}

/** Harnesses always shown, found or not; other dialects only when they found something. */
const ALWAYS_SHOWN: ReadonlySet<string> = new Set(['claude-code', 'codex', 'opencode'])

function emptyCounts(): Record<PartState, number> {
  return { works: 0, partial: 0, 'needs-port': 0, unsupported: 0, failed: 0, inactive: 0, off: 0, provided: 0 }
}

/** The specifics after "…: " in a gap summary (event or handler names), else the summary. */
function specifics(summary: string): string {
  const at = summary.indexOf(': ')
  return at >= 0 ? summary.slice(at + 2) : summary
}

/** Why a part DSH does not run was left out: the code its own configuration or approval gave, else what the outcome said. */
function skippedReason(component: ForeignComponent, outcome: ComponentOutcome | undefined): { code: ReasonCode; detail: string } {
  const code = outcome?.skippedBy ?? (component.kind === 'mcp' ? component.notStarted?.code : undefined)
  return code !== undefined ? { code, detail: '' } : { code: 'other', detail: outcome?.message ?? '' }
}

function reasonOf(gap: Gap, component?: ForeignComponent): { code: ReasonCode; detail: string } {
  switch (gap.kind) {
    case 'unsupported-event': return { code: 'events-never-raised', detail: specifics(gap.summary) }
    case 'semantic-difference': return gap.id.endsWith(':output-style') ? { code: 'output-style', detail: '' } : { code: 'cannot-block', detail: specifics(gap.summary) }
    case 'unsupported-handler': return { code: 'handlers-inert', detail: specifics(gap.summary) }
    case 'missing-host-api': return { code: 'experimental-runtime', detail: gap.detail }
    case 'ui-surface': return { code: 'no-equivalent-ui', detail: '' }
    case 'unsupported-component': return { code: 'not-mapped', detail: gap.summary.replace(/ is not mapped to DSH$/u, '') }
    case 'unsupported-transport': return { code: 'unknown-transport', detail: '' }
    case 'external-requirement': return component?.kind === 'mcp' && component.notStarted !== undefined ? skippedReason(component, undefined) : { code: 'other', detail: gap.summary }
    case 'runtime-failure': return { code: 'setup-failed', detail: gap.summary }
    default: return { code: 'other', detail: gap.summary }
  }
}

/** Gaps an adapter written in DSH's creation mode can close: the parts the overview says need an adapter. */
export function portable(gap: Gap): boolean {
  return gap.kind === 'ui-surface' || gap.kind === 'unsupported-component' || gap.kind === 'unsupported-event' || gap.kind === 'unsupported-handler'
}

/** The hook event DSH raises once as a session starts. */
const SESSION_START_EVENT = 'SessionStart'

/**
 * Whether a part acts only when a session starts: a SessionStart hook runs once as the session begins, so a session
 * already open does not get it. Everything else takes effect at once: skills, commands, agents and MCP tools are
 * looked up when they are used, the other hooks run at their events, and system-prompt sections (output styles,
 * Codex's global instructions, instruction files) are read again at every step, because DSH assembles the system
 * prompt once per step (dsh-system-prompt: "The agent loop calls `assemble(context)` once per proposed step").
 */
export function actsAtSessionStart(component: ForeignComponent): boolean {
  return component.kind === 'hooks' && component.events.includes(SESSION_START_EVENT)
}

/** The state of one part, from what happened when it was set up and run (or, before migration, from its gaps). */
export function partOf(component: ForeignComponent, gaps: readonly Gap[], outcome: ComponentOutcome | undefined, adapter: string | undefined, off = false): OverviewPart {
  const part = stateOfPart(component, gaps, outcome, adapter, off)
  return actsAtSessionStart(component) ? { ...part, atStart: true } : part
}

function stateOfPart(component: ForeignComponent, gaps: readonly Gap[], outcome: ComponentOutcome | undefined, adapter: string | undefined, off: boolean): OverviewPart {
  const own = gaps.filter(gap => gap.componentId === component.id && gap.kind !== 'license' && gap.kind !== 'runtime-failure')
  const base = { id: component.id, kind: component.kind, name: component.name }
  if (off) return { ...base, state: 'off', checked: false, reasons: [] }
  const portGap = own.find(portable)?.id
  const port = portGap !== undefined ? { portGap } : {}
  // An installed adapter brings the part; nothing here has seen it run, so it is not `checked`.
  if (adapter !== undefined) return { ...base, state: 'works', checked: false, reasons: [], adapter }
  // A Codex app is a connector OpenAI hosts and signs in to; nothing local can stand in for it.
  if (component.kind === 'other' && component.originalKind === 'app-connector') {
    return { ...base, state: 'unsupported', checked: false, reasons: [{ code: 'hosted-connector', detail: '' }] }
  }
  // The detail is the row that is off (`skills`, `mcp`, …), for the browser to name.
  if (outcome?.status === 'inactive') return { ...base, state: 'inactive', checked: false, reasons: [{ code: 'row-off', detail: /the (\S+) row is off/u.exec(outcome.message ?? '')?.[1] ?? '' }] }
  const observations = outcome?.observations ?? []
  const failedRuns = observations.filter(item => !item.ok)
  if (outcome?.status === 'failed') {
    // Failed when set up (no runs recorded), or failed in its runs: some of them (partly works) or all (error).
    if (failedRuns.length === 0) return { ...base, state: 'failed', checked: true, reasons: [{ code: 'setup-failed', detail: outcome.message ?? '' }], ...port }
    const runReasons = failedRuns.map(item => ({ code: 'run-failed' as const, detail: item.detail ?? item.signal }))
    return { ...base, state: failedRuns.length < observations.length ? 'partial' : 'failed', checked: true, reasons: runReasons, ...port }
  }
  const blocking = own.find(gap => gap.kind === 'ui-surface' || gap.kind === 'unsupported-component' || gap.kind === 'unsupported-transport' || gap.kind === 'external-requirement')
  if (blocking !== undefined || outcome?.status === 'skipped') {
    const reasons = blocking !== undefined ? [reasonOf(blocking, component)] : [skippedReason(component, outcome)]
    return { ...base, state: portGap !== undefined ? 'needs-port' : 'unsupported', checked: false, reasons, ...port }
  }
  const verified = outcome?.status === 'verified'
  // A verified code runtime has shown the API it needs is there.
  const reasons = own.filter(gap => !(verified && gap.kind === 'missing-host-api')).map(gap => reasonOf(gap, component))
  if (reasons.length > 0) return { ...base, state: 'partial', checked: verified, reasons, ...port }
  return { ...base, state: 'works', checked: verified, reasons: [] }
}

/** One plugin or own-assets root, installed (with outcomes) or only discovered. */
export function itemOf(
  plugin: ForeignPlugin,
  record: { readonly outcomes?: readonly ComponentOutcome[]; readonly compat?: { readonly gaps: readonly Gap[] }; readonly disabled?: readonly string[] } | undefined,
  adapters: readonly AdapterCoverage[] = [],
): OverviewItem {
  const gaps = record?.compat?.gaps ?? assess(plugin).gaps
  const outcomes = new Map((record?.outcomes ?? []).map(outcome => [outcome.componentId, outcome]))
  const coveredBy = (component: ForeignComponent): string | undefined => coveringAdapter(plugin, component, adapters)
  const disabled = new Set(record?.disabled ?? [])
  const parts = plugin.components.map(component => partOf(component, gaps, outcomes.get(component.id), coveredBy(component), disabled.has(component.id)))
  const counts = emptyCounts()
  for (const part of parts) counts[part.state]++
  return {
    id: plugin.id,
    name: plugin.displayName ?? plugin.name,
    source: plugin.source,
    root: plugin.root,
    own: plugin.manifest['scope'] === 'user',
    installed: record !== undefined,
    ...(plugin.version !== undefined ? { version: plugin.version } : {}),
    parts,
    counts,
    checked: parts.filter(part => part.state === 'works' && part.checked).length,
  }
}

/** An installed plugin whose files can no longer be read: every recorded part is an error, with the reason. */
export function unreadableItemOf(record: { readonly id: string; readonly name: string; readonly displayName?: string; readonly source: string; readonly root: string; readonly version?: string; readonly components: ReadonlyArray<{ readonly kind: string; readonly name: string }> }, error: string, code: 'unreadable' | 'folder-gone' = 'unreadable'): OverviewItem {
  const parts: OverviewPart[] = record.components.map((component, index) => ({
    id: `${record.id}:${String(index)}`,
    kind: component.kind as ForeignComponent['kind'],
    name: component.name,
    state: 'failed',
    checked: true,
    reasons: [{ code, detail: error }],
  }))
  const counts = emptyCounts()
  counts.failed = parts.length
  return {
    id: record.id,
    name: record.displayName ?? record.name,
    source: record.source,
    root: record.root,
    own: record.id.endsWith(':user'),
    installed: true,
    ...(record.version !== undefined ? { version: record.version } : {}),
    parts,
    counts,
    checked: 0,
  }
}

/**
 * A migrated item as its harness install has it: a detached one's parts (but those the person switched off, or that
 * could not be withdrawn) do not run, saying so; an updated one says from which version.
 */
export function followedItemOf(item: OverviewItem, record: Pick<InstalledPluginRecord, 'harnessInstall' | 'detached' | 'harnessUpdate' | 'root'> | undefined, folderGone: boolean): OverviewItem {
  const harness = record?.harnessInstall?.harness ?? item.source
  const updated = record?.harnessUpdate === undefined ? {} : { updated: { harness, ...record.harnessUpdate } }
  if (record?.detached === undefined) return { ...item, ...updated }
  const parts = item.parts.map((part): OverviewPart => part.state === 'off' || part.state === 'failed' ? part : { ...part, state: 'inactive', checked: false, reasons: [{ code: 'not-followed', detail: harness }] })
  const counts = emptyCounts()
  for (const part of parts) counts[part.state]++
  return { ...item, ...updated, parts, counts, checked: 0, detached: { reason: record.detached.reason, harness, folderGone } }
}

/**
 * Installed plugins that genuinely share a name are told apart in plain words, the same way wherever they are listed:
 * `name (where it came from)`, and the folder it is in when that is the same too. A plugin with a name of its own is
 * shown as it is: the suffix the ledger gives its id is never part of what people read.
 */
export function qualifyDuplicateNames<T extends OverviewItem>(items: readonly T[]): T[] {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    if (!item.installed) continue
    groups.set(item.name.toLowerCase(), [...groups.get(item.name.toLowerCase()) ?? [], item])
  }
  const qualified = new Map<T, string>()
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const origin = (item: T): string => (item.fetched === true ? 'network' : item.source)
    const unique = new Set(group.map(origin)).size === group.length
    for (const item of group) qualified.set(item, `${item.name} (${unique ? origin(item) : `${origin(item)}, ${basename(dirname(item.root))}`})`)
  }
  return items.map(item => (qualified.has(item) ? { ...item, name: qualified.get(item)! } : item))
}

/** Group items by harness, in dialect order: own assets first, then installed plugins, then the rest by name; those fetched from the network apart. */
export function overviewOf(items: readonly OverviewItem[], link?: { readonly settingsId: string; readonly providerId: string; readonly name: string }): Overview {
  const provider = link === undefined ? undefined : items.flatMap(item => item.parts).find(part => part.id === link.providerId)
  if (link !== undefined && provider !== undefined) {
    items = items.map(item => {
      const settings = item.parts.find(part => part.id === link.settingsId)
      if (settings === undefined) return item
      const counts = { ...item.counts, [settings.state]: item.counts[settings.state] - 1 }
      const alias: OverviewPart = {
        id: settings.id, kind: settings.kind, name: settings.name,
        state: 'provided', checked: provider.checked, reasons: [],
        providedBy: { name: link.name, ...(provider.adapter !== undefined ? { adapter: provider.adapter } : {}) },
      }
      return { ...item, parts: item.parts.map(part => part === settings ? alias : part), counts, checked: item.checked - Number(settings.state === 'works' && settings.checked) }
    })
  }
  const fetched = items.filter(item => item.fetched === true).sort((a, b) => a.name.localeCompare(b.name, 'en'))
  items = items.filter(item => item.fetched !== true)
  const known = dialects().map(dialect => ({ source: dialect.id, label: dialect.label }))
  const unknown = [...new Set(items.map(item => item.source))].filter(source => !known.some(dialect => dialect.source === source)).map(source => ({ source, label: source }))
  return {
    harnesses: [...known, ...unknown].flatMap(({ source, label }) => {
      const own = items.filter(item => item.source === source)
        .sort((a, b) => Number(b.own) - Number(a.own) || Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name, 'en'))
      if (own.length === 0 && !ALWAYS_SHOWN.has(source)) return []
      const counts = emptyCounts()
      for (const item of own) for (const state of Object.keys(counts) as PartState[]) counts[state] += item.counts[state]
      const checked = own.reduce((sum, item) => sum + item.checked, 0)
      return [{ source, label, items: own, counts, checked, toMigrate: own.filter(migratable).length }]
    }),
    fetched,
  }
}
