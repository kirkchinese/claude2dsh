/**
 * What the screens share: the overview's shapes as the Host sends them, the
 * translation function, plain-language verdicts and part rows.
 * @module @kirkchinese/harness-forge/client
 */
import type { ReactNode } from 'react'
import type zh from './locale/zh.json'

export type Key = keyof typeof zh
export type TFn = (key: Key) => string

/** Replace `{name}` placeholders. */
export function fill(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/gu, (whole, key: string) => (key in values ? String(values[key]) : whole))
}

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export type PartState = 'works' | 'partial' | 'needs-port' | 'unsupported' | 'failed' | 'inactive' | 'off' | 'provided'
export type ReasonCode = 'events-never-raised' | 'cannot-block' | 'handlers-inert' | 'output-style' | 'experimental-runtime' | 'no-equivalent-ui' | 'not-mapped' | 'hosted-connector' | 'unknown-transport' | 'run-failed' | 'setup-failed' | 'unreadable' | 'row-off' | 'other'
/** A dialect id: `claude-code`, `codex`, `opencode`, or a common format such as `agent-skills`. */
export type Source = string

export interface Part {
  readonly id: string
  readonly kind: string
  readonly name: string
  readonly state: PartState
  readonly checked: boolean
  readonly reasons: ReadonlyArray<{ readonly code: ReasonCode; readonly detail: string }>
  readonly portGap?: string
  readonly adapter?: string
  readonly providedBy?: { readonly name: string; readonly adapter?: string }
}

export interface Item {
  readonly id: string
  readonly name: string
  readonly source: Source
  readonly root: string
  readonly own: boolean
  readonly installed: boolean
  readonly version?: string
  readonly parts: readonly Part[]
}

/** A workspace of open sessions, with its trust and the project parts that wait for it. */
export interface Workspace {
  readonly workspace: string
  readonly trusted: boolean
  readonly sources: readonly string[]
  /** "Not now" was chosen: the banner stays hidden. */
  readonly dismissed: boolean
  readonly waiting: ReadonlyArray<{ readonly componentId: string; readonly kind: Part['kind']; readonly name: string; readonly does: string; readonly message: string }>
}

export interface Harness {
  readonly source: Source
  /** Product name; not translated. */
  readonly label: string
  readonly items: readonly Item[]
  readonly toMigrate: number
}

/** Product names of the built-in dialects; not translated. Others show their id. */
const HARNESS_NAMES: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  'agent-plugins': 'Agent Plugins',
  'agent-skills': 'Agent Skills',
}

export function harnessName(source: Source): string {
  return HARNESS_NAMES[source] ?? source
}

export const STATE_COLOR: Record<PartState, string> = {
  works: 'var(--dsw-alias-state-success-primary)',
  partial: 'var(--dsw-alias-state-warn-primary)',
  'needs-port': 'var(--dsw-alias-state-business-primary)',
  unsupported: 'var(--dsw-alias-label-tertiary)',
  failed: 'var(--dsw-alias-state-error-primary)',
  inactive: 'var(--dsw-alias-label-tertiary)',
  off: 'var(--dsw-alias-label-tertiary)',
  provided: 'var(--dsw-alias-label-tertiary)',
}

export const STATE_LABEL: Record<PartState, Key> = {
  works: 'stateWorks',
  partial: 'statePartial',
  'needs-port': 'stateNeedsPort',
  unsupported: 'stateUnsupported',
  failed: 'stateFailed',
  inactive: 'stateInactive',
  off: 'stateOff',
  provided: 'stateProvided',
}

const REASON_LABEL: Record<ReasonCode, Key | undefined> = {
  'events-never-raised': 'reasonEventsNeverRaised',
  'cannot-block': 'reasonCannotBlock',
  'handlers-inert': 'reasonHandlersInert',
  'output-style': 'reasonOutputStyle',
  'experimental-runtime': 'reasonExperimentalRuntime',
  'no-equivalent-ui': 'reasonNoEquivalentUi',
  'not-mapped': 'reasonNotMapped',
  'hosted-connector': 'reasonHostedConnector',
  'unknown-transport': 'reasonUnknownTransport',
  'run-failed': 'reasonRunFailed',
  'setup-failed': 'reasonSetupFailed',
  unreadable: 'reasonUnreadable',
  'row-off': 'reasonRowOff',
  other: undefined,
}

const KIND_LABEL: Record<string, Key> = {
  skill: 'kindSkill',
  command: 'kindCommand',
  agent: 'kindAgent',
  mcp: 'kindMcp',
  hooks: 'kindHooks',
  code: 'kindCode',
  ui: 'kindUi',
  settings: 'kindSettings',
  other: 'kindOther',
}

