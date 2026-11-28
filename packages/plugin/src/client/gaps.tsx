/**
 * Gaps: every part that can't fully run in DSH, why, and for those an
 * adapter could fill, a "Fill with AI" button: one click starts a session in
 * DSH's creation mode with the part's task (`portGap`) and opens it. "View
 * task" shows that task first (`portBrief`). While a port session exists the
 * part shows "In progress" with a link to it (`portSessions`); once
 * `harness_verify_port` confirmed the adapter, the covered part shows "Done —
 * verified". Parts adapters already cover are listed apart. While the porter
 * row is off the button does not show, and the page says why.
 * @module @kirkchinese/harness-forge/client
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { call } from './typert.js'
import { useText } from './paths.js'
import { fill, harnessName, isGap, itemName, kindLabel, messageOf, Notice, Reasons, StateLabel, type Item, type Part, type TFn } from './shared.js'

interface Gap {
  readonly item: Item
  readonly part: Part
}

/** A recorded port of one part (the Host's `portSessions`). */
interface Port {
  readonly pluginId: string
  readonly componentId: string
  readonly state: 'in-progress' | 'verified'
  readonly sessionId?: string
  readonly verifiedAt?: string
  readonly adapter?: string
}

/** Whether the Host can port now: unknown until asked, else why not. */
type Porting = 'unknown' | 'available' | { readonly unavailable: string }

/** How often the screen asks again while a port is in progress, in milliseconds. */
const POLL_MS = 5_000

const keyOf = (pluginId: string, componentId: string): string => `${pluginId}/${componentId}`

export function TaskPanel({ gap, t, language, onClose }: { gap: Gap; t: TFn; language: string | undefined; onClose: () => void }): JSX.Element {
  const [task, setTask] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let live = true
    call<{ markdown: string }>('portBrief', { pluginId: gap.item.id, componentId: gap.part.id, ...(language !== undefined ? { language } : {}) })
      .then((result) => { if (live) setTask(result.markdown) })
      .catch((cause: unknown) => { if (live) setError(messageOf(cause)) })
    return () => { live = false }
  }, [gap.item.id, gap.part.id, language])

  return (
    <div className="hf-card" style={{ margin: '4px 0 10px' }}>
      <div className="hf-section-title">{t('fillPreviewTitle')}</div>
      {task === undefined && error === undefined ? <div className="hf-muted" style={{ marginTop: 8 }}>{t('fillPreviewLoading')}</div> : null}
      {task !== undefined ? <div className="hf-brief">{task}</div> : null}
      {error !== undefined ? <Notice kind="error">{error}</Notice> : null}
      <div className="hf-form" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
        <button className="hf-btn" aria-label={t('closeTaskLabel')} onClick={onClose}>{t('close')}</button>
      </div>
    </div>
  )
}

/** The port's progress, as a coloured label. */
function PortLabel({ state, t }: { state: Port['state']; t: TFn }): JSX.Element {
  const color = state === 'verified' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-business-primary)'
  return <span className="hf-part-state" style={{ width: 'auto' }}><span className="hf-dot" style={{ background: color }} />{t(state === 'verified' ? 'portVerified' : 'portInProgress')}</span>
}

function GapRow({ gap, t, porting, port, language, openSession, onStarted }: {
  gap: Gap
  t: TFn
  porting: Porting
  port: Port | undefined
  language: string | undefined
  openSession: (id: string) => void
  onStarted: (sessionId: string) => void
}): JSX.Element {
  const { item, part } = gap
  const [viewing, setViewing] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const session = port?.sessionId

  const start = async (): Promise<void> => {
    setStarting(true)
    setError(undefined)
    try {
      const result = await call<{ sessionId: string }>('portGap', { pluginId: item.id, componentId: part.id, ...(language !== undefined ? { language } : {}) })
      onStarted(result.sessionId)
      openSession(result.sessionId)
    } catch (cause: unknown) {
      setError(messageOf(cause))
    } finally {
      setStarting(false)
    }
  }

  const portable = part.portGap !== undefined && porting === 'available'
  return (
    <li className="hf-item" data-part={part.id}>
      <div className="hf-item-head" style={{ alignItems: 'flex-start' }}>
        <StateLabel state={part.state} t={t} />
        <span className="hf-item-main">
          <span className="hf-item-title" style={{ whiteSpace: 'normal' }}>
            <span><span className="hf-part-kind">{kindLabel(part.kind, t)}</span>{part.name}</span>
          </span>
          <span className="hf-item-desc">
            {itemName(item, t)} · {harnessName(item.source)}{item.installed ? '' : ` · ${t('notMigratedTag')}`}
          </span>
          <Reasons part={part} t={t} />
        </span>
        <span className="hf-actions" style={{ flex: 'none', alignItems: 'center' }}>
          {session !== undefined ? (
            <>
              <PortLabel state="in-progress" t={t} />
              <button className="hf-btn hf-btn-primary" onClick={() => { openSession(session) }}>{t('openConversation')}</button>
            </>
          ) : portable ? (
            <button className="hf-btn hf-btn-primary" disabled={starting} onClick={() => { void start() }}>{starting ? t('fillStarting') : t('fillWithAi')}</button>
          ) : null}
          {portable && !viewing ? <button className="hf-btn hf-btn-link" onClick={() => { setViewing(true) }}>{t('viewTask')}</button> : null}
        </span>
      </div>
      {error !== undefined ? <div style={{ padding: '0 8px' }}><Notice kind="error">{error}</Notice></div> : null}
      {viewing ? <div style={{ padding: '0 8px' }}><TaskPanel gap={gap} t={t} language={language} onClose={() => { setViewing(false) }} /></div> : null}
    </li>
  )
}

