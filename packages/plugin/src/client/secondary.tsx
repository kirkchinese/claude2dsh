/**
 * The pages behind "More": import sessions (or, while dsh-chat-import runs,
 * where its import is), settings (with what is added to new sessions, when
 * the Host reports it) and diagnostics.
 * @module @kirkchinese/harness-forge/client
 */
import { useCallback, useEffect, useState } from 'react'
import { call, CallError } from './typert.js'
import { fill, harnessName, messageOf, mountLabel, Notice, ROW_TITLE, type Source, type TFn } from './shared.js'
import { ChatImportOffer, ChatImportProvided, useSessionImport } from './chat-import.js'

export interface SessionView {
  readonly source: Source
  /** Where the session is: its file, or the database it shares with every other OpenCode session. */
  readonly path: string
  /** The session in its harness; with `source`, what tells the rows apart. */
  readonly sourceId: string
  readonly title?: string
  readonly cwd?: string
  readonly createdAt?: number
  readonly updatedAt?: number
  readonly archived?: boolean
  /** The transcript's size in bytes, when known. */
  readonly bytes?: number
  /** Above the import ceiling `limit` (bytes): it cannot be imported. */
  readonly tooLarge?: boolean
  readonly limit?: number
  /** The DSH session that already holds it. */
  readonly importedId?: string
  /** A DSH session that may hold it (nothing tells); "Import as new" writes `newId`. */
  readonly maybeImportedId?: string
  readonly newId?: string
}

/** A row's key: a source's sessions can share a path (OpenCode's one database), never a source id. */
export function rowKey(session: SessionView): string {
  return `${session.source}\u0000${session.sourceId}`
}

/** What one row of the list shows, given the imports done on this page (by row key) and the row being imported. */
export interface SessionRowState {
  readonly key: string
  readonly title: string
  /** The DSH session that holds it: "Open session". */
  readonly openId?: string
  /** A DSH session that may hold it: "Open existing" and "Import as new". */
  readonly maybeId?: string
  readonly importing: boolean
  /** Why it cannot be imported, for its size. */
  readonly tooLarge?: string
}

export function sessionRowState(t: TFn, session: SessionView, imported: Readonly<Record<string, string>>, busy: string | undefined): SessionRowState {
  const key = rowKey(session)
  const openId = imported[key] ?? session.importedId
  const maybeId = openId === undefined ? session.maybeImportedId : undefined
  return {
    key,
    title: session.title ?? t('sessionUntitled'),
    ...(openId !== undefined ? { openId } : {}),
    ...(maybeId !== undefined ? { maybeId } : {}),
    importing: busy === key,
    ...(session.tooLarge === true ? { tooLarge: tooLargeText(t, session.bytes, session.limit ?? 0) } : {}),
  }
}