/** The Harness Forge rows by the name the Host gives them. */
export const ROW_TITLE: Record<string, Key> = {
  skills: 'rowSkills',
  commands: 'rowCommands',
  agents: 'rowAgents',
  hooks: 'rowHooks',
  mcp: 'rowMcp',
  mods: 'rowMods',
  opencode: 'rowOpencode',
  sessions: 'rowSessions',
  context: 'rowContext',
  porter: 'rowPorter',
}

export function kindLabel(kind: string, t: TFn): string {
  const key = KIND_LABEL[kind]
  return key !== undefined ? t(key) : kind
}

/** A part that can't fully run in DSH (the Gaps screen lists these). */
export function isGap(part: Part): boolean {
  return part.adapter === undefined && (part.state === 'partial' || part.state === 'needs-port' || part.state === 'unsupported' || part.state === 'failed')
}

/** Parts the person or a row switched off don't count toward a verdict. */
function counted(item: Item): readonly Part[] {
  return item.parts.filter(part => part.state !== 'off' && part.state !== 'inactive' && part.state !== 'provided')
}

export type Verdict = 'works' | 'partly' | 'none'

export function verdictOf(item: Item): { verdict: Verdict; works: number; total: number } {
  const parts = counted(item)
  const works = parts.filter(part => part.state === 'works').length
  const partly = parts.filter(part => part.state === 'partial').length
  const total = parts.length
  const verdict: Verdict = total === 0 || works === total ? 'works' : works + partly === 0 ? 'none' : 'partly'
  return { verdict, works, total }
}

const VERDICT_COLOR: Record<Verdict, string> = {
  works: STATE_COLOR.works,
  partly: STATE_COLOR.partial,
  none: 'var(--dsw-alias-label-tertiary)',
}

/** The item's verdict in words with a bar of works / partly / not. */
export function VerdictBar({ item, t }: { item: Item; t: TFn }): JSX.Element {
  const { verdict, works, total } = verdictOf(item)
  const parts = counted(item)
  const partly = parts.filter(part => part.state === 'partial').length
  const label = verdict === 'works' ? t('verdictWorks') : verdict === 'partly' ? t('verdictPartly') : t('verdictNone')
  const title = verdict === 'works' ? t('verdictWorksDetail') : verdict === 'partly' ? fill(t('verdictPartlyDetail'), { works, total }) : t('verdictNoneDetail')
  const width = (n: number): string => `${total === 0 ? 0 : (n / total) * 100}%`
  return (
    <div className="hf-verdict" title={title}>
      <span className="hf-verdict-label"><span className="hf-dot" style={{ background: VERDICT_COLOR[verdict] }} />{label}</span>
      <span className="hf-bar" aria-hidden>
        <span style={{ width: width(works), background: STATE_COLOR.works }} />
        <span style={{ width: width(partly), background: STATE_COLOR.partial }} />
      </span>
    </div>
  )
}

/** A part's reasons in words, with the specifics in small monospace. */
export function Reasons({ part, t }: { part: Part; t: TFn }): JSX.Element | null {
  const provider = part.providedBy
  if (provider !== undefined) return (
    <div className="hf-reason">
      {fill(t('providedBy'), { name: provider.name })}
      {provider.adapter !== undefined ? ` · ${fill(t('coveredBy'), { name: provider.adapter })}` : ''}
    </div>
  )
  if (part.reasons.length === 0) return null
  return (
    <>
      {part.reasons.map((reason, index) => {
        const lead = REASON_LABEL[reason.code]
        // A row-off detail names the row; the screens word it themselves.
        const detail = reason.code === 'row-off' ? '' : reason.detail
        return (
          <div key={index} className="hf-reason">
            {lead !== undefined ? <span>{t(lead)} </span> : null}
            {detail.length > 0 ? <span className="hf-code">{detail}</span> : null}
          </div>
        )
      })}
    </>
  )
}

export function StateLabel({ state, t }: { state: PartState; t: TFn }): JSX.Element {
  return <span className="hf-part-state"><span className="hf-dot" style={{ background: STATE_COLOR[state] }} />{t(STATE_LABEL[state])}</span>
}

export function Chevron({ open }: { open: boolean }): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden style={{ flex: 'none', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms', opacity: 0.6 }}>
      <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** An item's display name: the person's own settings, or the plugin name. */
export function itemName(item: Item, t: TFn): string {
  return item.own ? t('ownSettings') : item.name
}

export function Notice({ kind = 'ok', children }: { kind?: 'ok' | 'error'; children: ReactNode }): JSX.Element {
  return <div className="hf-notice" data-kind={kind} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>
}
