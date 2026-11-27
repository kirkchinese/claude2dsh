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
import { adapterPackageName, assess, dialects, type ComponentOutcome, type ForeignComponent, type ForeignPlugin, type Gap } from '@kirkchinese/harness-forge-core'

export type PartState = 'works' | 'partial' | 'needs-port' | 'unsupported' | 'failed' | 'inactive' | 'off'

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
  | 'run-failed'
  | 'setup-failed'
  | 'unreadable'
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
}

export interface OverviewHarness {
  readonly source: string
  /** Product name; not translated. */
  readonly label: string
  readonly items: readonly OverviewItem[]
  readonly counts: Readonly<Record<PartState, number>>
  /** Of the parts that work, how many have run here and been checked. */
  readonly checked: number
  readonly toMigrate: number
}

export interface Overview {
  readonly harnesses: readonly OverviewHarness[]
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
  return { works: 0, partial: 0, 'needs-port': 0, unsupported: 0, failed: 0, inactive: 0, off: 0 }
}

/** The specifics after "…: " in a gap summary (event or handler names), else the summary. */
function specifics(summary: string): string {
  const at = summary.indexOf(': ')
  return at >= 0 ? summary.slice(at + 2) : summary
}

function reasonOf(gap: Gap): { code: ReasonCode; detail: string } {
  switch (gap.kind) {
    case 'unsupported-event': return { code: 'events-never-raised', detail: specifics(gap.summary) }
    case 'semantic-difference': return gap.id.endsWith(':output-style') ? { code: 'output-style', detail: '' } : { code: 'cannot-block', detail: specifics(gap.summary) }
    case 'unsupported-handler': return { code: 'handlers-inert', detail: specifics(gap.summary) }
    case 'missing-host-api': return { code: 'experimental-runtime', detail: gap.detail }
    case 'ui-surface': return { code: 'no-equivalent-ui', detail: '' }
    case 'unsupported-component': return { code: 'not-mapped', detail: gap.summary.replace(/ is not mapped to DSH$/u, '') }
    case 'unsupported-transport': return { code: 'unknown-transport', detail: '' }
    case 'runtime-failure': return { code: 'setup-failed', detail: gap.summary }
    default: return { code: 'other', detail: gap.summary }
  }
}

/** Gaps an adapter written in DSH's creation mode can close. */
function portable(gap: Gap): boolean {
  return gap.kind === 'ui-surface' || gap.kind === 'unsupported-component' || gap.kind === 'unsupported-event' || gap.kind === 'unsupported-handler'
}

/** The state of one part, from what happened when it was set up and run (or, before migration, from its gaps). */
export function partOf(component: ForeignComponent, gaps: readonly Gap[], outcome: ComponentOutcome | undefined, adapter: string | undefined, off = false): OverviewPart {
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
  const blocking = own.find(gap => gap.kind === 'ui-surface' || gap.kind === 'unsupported-component' || gap.kind === 'unsupported-transport')
  if (blocking !== undefined || outcome?.status === 'skipped') {
    const reasons = blocking !== undefined ? [reasonOf(blocking)] : [{ code: 'other' as const, detail: outcome?.message ?? '' }]
    return { ...base, state: portGap !== undefined ? 'needs-port' : 'unsupported', checked: false, reasons, ...port }
  }
  const verified = outcome?.status === 'verified'
  // A verified code runtime has shown the API it needs is there.
  const reasons = own.filter(gap => !(verified && gap.kind === 'missing-host-api')).map(reasonOf)
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
    name: plugin.name,
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
export function unreadableItemOf(record: { readonly id: string; readonly name: string; readonly source: string; readonly root: string; readonly version?: string; readonly components: ReadonlyArray<{ readonly kind: string; readonly name: string }> }, error: string): OverviewItem {
  const parts: OverviewPart[] = record.components.map((component, index) => ({
    id: `${record.id}:${String(index)}`,
    kind: component.kind as ForeignComponent['kind'],
    name: component.name,
    state: 'failed',
    checked: true,
    reasons: [{ code: 'unreadable', detail: error }],
  }))
  const counts = emptyCounts()
  counts.failed = parts.length
  return {
    id: record.id,
    name: record.name,
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

/** Group items by harness, in dialect order: own assets first, then installed plugins, then the rest by name. */
export function overviewOf(items: readonly OverviewItem[]): Overview {
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
      return [{ source, label, items: own, counts, checked, toMigrate: own.filter(item => !item.installed).length }]
    }),
  }
}
