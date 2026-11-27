/**
 * Migrated: everything active in DSH, per plugin and per part, with a switch
 * for each part and Remove for the plugin; parts a Harness Forge row does
 * not run because it is off say which row.
 * @module @kirkchinese/harness-forge/client
 */
import { useState } from 'react'
import { call } from './typert.js'
import { Chevron, fill, harnessName, isGap, itemName, kindLabel, messageOf, Notice, Reasons, ROW_TITLE, StateLabel, type Item, type Part, type TFn, type Workspace } from './shared.js'

function PartRow({ item, part, t, onToggle, busy }: { item: Item; part: Part; t: TFn; onToggle: (item: Item, part: Part, enabled: boolean) => void; busy: boolean }): JSX.Element {
  const on = part.state !== 'off'
  const row = part.reasons.find(reason => reason.code === 'row-off')?.detail
  const rowTitle = row !== undefined && ROW_TITLE[row] !== undefined ? t(ROW_TITLE[row]) : row
  return (
    <div className="hf-part">
      {part.state === 'provided' ? null : <button
        className="hf-switch"
        role="switch"
        aria-checked={on}
        aria-label={fill(t('switchLabel'), { name: part.name })}
        disabled={busy}
        onClick={() => { onToggle(item, part, !on) }}
      />}
      <div className="hf-part-main">
        <span className="hf-part-kind">{kindLabel(part.kind, t)}</span>
        <span className="hf-part-name">{part.name}</span>
        {part.state === 'off'
          ? <div className="hf-reason">{t('partOffByYou')}</div>
          : part.state === 'inactive'
            ? (
              <>
                <div className="hf-reason">{fill(t('partInactiveRow'), { row: rowTitle ?? '' })}</div>
                {rowTitle !== undefined && rowTitle.length > 0 ? <div className="hf-muted">{fill(t('partInactiveHint'), { row: rowTitle })}</div> : null}
              </>
            )
            : <Reasons part={part} t={t} />}
      </div>
      {part.state === 'off' || part.state === 'inactive' ? null : <StateLabel state={part.state} t={t} />}
    </div>
  )
}