export function GapsScreen({ t, items, openSession, language, reload }: {
  t: TFn
  items: readonly Item[]
  openSession: (id: string) => void
  /** The interface language, which the creation agent is told to talk in. */
  language?: string | undefined
  /** Read the overview again (a part an adapter now covers moves to "Covered"). */
  reload?: () => void
}): JSX.Element {
  const shown = useText()
  const gaps: Gap[] = items.flatMap(item => item.parts.filter(isGap).map(part => ({ item, part })))
  const covered: Gap[] = items.flatMap(item => item.parts.filter(part => part.adapter !== undefined).map(part => ({ item, part })))
  const [porting, setPorting] = useState<Porting>('unknown')
  const [ports, setPorts] = useState<ReadonlyMap<string, Port>>(new Map())
  const verified = useRef<string | undefined>(undefined)
  const reloadRef = useRef(reload)
  reloadRef.current = reload
  const probe = gaps.find(gap => gap.part.portGap !== undefined)

  // Ask once, with a read-only task, whether porting works now (its row may be off).
  useEffect(() => {
    if (porting !== 'unknown' || probe === undefined) return
    let live = true
    call('portBrief', { pluginId: probe.item.id, componentId: probe.part.id })
      .then(() => { if (live) setPorting('available') })
      .catch((cause: unknown) => { if (live) setPorting({ unavailable: messageOf(cause) }) })
    return () => { live = false }
  }, [porting, probe?.item.id, probe?.part.id])

  const readPorts = useCallback(async (): Promise<void> => {
    try {
      const result = await call<{ ports: Port[] }>('portSessions')
      setPorts(new Map(result.ports.map(port => [keyOf(port.pluginId, port.componentId), port])))
      // A port newly verified: the overview moves its part to "Covered".
      const done = result.ports.filter(port => port.state === 'verified').map(port => keyOf(port.pluginId, port.componentId)).sort().join('\n')
      if (verified.current !== undefined && done !== verified.current) reloadRef.current?.()
      verified.current = done
    } catch {
      // Without the record the screen still offers porting; progress shows again on the next read.
    }
  }, [])

  useEffect(() => { void readPorts() }, [readPorts])
  const inProgress = [...ports.values()].some(port => port.state === 'in-progress')
  useEffect(() => {
    if (!inProgress) return
    const timer = setInterval(() => { void readPorts() }, POLL_MS)
    return () => { clearInterval(timer) }
  }, [inProgress, readPorts])

  const started = (gap: Gap) => (sessionId: string): void => {
    setPorts(current => new Map([...current, [keyOf(gap.item.id, gap.part.id), { pluginId: gap.item.id, componentId: gap.part.id, state: 'in-progress', sessionId }]]))
  }

  return (
    <div>
      <p className="hf-lead" style={{ marginTop: 0 }}>{t('gapsLead')}</p>
      {typeof porting === 'object' ? <p className="hf-muted" style={{ margin: '-8px 0 16px' }}>{t('fillUnavailable')} <span className="hf-code">{shown(porting.unavailable)}</span></p> : null}
      {gaps.length === 0
        ? <div className="hf-empty">{t('gapsEmpty')}</div>
        : (
          <ul className="hf-list" style={{ marginBottom: 32 }}>
            {gaps.map((gap) => {
              const key = keyOf(gap.item.id, gap.part.id)
              return (
                <GapRow key={key} gap={gap} t={t} porting={porting} port={ports.get(key)} language={language} openSession={openSession} onStarted={started(gap)} />
              )
            })}
          </ul>
        )}
      {covered.length > 0 ? (
        <section className="hf-section">
          <h2 className="hf-section-title">{t('coveredTitle')}</h2>
          <p className="hf-lead" style={{ margin: '2px 0 8px' }}>{t('coveredLead')}</p>
          <ul className="hf-list">
            {covered.map(({ item, part }) => {
              const port = ports.get(keyOf(item.id, part.id))
              const session = port?.sessionId
              return (
                <li key={`${item.id}/${part.id}`} className="hf-item" data-part={part.id}>
                  <div className="hf-item-head">
                    <span className="hf-item-main">
                      <span className="hf-item-title"><span><span className="hf-part-kind">{kindLabel(part.kind, t)}</span>{part.name}</span></span>
                      <span className="hf-item-desc">{itemName(item, t)} · {fill(t('coveredBy'), { name: part.adapter ?? '' })}</span>
                    </span>
                    <span className="hf-actions" style={{ flex: 'none', alignItems: 'center' }}>
                      {port !== undefined ? <PortLabel state={port.state} t={t} /> : null}
                      {session !== undefined ? <button className="hf-btn" onClick={() => { openSession(session) }}>{t('openConversation')}</button> : null}
                    </span>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
