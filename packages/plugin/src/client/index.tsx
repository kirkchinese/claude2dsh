/**
 * Harness Forge browser half: the page and its sidebar entry. Three screens
 * (Discover & migrate, Migrated, Gaps) and, behind "More", Import sessions,
 * Settings and Diagnostics. Every request goes through the `harnessCompat`
 * Remote namespace.
 * @module @kirkchinese/harness-forge/client
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'

import en from './locale/en.json' with { type: 'json' }
import zh from './locale/zh.json' with { type: 'json' }
import contribution, { call, setMountedRemote, setMountedRemoteError } from './typert.js'
import { CSS } from './styles.js'
import { registerModsDock } from './mods.js'
import { isGap, messageOf, Notice, type Harness, type Key, type TFn, type Workspace } from './shared.js'
import { DiscoverScreen } from './discover.js'
import { MigratedScreen, TrustBanners } from './migrated.js'
import { GapsScreen } from './gaps.js'
import { DiagnosticsScreen, SessionsScreen, SettingsScreen } from './secondary.js'

const NS = 'harnessForge'
const PANEL_ID = 'harness-forge' as never
const INTRO_KEY = 'harness-forge.intro-dismissed'

/** Services the browser half needs before apply runs. */
export const inject = ['slots', 'locale', 'remote']

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    harnessForge: Key
  }
}

type Main = 'discover' | 'migrated' | 'gaps'
type Secondary = 'sessions' | 'settings' | 'diagnostics'
type Screen = Main | Secondary

const MAIN: ReadonlyArray<readonly [Main, Key]> = [['discover', 'tabDiscover'], ['migrated', 'tabMigrated'], ['gaps', 'tabGaps']]
const SECONDARY: ReadonlyArray<readonly [Secondary, Key]> = [['sessions', 'menuSessions'], ['settings', 'menuSettings'], ['diagnostics', 'menuDiagnostics']]

/** The client context, for actions outside React (opening a session). */
let clientCtx: ClientContext | undefined

function openSession(id: string): void {
  const workspace = clientCtx?.get('uiWorkspace') as { openSession?(target: string): void } | undefined
  workspace?.openSession?.(id)
}

/** The interface language (`en`, `zh`, …), which a port session's agent is told to talk in. */
function activeLanguage(): string | undefined {
  try {
    return (clientCtx as unknown as { locale?: { getLocale?(): { active?: string } } } | undefined)?.locale?.getLocale?.().active
  } catch {
    return undefined
  }
}

function readDismissed(): boolean {
  try {
    return globalThis.localStorage?.getItem(INTRO_KEY) === '1'
  } catch {
    return false
  }
}