function PluginRow({ item, t, onToggle, onRemove, busy }: {
  item: Item
  t: TFn
  onToggle: (item: Item, part: Part, enabled: boolean) => void
  onRemove: (item: Item) => void
  busy: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const attention = item.parts.filter(part => isGap(part) || part.state === 'inactive').length
  return (
    <li className="hf-item" data-open={open}>
      <div className="hf-item-head">
        <button className="hf-row-button" aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
          <Chevron open={open} />
          <span className="hf-item-main">
            <span className="hf-item-title">{itemName(item, t)}<span className="hf-tag">{harnessName(item.source)}</span></span>
            <span className="hf-item-desc">{item.version !== undefined ? `${item.version} · ` : ''}{item.root}</span>
          </span>
        </button>
        <span className="hf-verdict-label" style={{ flex: 'none' }}>
          <span className="hf-dot" style={{ background: attention === 0 ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-primary)' }} />
          {attention === 0 ? t('ready') : fill(t('attention'), { n: attention })}
        </span>
        <button className="hf-btn hf-btn-danger" disabled={busy} onClick={() => { setConfirming(true) }}>{t('remove')}</button>
      </div>
      {confirming ? (
        <div style={{ padding: '0 8px 10px 34px' }}>
          <div className="hf-notice hf-notice-row" style={{ marginTop: 0 }}>
            <span>{fill(t('removeConfirm'), { name: itemName(item, t) })}</span>
            <span style={{ display: 'flex', gap: 8 }}>
              <button className="hf-btn" onClick={() => { setConfirming(false) }}>{t('cancel')}</button>
              <button className="hf-btn hf-btn-danger" disabled={busy} onClick={() => { setConfirming(false); onRemove(item) }}>{t('remove')}</button>
            </span>
          </div>
        </div>
      ) : null}
      {open ? (
        <div className="hf-parts">
          {item.parts.map(part => <PartRow key={part.id} item={item} part={part} t={t} onToggle={onToggle} busy={busy} />)}
        </div>
      ) : null}
    </li>
  )
}

function SignIns({ t, waiting }: { t: TFn; waiting: readonly string[] }): JSX.Element | null {
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  if (waiting.length === 0) return null
  const signIn = async (server: string): Promise<void> => {
    setError(undefined)
    try {
      const started = await call<{ signInUrl: string }>('signIn', { server })
      setNotice(`${t('signInOpened')} ${started.signInUrl}`)
    } catch (cause: unknown) {
      setError(messageOf(cause))
    }
  }
  return (
    <section className="hf-section hf-card">
      <h2 className="hf-section-title">{t('signInTitle')}</h2>
      <p className="hf-lead" style={{ margin: '2px 0 10px' }}>{t('signInLead')}</p>
      <div className="hf-form">
        {waiting.map(server => <button key={server} className="hf-btn" onClick={() => { void signIn(server) }}>{t('signIn')} · {server}</button>)}
      </div>
      {error !== undefined ? <Notice kind="error">{error}</Notice> : null}
      {notice !== undefined ? <Notice>{notice}</Notice> : null}
    </section>
  )
}

/**
 * One banner per workspace whose project parts wait for trust: they run code
 * (hooks, MCP servers, shell lines) and stay off until the person trusts the
 * folder. "Not now" hides the banner for that workspace for good (Settings →
 * Trust settings brings it back).
 */
export function TrustBanners({ t, workspaces, reload }: { t: TFn; workspaces: readonly Workspace[]; reload: () => Promise<void> }): JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const shown = workspaces.filter(item => !item.trusted && !item.dismissed && item.waiting.length > 0)
  if (shown.length === 0 && error === undefined) return null
  const decide = async (workspace: string, method: 'trustWorkspace' | 'dismissTrust'): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await call(method, method === 'trustWorkspace' ? { cwd: workspace, trusted: true } : { cwd: workspace, dismissed: true })
      await reload()
    } catch (cause: unknown) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      {shown.map(item => (
        <section key={item.workspace} className="hf-section hf-card" role="region" aria-label={t('trustTitle')}>
          <h2 className="hf-section-title">{t('trustTitle')}</h2>
          <p className="hf-lead" style={{ margin: '2px 0 6px' }}>{fill(t('trustLead'), { folder: item.workspace })}</p>
          <ul className="hf-muted" style={{ margin: '0 0 10px', paddingLeft: 18 }}>
            {item.waiting.map(part => <li key={part.componentId}>{kindLabel(part.kind, t)} {part.name} — {t('trustWaiting')}</li>)}
          </ul>
          <div className="hf-form">
            <button className="hf-btn" disabled={busy} onClick={() => { void decide(item.workspace, 'trustWorkspace') }}>{t('trustButton')}</button>
            <button className="hf-btn" disabled={busy} onClick={() => { void decide(item.workspace, 'dismissTrust') }}>{t('trustNotNow')}</button>
          </div>
        </section>
      ))}
      {error !== undefined ? <Notice kind="error">{error}</Notice> : null}
    </>
  )
}

export function MigratedScreen({ t, items, signInWaiting, reload }: { t: TFn; items: readonly Item[]; signInWaiting: readonly string[]; reload: () => Promise<void> }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  const run = async (work: () => Promise<string | undefined>): Promise<void> => {
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    try {
      const message = await work()
      if (message !== undefined) setNotice(message)
      await reload()
    } catch (cause: unknown) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  const toggle = (item: Item, part: Part, enabled: boolean): void => {
    void run(async () => {
      await call('setPartEnabled', { pluginId: item.id, componentId: part.id, enabled })
      return undefined
    })
  }

  const remove = (item: Item): void => {
    void run(async () => {
      await call('removePlugin', { id: item.id })
      return fill(t('removed'), { name: itemName(item, t) })
    })
  }

  return (
    <div>
      <p className="hf-lead" style={{ marginTop: 0 }}>{t('migratedLead')}</p>
      {error !== undefined ? <Notice kind="error">{error}</Notice> : null}
      {notice !== undefined ? <Notice>{notice}</Notice> : null}
      <div style={{ height: 8 }} />
      <SignIns t={t} waiting={signInWaiting} />
      {items.length === 0
        ? <div className="hf-empty">{t('migratedEmpty')}</div>
        : (
          <ul className="hf-list">
            {items.map(item => <PluginRow key={item.id} item={item} t={t} onToggle={toggle} onRemove={remove} busy={busy} />)}
          </ul>
        )}
    </div>
  )
}
