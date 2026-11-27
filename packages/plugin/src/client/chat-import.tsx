/**
 * dsh-chat-import, recommended for session import: its pitch with an Install button (asking first), or, once it
 * runs, where its import is.
 * @module @kirkchinese/harness-forge/client
 */
import { useCallback, useEffect, useState } from 'react'
import { call } from './typert.js'
import { fill, messageOf, Notice, type TFn } from './shared.js'

export interface SessionImportStatus {
  readonly provider: 'harness-forge' | 'dsh-chat-import'
  readonly canInstall: boolean
  readonly command: string
}

/** Who imports sessions; `reload` reads it again. Undefined until known, or when the Host does not say. */
export function useSessionImport(): { status: SessionImportStatus | undefined; reload: () => Promise<SessionImportStatus | undefined> } {
  const [status, setStatus] = useState<SessionImportStatus | undefined>(undefined)
  const reload = useCallback(async (): Promise<SessionImportStatus | undefined> => {
    try {
      const value = await call<SessionImportStatus>('sessionImport')
      setStatus(value)
      return value
    } catch {
      return undefined
    }
  }, [])
  useEffect(() => { void reload() }, [reload])
  return { status, reload }
}

/** Where session import is while dsh-chat-import runs. */
export function ChatImportProvided({ t }: { t: TFn }): JSX.Element {
  return <div className="hf-card">{t('chatImportProvided')}</div>
}

/** The pitch for dsh-chat-import with its Install action, which asks before it installs. */
export function ChatImportOffer({ t, status, reload }: { t: TFn; status: SessionImportStatus; reload: () => Promise<SessionImportStatus | undefined> }): JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  const install = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    try {
      const result = await call<{ application: string; running: boolean }>('installChatImport')
      if (result.application === 'restart-required') {
        setNotice(t('chatImportRestart'))
        return
      }
      // The bundle loads right after the manager applies it; its service shows up a moment later.
      for (let attempt = 0; attempt < 20; attempt++) {
        if ((await reload())?.provider === 'dsh-chat-import') return
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      setNotice(t('chatImportInstalledLater'))
    } catch (cause: unknown) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  return (
    <div className="hf-card" aria-label="dsh-chat-import">
      <div>{t('chatImportPitch')}</div>
      {status.canInstall ? (
        <div className="hf-form" style={{ marginTop: 10 }}>
          {confirming ? (
            <>
              <span style={{ fontSize: 13 }}>{t('chatImportConfirm')}</span>
              <button className="hf-btn hf-btn-primary" disabled={busy} onClick={() => { void install() }}>{busy ? t('chatImportInstalling') : t('chatImportInstall')}</button>
              {busy ? null : <button className="hf-btn" onClick={() => { setConfirming(false) }}>{t('cancel')}</button>}
            </>
          ) : <button className="hf-btn" onClick={() => { setConfirming(true) }}>{t('chatImportInstall')}</button>}
        </div>
      ) : <div className="hf-muted" style={{ marginTop: 8 }}>{fill(t('chatImportCommand'), { command: status.command })}</div>}
      {error !== undefined ? <Notice kind="error">{error}</Notice> : null}
      {notice !== undefined ? <Notice>{notice}</Notice> : null}
    </div>
  )
}
