/**
 * Discover & migrate: for each harness, what this computer has (plugins and
 * the person's own settings), whether it works in DSH, and a button to migrate
 * one or all; below, plugins to get from the internet (a pasted marketplace or
 * plugin, or a default marketplace) and a path to add by hand.
 * @module @kirkchinese/harness-forge/client
 */
import { useEffect, useState } from 'react'
import { call } from './typert.js'
import { Chevron, fill, harnessName, itemName, kindLabel, messageOf, Notice, Reasons, StateLabel, VerdictBar, type Harness, type Item, type Key, type Part, type TFn } from './shared.js'

interface MarketEntry {
  readonly name: string
  readonly description?: string
  readonly version?: string
  readonly category?: string
  readonly from: string
  readonly unsupported?: string
  readonly installed?: string
}

/** A marketplace or a single plugin, as `remoteOpen` answers. */
interface SourceView {
  readonly kind: 'marketplace' | 'plugin'
  readonly input: string
  readonly name: string
  readonly description?: string
  readonly owner?: string
  readonly harness: string
  readonly source: string
  readonly page?: string
  readonly revision?: string
  readonly entries: readonly MarketEntry[]
  readonly warnings: readonly string[]
}

interface Confirmation {
  readonly token: string
  readonly name: string
  readonly version?: string
  readonly harness: string
  readonly source: string
  readonly page?: string
  readonly revision: string
  readonly registry?: string
  readonly dependencies?: number
  readonly parts: ReadonlyArray<{ readonly kind: string; readonly name: string; readonly gap?: string; readonly reasons?: Part['reasons']; readonly change?: 'new' | 'changed' }>
  readonly runsCode: readonly string[]
  readonly works: number
  readonly total: number
  readonly pluginId: string
  readonly alreadyInstalled: boolean
  readonly update?: { readonly from: string; readonly to: string; readonly removed: readonly string[] }
}

interface RemoteInstall {
  readonly pluginId: string
  readonly name: string
  readonly source: string
  readonly page?: string
  readonly revision: string
  /** Taken from a marketplace's folder on this computer: that marketplace's name. */
  readonly localMarketplace?: string
}

interface Sources {
  readonly defaults: ReadonlyArray<{ readonly id: string; readonly input: string; readonly harness: string }>
  readonly added: ReadonlyArray<{ readonly input: string; readonly name: string; readonly harness: string }>
  /** Marketplaces the harnesses on this computer added: their plugins are offers, installed one at a time. */
  readonly local?: ReadonlyArray<{ readonly input: string; readonly name: string; readonly harness: string }>
  readonly installs: readonly RemoteInstall[]
  readonly git: boolean
}

interface UpdateStatus {
  readonly pluginId: string
  readonly latest?: string
  readonly update: boolean
  /** Names the revision found: preparing the update fetches exactly that one. */
  readonly token?: string
  readonly error?: string
}

/** The key of the words for why a plugin's id cannot be told. */
const PLUGIN_ID_PROBLEM: Readonly<Record<NonNullable<Item['enabledUnknown']>, Key>> = {
  missing: 'pluginIdMissing',
  ambiguous: 'pluginIdAmbiguous',
  dynamic: 'pluginIdDynamic',
  escape: 'pluginIdEscape',
}