function MoreMenu({ t, onPick }: { t: TFn; onPick: (screen: Secondary) => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (event: Event): void => { if (box.current !== null && !box.current.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', escape)
    }
  }, [open])
  return (
    <div ref={box} style={{ position: 'relative' }}>
      <button className="hf-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
        {t('more')}
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open ? (
        <div className="hf-menu" role="menu">
          {SECONDARY.map(([screen, label]) => (
            <button key={screen} role="menuitem" className="hf-menu-item" onClick={() => { setOpen(false); onPick(screen) }}>{t(label)}</button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function HarnessPage({ t }: { t: TFn }): JSX.Element {
  const [screen, setScreen] = useState<Screen>('discover')
  const [harnesses, setHarnesses] = useState<readonly Harness[] | undefined>(undefined)
  const [workspaces, setWorkspaces] = useState<readonly Workspace[]>([])
  const [signInWaiting, setSignInWaiting] = useState<readonly string[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [introDismissed, setIntroDismissed] = useState(readDismissed)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const overview = await call<{ harnesses: Harness[]; workspaces?: Workspace[] }>('overview')
      setHarnesses(overview.harnesses)
      setWorkspaces(overview.workspaces ?? [])
      setError(undefined)
    } catch (cause: unknown) {
      setError(messageOf(cause))
    } finally {
      setLoading(false)
    }
    // Sign-ins come from the MCP row; while it is off there are none to show.
    call<{ waiting: string[] }>('signIns').then((value) => { setSignInWaiting(value.waiting) }, () => { setSignInWaiting([]) })
  }, [])

  useEffect(() => { void load() }, [load])

  const dismissIntro = (): void => {
    setIntroDismissed(true)
    try {
      globalThis.localStorage?.setItem(INTRO_KEY, '1')
    } catch {
      // Not remembered: the intro shows again next time.
    }
  }

  const items = (harnesses ?? []).flatMap(harness => harness.items)
  const migrated = items.filter(item => item.installed)
  const gapCount = items.reduce((sum, item) => sum + item.parts.filter(isGap).length, 0)
  const counts: Record<Main, number> = { discover: 0, migrated: migrated.length, gaps: gapCount }
  const secondary = SECONDARY.find(([value]) => value === screen)

  return (
    <div className="hf-page">
      <style>{CSS}</style>
      <div className="hf-column">
        <div className="hf-head">
          <div style={{ minWidth: 0 }}>
            <h1 className="hf-title">{t('title')}</h1>
            <p className="hf-subtitle">{t('subtitle')}</p>
          </div>
          <div className="hf-actions">
            {secondary === undefined ? <button className="hf-btn" disabled={loading} onClick={() => { void load() }}>{t('refresh')}</button> : null}
            <MoreMenu t={t} onPick={setScreen} />
          </div>
        </div>

        {!introDismissed && secondary === undefined ? (
          <div className="hf-intro">
            <p>{t('intro')}</p>
            <button className="hf-btn" onClick={dismissIntro}>{t('introDismiss')}</button>
          </div>
        ) : null}

        {secondary !== undefined ? (
          <>
            <button className="hf-btn hf-btn-link hf-back" onClick={() => { setScreen('discover') }}>← {t('back')}</button>
            <h2 className="hf-title" style={{ fontSize: 16, margin: '4px 0 12px' }}>{t(secondary[1])}</h2>
          </>
        ) : (
          <div className="hf-tabs" role="tablist">
            {MAIN.map(([value, label]) => (
              <button key={value} role="tab" className="hf-tab" aria-selected={screen === value} onClick={() => { setScreen(value) }}>
                {t(label)}
                {counts[value] > 0 ? <span className="hf-count">{counts[value]}</span> : null}
              </button>
            ))}
          </div>
        )}

        {error !== undefined && secondary === undefined ? <Notice kind="error">{error}</Notice> : null}
        {secondary === undefined && harnesses === undefined && error === undefined ? <div className="hf-empty">{t('loading')}</div> : null}

        {screen === 'discover' || screen === 'migrated' ? <TrustBanners t={t} workspaces={workspaces} reload={load} /> : null}
        {harnesses !== undefined && screen === 'discover' ? <DiscoverScreen t={t} harnesses={harnesses} reload={load} /> : null}
        {harnesses !== undefined && screen === 'migrated' ? <MigratedScreen t={t} items={migrated} signInWaiting={signInWaiting} reload={load} /> : null}
        {harnesses !== undefined && screen === 'gaps' ? <GapsScreen t={t} items={items} openSession={openSession} language={activeLanguage()} reload={() => { void load() }} /> : null}
        {screen === 'sessions' ? <SessionsScreen t={t} openSession={openSession} /> : null}
        {screen === 'settings' ? <SettingsScreen t={t} onSaved={() => { void load() }} /> : null}
        {screen === 'diagnostics' ? <DiagnosticsScreen t={t} /> : null}
      </div>
    </div>
  )
}

function HarnessIcon({ size = 18 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M4 7h16M4 12h10M4 17h16" strokeLinecap="round" />
      <circle cx="18" cy="12" r="2" />
    </svg>
  )
}

/** Client plugin body. */
export function apply(ctx: ClientContext): void {
  clientCtx = ctx
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'harness-forge: locale')
  const t = ctx.locale.bind(NS) as TFn
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
  }, HarnessPage as never))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 30,
    locale: NS,
    label: () => t('panel'),
  }, HarnessIcon as never))
  registerModsDock(ctx)

  void (async () => {
    try {
      const context = ctx as unknown as {
        remote: { $mount(value: unknown): Promise<() => Promise<void>> }
        get(name: string): unknown
        root?: { get(name: string): unknown }
        ['remote.harnessCompat']?: unknown
      }
      await context.remote.$mount(contribution)
      await new Promise(resolve => setTimeout(resolve, 0))
      const namespace = context.get('remote.harnessCompat')
        ?? context.root?.get('remote.harnessCompat')
        ?? context['remote.harnessCompat']
      if (namespace === undefined) setMountedRemoteError(new Error('remote.harnessCompat was not registered'))
      else setMountedRemote(namespace)
    } catch (error: unknown) {
      setMountedRemoteError(error)
      ctx.logger?.warn?.('harness-forge: the harnessCompat Remote namespace did not mount', error)
    }
  })()
}
