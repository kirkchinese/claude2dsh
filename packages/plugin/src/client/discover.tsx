/**
 * Discover & migrate: for each harness, what this computer has (plugins and
 * the person's own settings), whether it works in DSH, and a button to migrate
 * one or all; a marketplace to browse and a path to add by hand below.
 * @module @kirkchinese/harness-forge/client
 */
import { useState } from 'react'
import { call } from './typert.js'
import { Chevron, fill, harnessName, itemName, kindLabel, messageOf, Notice, Reasons, StateLabel, VerdictBar, type Harness, type Item, type TFn } from './shared.js'

interface MarketEntry {
  readonly name: string
  readonly description?: string
  readonly version?: string
  readonly source: { readonly kind: string }
}

interface MarketView {
  readonly name: string
  readonly owner?: string
  readonly warnings: readonly string[]
  readonly entries: readonly MarketEntry[]
}

/** One plugin or the person's settings, with its parts behind an expander. */
function ItemRow({ item, t, busy, onMigrate }: { item: Item; t: TFn; busy: boolean; onMigrate: (item: Item) => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <li className="hf-item" data-open={open}>
      <div className="hf-item-head">
        <button className="hf-row-button" aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
          <Chevron open={open} />
          <span className="hf-item-main">
            <span className="hf-item-title">
              {itemName(item, t)}
              {item.installed ? <span className="hf-tag">{t('migratedTag')}</span> : null}
            </span>
            <span className="hf-item-desc">{item.version !== undefined ? `${item.version} · ` : ''}{item.root}</span>
          </span>
        </button>
        <VerdictBar item={item} t={t} />
        <span style={{ width: 76, flex: 'none', display: 'flex', justifyContent: 'flex-end' }}>
          {item.installed ? null : <button className="hf-btn" disabled={busy} onClick={() => { onMigrate(item) }}>{t('migrate')}</button>}
        </span>
      </div>
      {open ? (
        <div className="hf-parts">
          {item.parts.map(part => (
            <div key={part.id} className="hf-part">
              <StateLabel state={part.state} t={t} />
              <div className="hf-part-main">
                <span className="hf-part-kind">{kindLabel(part.kind, t)}</span>
                <span className="hf-part-name">{part.name}</span>
                <Reasons part={part} t={t} />
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </li>
  )
}

function Marketplace({ t, onInstalled }: { t: TFn; onInstalled: () => void }): JSX.Element {
  const [path, setPath] = useState('')
  const [market, setMarket] = useState<MarketView | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  const open = async (): Promise<void> => {
    if (path.trim().length === 0) {
      setError(t('pathRequired'))
      return
    }
    setBusy('open')
    setError(undefined)
    try {
      setMarket(await call<MarketView>('marketplaceScan', { path: path.trim() }))
    } catch (cause: unknown) {
      setError(messageOf(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const install = async (name: string): Promise<void> => {
    setBusy(name)
    setError(undefined)
    setNotice(undefined)
    try {
      await call('marketplaceInstall', { path: path.trim(), name })
      setNotice(fill(t('installedName'), { name }))
      onInstalled()
    } catch (cause: unknown) {
      setError(`${name}: ${messageOf(cause)}`)
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <section className="hf-section">
      <div className="hf-section-head"><h2 className="hf-section-title">{t('marketTitle')}</h2></div>
      <p className="hf-lead">{t('marketLead')}</p>
      <form className="hf-form" onSubmit={(event) => { event.preventDefault(); void open() }}>
        <input className="hf-input" value={path} placeholder={t('marketPath')} aria-label={t('marketPath')} onChange={event => { setPath(event.target.value) }} />
        <button className="hf-btn" type="submit" disabled={busy !== undefined}>{busy === 'open' ? t('marketOpening') : t('marketOpen')}</button>
      </form>
      {error !== undefined ? <Notice kind="error">{error}</Notice> : null}
      {notice !== undefined ? <Notice>{notice}</Notice> : null}
      {market === undefined ? null : (
        <div style={{ marginTop: 12 }}>
          <div className="hf-muted" style={{ marginBottom: 6 }}>{market.name}{market.owner !== undefined ? ` · ${market.owner}` : ''}</div>
          {market.entries.length === 0 ? <div className="hf-empty">{t('marketEmpty')}</div> : (
            <ul className="hf-list">
              {market.entries.map((entry) => {
                const installable = entry.source.kind === 'path' || entry.source.kind === 'git'
                return (
                  <li key={entry.name} className="hf-item">
                    <div className="hf-item-head">
                      <span className="hf-item-main">
                        <span className="hf-item-title">{entry.name}{entry.version !== undefined ? <span className="hf-muted">{entry.version}</span> : null}</span>
                        <span className="hf-item-desc">{entry.description ?? ''}</span>
                      </span>
                      <button className="hf-btn" disabled={busy !== undefined || !installable} title={installable ? undefined : t('marketUnsupported')} onClick={() => { void install(entry.name) }}>
                        {busy === entry.name ? t('installing') : t('install')}
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}

function ManualAdd({ t, onInstalled }: { t: TFn; onInstalled: () => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  const add = async (): Promise<void> => {
    if (path.trim().length === 0) {
      setError(t('pathRequired'))
      return
    }
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    try {
      const report = await call<{ plugin?: { name?: string } }>('installPlugin', { path: path.trim() })
      setNotice(fill(t('installedName'), { name: report.plugin?.name ?? path.trim() }))
      setPath('')
      onInstalled()
    } catch (cause: unknown) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="hf-section">
      <button className="hf-btn hf-btn-link" aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
        <Chevron open={open} />{t('manualToggle')}
      </button>
      {open ? (
        <div style={{ marginTop: 10 }}>
          <p className="hf-lead" style={{ marginBottom: 10 }}>{t('manualLead')}</p>
          <form className="hf-form" onSubmit={(event) => { event.preventDefault(); void add() }}>
            <input className="hf-input" value={path} placeholder={t('manualPath')} aria-label={t('manualPath')} onChange={event => { setPath(event.target.value) }} />
            <button className="hf-btn" type="submit" disabled={busy}>{busy ? t('installing') : t('manualAdd')}</button>
          </form>
          {error !== undefined ? <Notice kind="error">{error}</Notice> : null}
          {notice !== undefined ? <Notice>{notice}</Notice> : null}
        </div>
      ) : null}
    </section>
  )
}

export function DiscoverScreen({ t, harnesses, reload }: { t: TFn; harnesses: readonly Harness[]; reload: () => Promise<void> }): JSX.Element {
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  const migrateAll = async (source: Harness['source']): Promise<void> => {
    setBusy(source)
    setError(undefined)
    setNotice(undefined)
    try {
      const result = await call<{ installed: string[]; failed: Array<{ name: string; error: string }> }>('migrate', { source })
      const lines = [fill(t('migrateDone'), { n: result.installed.length })]
      if (result.failed.length > 0) lines.push(fill(t('migrateFailed'), { n: result.failed.length }), ...result.failed.map(item => `· ${item.name}: ${item.error}`))
      if (result.failed.length > 0) setError(lines.join('\n'))
      else setNotice(lines.join('\n'))
      await reload()
    } catch (cause: unknown) {
      setError(messageOf(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const migrateOne = async (item: Item): Promise<void> => {
    setBusy(item.id)
    setError(undefined)
    setNotice(undefined)
    try {
      await call('installPlugin', { path: item.root, source: item.source })
      setNotice(fill(t('migrateDone'), { n: 1 }))
      await reload()
    } catch (cause: unknown) {
      setError(`${itemName(item, t)}: ${messageOf(cause)}`)
    } finally {
      setBusy(undefined)
    }
  }

  const found = harnesses.filter(harness => harness.items.length > 0)
  const missing = harnesses.filter(harness => harness.items.length === 0)
  return (
    <div>
      {error !== undefined ? <Notice kind="error">{error}</Notice> : null}
      {notice !== undefined ? <Notice>{notice}</Notice> : null}
      <div style={{ height: 16 }} />
      {found.map(harness => (
        <section key={harness.source} className="hf-section">
          <div className="hf-section-head">
            <h2 className="hf-section-title">{harness.label}</h2>
            {harness.toMigrate > 0
              ? (
                <button className="hf-btn hf-btn-primary" disabled={busy !== undefined} onClick={() => { void migrateAll(harness.source) }}>
                  {busy === harness.source ? t('migrating') : fill(t('migrateAll'), { n: harness.toMigrate })}
                </button>
              )
              : <span className="hf-muted">{t('allMigrated')}</span>}
          </div>
          <ul className="hf-list">
            {harness.items.map(item => <ItemRow key={item.id} item={item} t={t} busy={busy !== undefined} onMigrate={(value) => { void migrateOne(value) }} />)}
          </ul>
        </section>
      ))}
      {missing.length > 0 ? (
        <div className="hf-section">
          {missing.map(harness => <div key={harness.source} className="hf-muted" style={{ marginBottom: 4 }}>{fill(t('nothingFound'), { name: harness.label })}</div>)}
        </div>
      ) : null}
      <Marketplace t={t} onInstalled={() => { void reload() }} />
      <ManualAdd t={t} onInstalled={() => { void reload() }} />
    </div>
  )
}