/** Decimal megabytes, as the server's own messages say them. */
function megabytes(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`
}

/** Why a session cannot be imported for its size, in the person's language; `size` is unknown for a compressed one cut off while decoding. */
function tooLargeText(t: TFn, size: number | undefined, limit: number): string {
  return size !== undefined
    ? fill(t('sessionTooLarge'), { size: megabytes(size), limit: megabytes(limit) })
    : fill(t('sessionTooLargeDecoded'), { limit: megabytes(limit) })
}

/** Why an import failed, in the person's language when the server said it with a code. */
export function importErrorText(t: TFn, cause: unknown): string {
  if (cause instanceof CallError && cause.code === 'harness-forge/session-too-large') {
    const { size, limit } = cause.details ?? {}
    if (typeof limit === 'number') return tooLargeText(t, typeof size === 'number' ? size : undefined, limit)
  }
  if (cause instanceof CallError && cause.code === 'harness-forge/session-maybe-imported') return t('sessionMaybeImported')
  return messageOf(cause)
}

interface SessionPageView {
  readonly sessions: SessionView[]
  readonly next?: number
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
  const [next, setNext] = useState<number | undefined>(undefined)
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [imported, setImported] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  useEffect(() => {
    let live = true
    setSessions(undefined)
    setNext(undefined)
    setError(undefined)
    call<SessionPageView>('sessions', { source })
      .then((result) => { if (live) { setSessions(result.sessions); setNext(result.next) } })
      .catch((cause: unknown) => { if (live) { setSessions([]); setError(messageOf(cause)) } })
    return () => { live = false }
  }, [source])

  const showMore = async (): Promise<void> => {
    if (next === undefined) return
    setMore(true)
    try {
      const result = await call<SessionPageView>('sessions', { source, cursor: next })
      setSessions(current => [...(current ?? []), ...result.sessions])
      setNext(result.next)
    } catch (cause: unknown) {
      setError(messageOf(cause))
    } finally {
      setMore(false)
    }
  }

  /**
   * Open a session an import stored. DSH is asked to know it again first (workspace, live) and to take it out of
   * its archive: an archived session opens as an empty new-session page, so one that stays archived is not opened.
   */
  const openOne = async (id: string): Promise<void> => {
    setError(undefined)
    setNotice(undefined)
    try {
      const opened = await call<{ unarchived: boolean; archived: boolean }>('openImported', { id })
      if (opened.archived) {
        setError(t('sessionStillArchived'))
        return
      }
      if (opened.unarchived) setNotice(t('sessionUnarchived'))
      openSession(id)
    } catch (cause: unknown) {
      setError(messageOf(cause))
    }
  }

  /** Import a session; `targetId` imports it as a new session under that id. */
  const importOne = async (session: SessionView, targetId?: string): Promise<void> => {
    const key = rowKey(session)
    setBusy(key)
    setError(undefined)
    try {
      const result = await call<{ id: string }>('importSession', { path: session.path, source: session.source, sourceId: session.sourceId, ...(targetId !== undefined ? { targetId } : {}) })
      setImported(current => ({ ...current, [key]: result.id }))
    } catch (cause: unknown) {
      setError(importErrorText(t, cause))
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
      {notice !== undefined ? <Notice>{notice}</Notice> : null}
      {sessions === undefined
        ? <div className="hf-empty">{t('sessionsLoading')}</div>
        : sessions.length === 0
          ? <div className="hf-empty">{t('sessionsEmpty')}</div>
          : (
            <ul className="hf-list">
              {sessions.map((session) => {
                const { key, title, openId: id, maybeId: maybe, importing, tooLarge: sizeText } = sessionRowState(t, session, imported, busy)
                return (
                  <li key={key} className="hf-item">
                    <div className="hf-item-head">
                      <span className="hf-item-main">
                        <span className="hf-item-title">{title}</span>
                        <span className="hf-item-desc">
                          {(session.updatedAt ?? session.createdAt) !== undefined ? `${new Date((session.updatedAt ?? session.createdAt)!).toLocaleString()} · ` : ''}{session.archived === true ? `${t('sessionArchived')} · ` : ''}{session.cwd ?? session.path}
                        </span>
                        {sizeText !== undefined && id === undefined ? <span className="hf-item-desc">{sizeText}</span> : null}
                        {maybe !== undefined ? <span className="hf-item-desc">{t('sessionMaybeImported')}</span> : null}
                      </span>
                      {id !== undefined
                        ? <button className="hf-btn" onClick={() => { void openOne(id) }}>{t('openSession')}</button>
                        : maybe !== undefined
                          ? (
                            <span className="hf-form">
                              <button className="hf-btn" onClick={() => { void openOne(maybe) }}>{t('sessionOpenExisting')}</button>
                              <button className="hf-btn" disabled={busy !== undefined || sizeText !== undefined} title={sizeText} onClick={() => { void importOne(session, session.newId) }}>{importing ? t('sessionImporting') : t('sessionImportAsNew')}</button>
                            </span>
                          )
                          : <button className="hf-btn" disabled={busy !== undefined || sizeText !== undefined} title={sizeText} onClick={() => { void importOne(session) }}>{importing ? t('sessionImporting') : t('sessionImport')}</button>}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
      {next !== undefined
        ? <div style={{ marginTop: 12 }}><button className="hf-btn" disabled={more} onClick={() => { void showMore() }}>{more ? t('sessionsLoading') : t('sessionsMore')}</button></div>
        : null}
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
  /** Set when reading stopped at a limit: why, and where. */
  readonly stopped?: string
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
      {status?.stopped !== undefined ? <Notice kind="error">{status.stopped}</Notice> : null}
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
  const [skipped, setSkipped] = useState<readonly string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  const load = useCallback(async (): Promise<void> => {
    try {
      const view = await call<{ settings: Settings; missingRoots: readonly string[]; warnings?: ReadonlyArray<{ readonly message: string }> }>('discover')
      setRoots(view.settings.discoveryRoots.join('\n'))
      setAutoDiscover(view.settings.autoDiscover)
      setMissing(view.missingRoots)
      setSkipped((view.warnings ?? []).map(warning => warning.message))
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
        {skipped.map(message => <div key={message} className="hf-muted" style={{ marginTop: 6 }}>{fill(t('discoverySkipped'), { message })}</div>)}
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
  readonly failedMounts: ReadonlyArray<{ readonly pluginId: string; readonly plugin?: string; readonly kind: string; readonly name: string; readonly events?: readonly string[]; readonly error: string }>
  /** Harness Forge's own parts (`faults`) and the migrated parts (`failedMounts`), counted apart. */
  readonly summary?: { readonly ok: boolean; readonly faults: number; readonly failedMounts: number }
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
              ? <div className="hf-card" style={{ marginTop: 8 }}>{t(value.failedMounts.length === 0 ? 'diagAllOk' : 'diagRowsOk')}</div>
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
                <div style={{ fontSize: 13, marginBottom: 6 }}>{fill(t('diagFailedMounts'), { n: value.failedMounts.length })}</div>
                {value.failedMounts.map((mount, index) => (
                  <div key={index} className="hf-reason">
                    <strong>{mount.plugin ?? mount.pluginId}</strong> · {mountLabel(mount, t)}
                    {mount.error.length > 0 ? <div className="hf-code">{mount.error}</div> : null}
                  </div>
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
