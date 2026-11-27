/**
 * The pages behind "More": import sessions (or, while dsh-chat-import runs,
 * where its import is), settings (with what is added to new sessions, when
 * the Host reports it) and diagnostics.
 * @module @kirkchinese/harness-forge/client
 */
import { useCallback, useEffect, useState } from 'react'
import { call } from './typert.js'
import { fill, harnessName, messageOf, Notice, ROW_TITLE, type Source, type TFn } from './shared.js'
import { ChatImportOffer, ChatImportProvided, useSessionImport } from './chat-import.js'

interface SessionView {
  readonly path: string
  readonly sourceId: string
  readonly title?: string
  readonly cwd?: string
  readonly createdAt?: number
}

export function SessionsScreen({ t, openSession }: { t: TFn; openSession: (id: string) => void }): JSX.Element | null {
  const { status, reload } = useSessionImport()
  if (status?.provider === 'dsh-chat-import') return <ChatImportProvided t={t} />
  return (
    <div>
      {status !== undefined ? <div style={{ marginBottom: 16 }}><ChatImportOffer t={t} status={status} reload={reload} /></div> : null}
      <ForgeSessions t={t} openSession={openSession} />
    </div>
  )
}

/** Harness Forge's own import, while dsh-chat-import is not there. */
function ForgeSessions({ t, openSession }: { t: TFn; openSession: (id: string) => void }): JSX.Element {
  const [source, setSource] = useState<Source>('claude-code')
  const [sessions, setSessions] = useState<SessionView[] | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [imported, setImported] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let live = true
    setSessions(undefined)
    setError(undefined)
    call<{ sessions: SessionView[] }>('sessions', { source })
      .then((result) => { if (live) setSessions(result.sessions) })
      .catch((cause: unknown) => { if (live) { setSessions([]); setError(messageOf(cause)) } })
    return () => { live = false }
  }, [source])

  const importOne = async (session: SessionView): Promise<void> => {
    setBusy(session.path)
    setError(undefined)
    try {
      const result = await call<{ id: string }>('importSession', { path: session.path, source, sourceId: session.sourceId })
      setImported(current => ({ ...current, [session.path]: result.id }))
    } catch (cause: unknown) {
      setError(messageOf(cause))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div>
      <p className="hf-lead" style={{ marginTop: 0 }}>{t('sessionsLead')}</p>
      <div className="hf-tabs" role="tablist" aria-label={t('sessionsFrom')} style={{ margin: '0 0 16px' }}>
        {(['claude-code', 'codex', 'opencode'] as const).map(value => (
          <button key={value} role="tab" className="hf-tab" aria-selected={source === value} onClick={() => { setSource(value) }}>{harnessName(value)}</button>
        ))}
      </div>
      {error !== undefined ? <Notice kind="error">{error}</Notice> : null}
      {sessions === undefined
        ? <div className="hf-empty">{t('sessionsLoading')}</div>
        : sessions.length === 0
          ? <div className="hf-empty">{t('sessionsEmpty')}</div>
          : (
            <ul className="hf-list">
              {sessions.map((session) => {
                const id = imported[session.path]
                return (
                  <li key={session.path} className="hf-item">
                    <div className="hf-item-head">
                      <span className="hf-item-main">
                        <span className="hf-item-title">{session.title ?? session.sourceId}</span>
                        <span className="hf-item-desc">
                          {session.createdAt !== undefined ? `${new Date(session.createdAt).toLocaleString()} · ` : ''}{session.cwd ?? session.path}
                        </span>
                      </span>
                      {id !== undefined
                        ? <button className="hf-btn" onClick={() => { openSession(id) }}>{t('openSession')}</button>
                        : <button className="hf-btn" disabled={busy !== undefined} onClick={() => { void importOne(session) }}>{busy === session.path ? t('sessionImporting') : t('sessionImport')}</button>}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
    </div>
  )
}

interface Settings {
  readonly discoveryRoots: readonly string[]
  readonly autoDiscover: boolean
}

interface ContextStatus {
  readonly active: boolean
  readonly yieldingTo?: string
  readonly files: ReadonlyArray<{ readonly path: string; readonly bytes: number }>
  /** Files DSH loads itself, so Harness Forge does not add them again. */
  readonly hostFiles?: ReadonlyArray<{ readonly path: string; readonly bytes: number }>
}

function ContextSection({ t }: { t: TFn }): JSX.Element | null {
  const [status, setStatus] = useState<ContextStatus | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  useEffect(() => {
    let live = true
    call<ContextStatus>('contextStatus')
      .then((value) => { if (live) setStatus(value) })
      .catch((cause: unknown) => { if (live) setError(messageOf(cause)) })
    return () => { live = false }
  }, [])
  if (status === undefined && error === undefined) return null
  const hostFiles = status?.hostFiles ?? []
  return (
    <section className="hf-section">
      <h2 className="hf-section-title">{t('contextTitle')}</h2>
      <p className="hf-lead" style={{ margin: '2px 0 10px' }}>{t('contextLead')}</p>
      {error !== undefined ? <Notice kind="error">{error}</Notice> : null}
      {status === undefined ? null
        : status.yieldingTo !== undefined ? <div className="hf-card">{fill(t('contextYielding'), { name: status.yieldingTo })}</div>
          : !status.active ? <div className="hf-card">{t('contextOff')}</div>
            : status.files.length === 0 ? (hostFiles.length === 0 ? <div className="hf-card">{t('contextNone')}</div> : null)
              : (
                <div className="hf-card">
                  <div style={{ marginBottom: 6 }}>{t('contextActive')}</div>
                  {status.files.map(file => <div key={file.path} className="hf-code">{file.path}</div>)}
                </div>
              )}
      {hostFiles.length > 0 ? (
        <div className="hf-card" style={{ marginTop: status?.files.length === 0 ? 0 : 8 }}>
          <div style={{ marginBottom: 6 }}>{t('contextHost')}</div>
          {hostFiles.map(file => <div key={file.path} className="hf-code">{file.path}</div>)}
        </div>
      ) : null}
    </section>
  )
}

interface TrustRecord {
  readonly workspace: string
  readonly trusted: boolean
  readonly sources: readonly string[]
  readonly dismissed: boolean
  readonly trustedAt?: string
  readonly dismissedAt?: string
}

/** Product names; not translated. */
const TRUST_SOURCE: Readonly<Record<string, string>> = { 'claude-code': 'Claude Code', codex: 'Codex', forge: 'Harness Forge' }

/** The workspaces trusted here or dismissed with "Not now", each reversible. */
function TrustSection({ t, onChanged }: { t: TFn; onChanged: () => void }): JSX.Element {
  const [records, setRecords] = useState<readonly TrustRecord[] | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  /** The last decision whose withdrawal failed for some parts: they are still live, and deciding again retries. */
  const [stillLive, setStillLive] = useState<{ readonly workspace: string; readonly trusted: boolean; readonly parts: readonly string[] } | undefined>(undefined)

  const load = useCallback(async (): Promise<void> => {
    try {
      setRecords((await call<{ workspaces: TrustRecord[] }>('trustDecisions')).workspaces)
    } catch (cause: unknown) {
      setError(messageOf(cause))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const decide = async (workspace: string, trusted: boolean): Promise<void> => {
    setBusy(true)
    setError(undefined)
    setStillLive(undefined)
    try {
      const result = await call<{ stillLive: ReadonlyArray<{ readonly componentId: string; readonly reason: string }> }>('trustWorkspace', { cwd: workspace, trusted })
      if (result.stillLive.length > 0) setStillLive({ workspace, trusted, parts: result.stillLive.map(part => `${part.componentId}: ${part.reason}`) })
      await load()
      onChanged()
    } catch (cause: unknown) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="hf-section" aria-label={t('trustSettingsTitle')}>
      <h2 className="hf-section-title">{t('trustSettingsTitle')}</h2>
      <p className="hf-lead" style={{ margin: '2px 0 10px' }}>{t('trustSettingsLead')}</p>
      {error !== undefined ? <Notice kind="error">{error}</Notice> : null}
      {stillLive !== undefined
        ? (
            <Notice kind="error">
              {fill(t('trustStillLive'), { list: stillLive.parts.join('; ') })}
              {' '}
              <button className="hf-btn" disabled={busy} onClick={() => { void decide(stillLive.workspace, stillLive.trusted) }}>{t('trustRetry')}</button>
            </Notice>
          )
        : null}
      {records === undefined ? null : records.length === 0 ? <div className="hf-card">{t('trustSettingsNone')}</div> : (
        <ul className="hf-list">
          {records.map((record) => {
            const others = record.sources.filter(source => source !== 'forge').map(source => TRUST_SOURCE[source] ?? source)
            return (
              <li key={record.workspace} className="hf-item">
                <div className="hf-item-head">
                  <span className="hf-item-main">
                    <span className="hf-item-title hf-code">{record.workspace}</span>
                    <span className="hf-item-desc">
                      {record.trusted ? t('trustStateTrusted') : record.dismissed ? t('trustStateDismissed') : t('trustStateUndecided')}
                      {others.length > 0 ? ` · ${fill(t('trustAlsoBy'), { list: others.join(', ') })}` : ''}
                    </span>
                  </span>
                  {record.sources.includes('forge')
                    ? <button className="hf-btn" disabled={busy} onClick={() => { void decide(record.workspace, false) }}>{t('trustRevoke')}</button>
                    : record.trusted ? null : <button className="hf-btn" disabled={busy} onClick={() => { void decide(record.workspace, true) }}>{t('trustButton')}</button>}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

export function SettingsScreen({ t, onSaved }: { t: TFn; onSaved: () => void }): JSX.Element {
  const [roots, setRoots] = useState('')
  const [autoDiscover, setAutoDiscover] = useState(true)
  const [missing, setMissing] = useState<readonly string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  const load = useCallback(async (): Promise<void> => {
    try {
      const view = await call<{ settings: Settings; missingRoots: readonly string[] }>('discover')
      setRoots(view.settings.discoveryRoots.join('\n'))
      setAutoDiscover(view.settings.autoDiscover)
      setMissing(view.missingRoots)
    } catch (cause: unknown) {
      setError(messageOf(cause))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(undefined)
    setNotice(undefined)
    try {
      await call('saveSettings', { discoveryRoots: roots.split(/\r?\n/u).map(value => value.trim()).filter(value => value.length > 0), autoDiscover })
      setNotice(t('saved'))
      await load()
      onSaved()
    } catch (cause: unknown) {
      setError(messageOf(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <p className="hf-lead" style={{ marginTop: 0 }}>{t('settingsLead')}</p>
      <section className="hf-section">
        <h2 className="hf-section-title">{t('discoveryRoots')}</h2>
        <p className="hf-lead" style={{ margin: '2px 0 8px' }}>{t('discoveryRootsHint')}</p>
        <textarea className="hf-textarea" value={roots} aria-label={t('discoveryRoots')} onChange={event => { setRoots(event.target.value) }} />
        {missing.length > 0 ? <div className="hf-muted" style={{ marginTop: 6 }}>{fill(t('missingRoots'), { list: missing.join(', ') })}</div> : null}
        <label className="hf-form" style={{ marginTop: 12, fontSize: 13 }}>
          <button className="hf-switch" role="switch" aria-checked={autoDiscover} aria-label={t('autoDiscover')} onClick={() => { setAutoDiscover(value => !value) }} />
          {t('autoDiscover')}
        </label>
        <div className="hf-form" style={{ marginTop: 14 }}>
          <button className="hf-btn hf-btn-primary" disabled={saving} onClick={() => { void save() }}>{saving ? t('saving') : t('save')}</button>
        </div>
        {error !== undefined ? <Notice kind="error">{error}</Notice> : null}
        {notice !== undefined ? <Notice>{notice}</Notice> : null}
      </section>
      <TrustSection t={t} onChanged={onSaved} />
      <ContextSection t={t} />
    </div>
  )
}

interface Diagnostics {
  readonly faults: ReadonlyArray<{ readonly row: string; readonly at: string; readonly message: string }>
  readonly hookShell: { readonly bash: string | null; readonly powershell: string }
  readonly bun?: string | null
  readonly versions?: { readonly forge: string | null; readonly dsh: string | null; readonly node: string }
  readonly failedMounts: ReadonlyArray<{ readonly pluginId: string; readonly kind: string; readonly name: string; readonly error: string }>
  readonly [key: string]: unknown
}

/** Product names; not translated. */
const PRODUCT = { forge: 'Harness Forge', dsh: 'DSH', node: 'Node.js' } as const

export function DiagnosticsScreen({ t }: { t: TFn }): JSX.Element {
  const [value, setValue] = useState<Diagnostics | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const run = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      setValue(await call<Diagnostics>('diagnostics'))
    } catch (cause: unknown) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => { void run() }, [run])

  const rowName = (row: string): string => (ROW_TITLE[row] !== undefined ? t(ROW_TITLE[row]) : row)

  return (
    <div>
      <div className="hf-section-head">
        <p className="hf-lead" style={{ margin: 0 }}>{t('diagnosticsLead')}</p>
        <button className="hf-btn" disabled={busy} onClick={() => { void run() }}>{busy ? t('diagChecking') : t('diagRun')}</button>
      </div>
      {error !== undefined ? <Notice kind="error">{error}</Notice> : null}
      {value === undefined ? null : (
        <>
          <section className="hf-section" style={{ marginTop: 16 }}>
            <h2 className="hf-section-title">{t('diagRows')}</h2>
            {value.faults.length === 0
              ? <div className="hf-card" style={{ marginTop: 8 }}>{t('diagRowsOk')}</div>
              : (
                <div className="hf-card" style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 13, marginBottom: 6 }}>{fill(t('diagFaults'), { n: value.faults.length })}</div>
                  {value.faults.map((fault, index) => (
                    <div key={index} className="hf-reason"><strong>{rowName(fault.row)}</strong> <span className="hf-code">{fault.message}</span></div>
                  ))}
                </div>
              )}
            {value.failedMounts.length > 0 ? (
              <div className="hf-card" style={{ marginTop: 8 }}>
                <div style={{ fontSize: 13, marginBottom: 6 }}>{t('diagFailedMounts')}</div>
                {value.failedMounts.map((mount, index) => (
                  <div key={index} className="hf-reason"><strong>{mount.name}</strong> <span className="hf-code">{mount.error}</span></div>
                ))}
              </div>
            ) : null}
          </section>
          <section className="hf-section">
            <dl className="hf-facts">
              <dt>{t('diagBash')}</dt><dd>{value.hookShell.bash ?? t('diagMissing')}</dd>
              <dt>{t('diagPowershell')}</dt><dd>{value.hookShell.powershell}</dd>
              {value.bun !== undefined ? <><dt>{t('diagBun')}</dt><dd>{value.bun ?? t('diagBunMissing')}</dd></> : null}
            </dl>
          </section>
          {value.versions !== undefined ? (
            <section className="hf-section">
              <h2 className="hf-section-title" style={{ marginBottom: 8 }}>{t('diagVersions')}</h2>
              <dl className="hf-facts">
                {(['forge', 'dsh', 'node'] as const).map(key => (
                  <span key={key} style={{ display: 'contents' }}><dt>{PRODUCT[key]}</dt><dd>{value.versions?.[key] ?? t('diagUnknown')}</dd></span>
                ))}
              </dl>
            </section>
          ) : null}
          <details className="hf-details">
            <summary>{t('diagDetails')}</summary>
            <div className="hf-brief">{JSON.stringify(value, null, 2)}</div>
          </details>
        </>
      )}
    </div>
  )
}