/** Why "Migrate all" leaves a plugin out: switched off in its harness, or not known to run there, and why. */
function holdNote(item: Item, t: TFn): string | undefined {
  const harness = harnessName(item.source)
  if (item.enabled === false) return fill(t('disabledInNote'), { harness })
  if (item.enabledUnknown !== undefined) return fill(t('enabledUnknownNote'), { harness, why: t(PLUGIN_ID_PROBLEM[item.enabledUnknown]) })
  return undefined
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
              {item.enabled === false ? <span className="hf-tag">{fill(t('disabledInTag'), { harness: harnessName(item.source) })}</span> : null}
              {item.enabledUnknown !== undefined ? <span className="hf-tag">{fill(t('enabledUnknownTag'), { harness: harnessName(item.source) })}</span> : null}
            </span>
            <span className="hf-item-desc">{item.version !== undefined ? `${item.version} · ` : ''}{item.root}</span>
            {holdNote(item, t) !== undefined ? <span className="hf-reason">{holdNote(item, t)}</span> : null}
          </span>
        </button>
        <VerdictBar item={item} t={t} />
        <span style={{ width: 76, flex: 'none', display: 'flex', justifyContent: 'flex-end' }}>
          {item.installed ? null : <button className="hf-btn" disabled={busy} title={holdNote(item, t)} onClick={() => { onMigrate(item) }}>{t('migrate')}</button>}
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

/** Entries listed at once; a filter finds the rest of a large marketplace. */
const SHOWN = 60

/** What a plugin contains and where it comes from, to confirm before it is installed. */
function ConfirmInstall({ t, plan, busy, onConfirm, onCancel }: { t: TFn; plan: Confirmation; busy: boolean; onConfirm: () => void; onCancel: () => void }): JSX.Element {
  const title = fill(t(plan.update !== undefined ? 'confirmUpdateTitle' : 'confirmTitle'), { name: plan.name })
  return (
    <div className="hf-card" role="dialog" aria-label={title} style={{ marginTop: 12 }}>
      <div className="hf-section-title" style={{ marginBottom: 8 }}>{title}</div>
      <dl className="hf-facts">
        <dt>{t('confirmSource')}</dt>
        <dd>{plan.page !== undefined ? <a href={plan.page} target="_blank" rel="noreferrer">{plan.source}</a> : plan.source}</dd>
        {plan.registry !== undefined ? <><dt>{t('confirmRegistry')}</dt><dd><span className="hf-code">{plan.registry}</span></dd></> : null}
        <dt>{plan.update !== undefined ? t('confirmUpdateRevision') : t('confirmRevision')}</dt>
        <dd>
          {plan.update !== undefined ? <><span className="hf-code">{plan.update.from}</span>{' → '}</> : null}
          <span className="hf-code">{plan.revision}</span>{plan.version !== undefined ? ` · ${plan.version}` : ''}
        </dd>
        <dt>{t('confirmHarness')}</dt>
        <dd>{harnessName(plan.harness)}</dd>
        <dt>{t('confirmParts')}</dt>
        <dd>
          <div className="hf-muted" style={{ marginBottom: 4 }}>{fill(t('confirmWorks'), { works: plan.works, total: plan.total })}</div>
          {plan.parts.map(part => (
            <div key={`${part.kind}:${part.name}`}>
              <span className="hf-part-kind">{kindLabel(part.kind, t)}</span>
              <span className="hf-part-name">{part.name}</span>
              {part.change !== undefined ? <span className="hf-tag">{t(part.change === 'new' ? 'partNew' : 'partChanged')}</span> : null}
              {part.reasons !== undefined ? <Reasons part={{ reasons: part.reasons }} t={t} /> : part.gap !== undefined ? <div className="hf-reason">{part.gap}</div> : null}
            </div>
          ))}
          {plan.update !== undefined && plan.update.removed.length > 0 ? <div className="hf-muted" style={{ marginTop: 4 }}>{fill(t('confirmRemoved'), { names: plan.update.removed.join(', ') })}</div> : null}
        </dd>
      </dl>
      {plan.dependencies !== undefined && plan.dependencies > 0 && plan.registry !== undefined ? <div className="hf-muted" style={{ marginBottom: 8 }}>{fill(t('confirmDependencies'), { n: plan.dependencies, registry: plan.registry })}</div> : null}
      <Notice kind={plan.runsCode.length > 0 ? 'error' : 'ok'}>
        {t('confirmWarn')}
        {plan.runsCode.length > 0 ? `\n${fill(t('confirmCode'), { kinds: plan.runsCode.map(kind => kindLabel(kind, t)).join(', ') })}` : ''}
        {plan.alreadyInstalled ? `\n${t('confirmReinstall')}` : ''}
      </Notice>
      <div className="hf-form" style={{ marginTop: 12 }}>
        <button className="hf-btn hf-btn-primary" disabled={busy} onClick={onConfirm}>{busy ? t(plan.update !== undefined ? 'remoteUpdating' : 'installing') : t(plan.update !== undefined ? 'confirmUpdate' : 'confirmInstall')}</button>
        <button className="hf-btn" disabled={busy} onClick={onCancel}>{t('confirmCancel')}</button>
      </div>
    </div>
  )
}

/** Get plugins: paste a marketplace or plugin, or open a default marketplace; confirm, install; check for updates. */
function GetPlugins({ t, onInstalled }: { t: TFn; onInstalled: () => void }): JSX.Element {
  const [input, setInput] = useState('')
  const [sources, setSources] = useState<Sources | undefined>(undefined)
  const [view, setView] = useState<SourceView | undefined>(undefined)
  const [filter, setFilter] = useState('')
  const [plan, setPlan] = useState<Confirmation | undefined>(undefined)
  const [updates, setUpdates] = useState<ReadonlyMap<string, UpdateStatus>>(new Map())
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  const refresh = async (): Promise<void> => {
    try {
      setSources(await call<Sources>('remoteSources'))
    } catch (cause: unknown) {
      setError(messageOf(cause))
    }
  }
  useEffect(() => { void refresh() }, [])

  const run = async (key: string, work: () => Promise<void>): Promise<void> => {
    setBusy(key)
    setError(undefined)
    setNotice(undefined)
    try {
      await work()
    } catch (cause: unknown) {
      setError(messageOf(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const open = (value: string): Promise<void> => {
    if (value.trim().length === 0) {
      setError(t('pathRequired'))
      return Promise.resolve()
    }
    setInput(value)
    return run('open', async () => {
      setPlan(undefined)
      setFilter('')
      setView(await call<SourceView>('remoteOpen', { input: value.trim() }))
      await refresh()
    })
  }

  const prepare = (entry?: string): Promise<void> => run(entry ?? 'plugin', async () => {
    if (view === undefined) return
    if (plan !== undefined) await call('remoteCancel', { token: plan.token }).catch(() => undefined)
    setPlan(await call<Confirmation>('remotePrepare', { input: view.input, ...(entry !== undefined ? { entry } : {}) }))
  })

  const confirm = (): Promise<void> => run('confirm', async () => {
    if (plan === undefined) return
    const report = await call<{ plugin?: { name?: string }; pluginId?: string; revision?: string; updated?: boolean }>('remoteInstall', { token: plan.token })
    setPlan(undefined)
    if (report.updated === true) {
      setNotice(fill(t('remoteUpdated'), { name: plan.name, revision: report.revision ?? plan.revision }))
      setUpdates(previous => new Map([...previous].filter(([id]) => id !== plan.pluginId)))
    } else setNotice(fill(t('installedName'), { name: report.plugin?.name ?? plan.name }))
    onInstalled()
    if (view !== undefined) setView(await call<SourceView>('remoteOpen', { input: view.input }).catch(() => view))
    await refresh()
  })

  const cancel = (): void => {
    if (plan !== undefined) void call('remoteCancel', { token: plan.token }).catch(() => undefined)
    setPlan(undefined)
  }

  const forget = (value: string): Promise<void> => run('forget', async () => {
    await call('remoteForget', { input: value })
    await refresh()
  })

  const check = (): Promise<void> => run('check', async () => {
    const result = await call<{ updates: UpdateStatus[] }>('remoteCheckUpdates', {})
    setUpdates(new Map(result.updates.map(item => [item.pluginId, item])))
  })

  // An update is shown and confirmed like an install: the revision the check found, what changed, what runs code.
  const update = (install: RemoteInstall, token: string): Promise<void> => run(install.pluginId, async () => {
    if (plan !== undefined) await call('remoteCancel', { token: plan.token }).catch(() => undefined)
    setPlan(await call<Confirmation>('remotePrepareUpdate', { pluginId: install.pluginId, token }))
  })

  const needle = filter.trim().toLowerCase()
  const matching = view?.entries.filter(entry => needle.length === 0 || `${entry.name} ${entry.description ?? ''} ${entry.category ?? ''}`.toLowerCase().includes(needle)) ?? []
  const marketplaces = [
    ...(sources?.defaults ?? []).map(item => ({ input: item.input, name: item.id, harness: item.harness, removable: false })),
    ...(sources?.added ?? []).map(item => ({ input: item.input, name: item.name, harness: item.harness, removable: true })),
  ]
  return (
    <section className="hf-section">
      <div className="hf-section-head"><h2 className="hf-section-title">{t('marketTitle')}</h2></div>
      <p className="hf-lead">{t('marketLead')}</p>
      <form className="hf-form" onSubmit={(event) => { event.preventDefault(); void open(input) }}>
        <input className="hf-input" value={input} placeholder={t('marketPath')} aria-label={t('marketPath')} onChange={event => { setInput(event.target.value) }} />
        <button className="hf-btn" type="submit" disabled={busy !== undefined}>{busy === 'open' ? t('marketOpening') : t('marketOpen')}</button>
      </form>
      {sources !== undefined && !sources.git ? <div className="hf-muted" style={{ marginTop: 6 }}>{t('marketNoGit')}</div> : null}
      {marketplaces.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          <div className="hf-muted" style={{ marginBottom: 6 }}>{t('marketDefaults')}</div>
          <div className="hf-form">
            {marketplaces.map(item => (
              <span key={item.input} style={{ display: 'inline-flex', alignItems: 'center' }}>
                <button className="hf-btn" disabled={busy !== undefined} title={item.input} onClick={() => { void open(item.input) }}>
                  {item.name}<span className="hf-tag">{harnessName(item.harness)}</span>
                </button>
                {item.removable ? <button className="hf-btn hf-btn-link" aria-label={fill(t('marketForget'), { name: item.name })} title={fill(t('marketForget'), { name: item.name })} disabled={busy !== undefined} onClick={() => { void forget(item.input) }}>×</button> : null}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {sources?.local !== undefined && sources.local.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          <div className="hf-muted" style={{ marginBottom: 6 }}>{t('marketLocal')}</div>
          <div className="hf-form">
            {sources.local.map(item => (
              <button key={item.input} className="hf-btn" disabled={busy !== undefined} title={item.input} onClick={() => { void open(item.input) }}>
                {item.name}<span className="hf-tag">{harnessName(item.harness)}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {error !== undefined ? <Notice kind="error">{error}</Notice> : null}
      {notice !== undefined ? <Notice>{notice}</Notice> : null}
      {plan !== undefined ? <ConfirmInstall t={t} plan={plan} busy={busy === 'confirm'} onConfirm={() => { void confirm() }} onCancel={cancel} /> : null}
      {view === undefined ? null : (
        <div style={{ marginTop: 16 }}>
          <div className="hf-section-head">
            <div>
              <div className="hf-item-title">{view.name}<span className="hf-tag">{view.kind === 'plugin' ? t('marketPlugin') : harnessName(view.harness)}</span></div>
              <div className="hf-muted">
                {view.owner !== undefined ? `${view.owner} · ` : ''}
                {view.page !== undefined ? <a href={view.page} target="_blank" rel="noreferrer">{view.source}</a> : view.source}
                {view.revision !== undefined ? <> · <span className="hf-code">{view.revision}</span></> : null}
              </div>
            </div>
            {view.kind === 'marketplace' && view.entries.length > 12
              ? <input className="hf-input" style={{ flex: '0 1 260px' }} value={filter} placeholder={fill(t('marketFilter'), { n: view.entries.length })} aria-label={fill(t('marketFilter'), { n: view.entries.length })} onChange={event => { setFilter(event.target.value) }} />
              : null}
          </div>
          {view.kind === 'plugin' ? (
            <div className="hf-form" style={{ marginTop: 8 }}>
              <button className="hf-btn hf-btn-primary" disabled={busy !== undefined} onClick={() => { void prepare() }}>{busy === 'plugin' ? t('marketOpening') : t('install')}</button>
            </div>
          ) : view.entries.length === 0 ? <div className="hf-empty">{t('marketEmpty')}</div> : (
            <ul className="hf-list">
              {matching.slice(0, SHOWN).map(entry => (
                <li key={entry.name} className="hf-item">
                  <div className="hf-item-head">
                    <span className="hf-item-main">
                      <span className="hf-item-title">
                        {entry.name}
                        {entry.version !== undefined ? <span className="hf-muted">{entry.version}</span> : null}
                        {entry.installed !== undefined ? <span className="hf-tag">{t('marketInstalledTag')}</span> : null}
                      </span>
                      <span className="hf-item-desc" title={entry.description}>{entry.description ?? fill(t('marketFrom'), { from: entry.from })}</span>
                    </span>
                    <button
                      className="hf-btn"
                      disabled={busy !== undefined || entry.unsupported !== undefined}
                      title={entry.unsupported !== undefined ? fill(t('marketUnsupported'), { reason: entry.unsupported }) : fill(t('marketFrom'), { from: entry.from })}
                      onClick={() => { void prepare(entry.name) }}
                    >
                      {busy === entry.name ? t('marketOpening') : t('install')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {matching.length > SHOWN ? <div className="hf-muted">{fill(t('marketMore'), { n: matching.length - SHOWN })}</div> : null}
        </div>
      )}
      {sources !== undefined && sources.installs.length > 0 ? (
        <div style={{ marginTop: 20 }}>
          <div className="hf-section-head">
            <div className="hf-muted">{t('remoteInstalled')}</div>
            <button className="hf-btn" disabled={busy !== undefined} onClick={() => { void check() }}>{busy === 'check' ? t('remoteChecking') : t('remoteCheck')}</button>
          </div>
          <ul className="hf-list">
            {sources.installs.map((install) => {
              const status = updates.get(install.pluginId)
              return (
                <li key={install.pluginId} className="hf-item">
                  <div className="hf-item-head">
                    <span className="hf-item-main">
                      <span className="hf-item-title">{install.name}<span className="hf-code">{install.revision.length === 40 ? install.revision.slice(0, 12) : install.revision}</span></span>
                      <span className="hf-item-desc" title={install.source}>
                        {install.localMarketplace !== undefined
                          ? fill(t('remoteLocalMarketplace'), { name: install.localMarketplace })
                          : install.page !== undefined ? <a href={install.page} target="_blank" rel="noreferrer">{install.source}</a> : install.source}
                      </span>
                      {status?.error !== undefined ? <span className="hf-reason">{status.error}</span> : null}
                    </span>
                    {status === undefined ? null : status.update && status.latest !== undefined && status.token !== undefined
                      ? <button className="hf-btn hf-btn-primary" disabled={busy !== undefined} onClick={() => { void update(install, status.token!) }}>{busy === install.pluginId ? t('marketOpening') : fill(t('remoteUpdate'), { latest: status.latest })}</button>
                      : status.error === undefined ? <span className="hf-muted">{t('remoteUpToDate')}</span> : null}
                  </div>
                </li>
              )
            })}
          </ul>
          <div className="hf-muted">{t('remoteRemoveHint')}</div>
        </div>
      ) : null}
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
      <GetPlugins t={t} onInstalled={() => { void reload() }} />
      <ManualAdd t={t} onInstalled={() => { void reload() }} />
    </div>
  )
}
