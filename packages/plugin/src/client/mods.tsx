/**
 * Claude Code mods in the conversation: the band a session's mods draw above
 * the prompt and the panes they open, as the Host renders them (`ui.render`
 * on the desktop surface). Every control runs on the Host: a press, a
 * submitted input or a picked option goes back as an action and the drawing
 * that follows replaces this one.
 * @module @kirkchinese/harness-forge/client
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { call, stream } from './typert.js'
import type { TFn } from './shared.js'

/** A node as the Host serialized it. */
type ModNode = string | ModElement

interface ModElement {
  readonly type: string
  readonly props: Readonly<Record<string, unknown>>
  readonly children: readonly ModNode[]
  readonly actions?: Readonly<Record<string, string>>
}

interface PaneSnapshot {
  readonly plugin: string
  readonly id: string
  readonly title: string
  readonly tree: ModNode | null
  readonly error?: string
}

interface SurfaceSnapshot {
  readonly generation: number
  readonly band: ModNode | null
  readonly bandError?: string
  readonly panes: readonly PaneSnapshot[]
}

/** The session's drawings, fed by the Host's `modSurfaces` stream. */
class SurfaceStore {
  private snapshot: SurfaceSnapshot | undefined
  private readonly listeners = new Set<() => void>()
  private source: { dispose(): void } | undefined
  private opening = false
  private disposed = false

  constructor(private readonly sessionId: string) {}

  getSnapshot = (): SurfaceSnapshot | undefined => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    this.open()
    return () => { this.listeners.delete(listener) }
  }

  set(next: SurfaceSnapshot): void {
    if (this.snapshot !== undefined && next.generation < this.snapshot.generation) return
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }

  private open(): void {
    if (this.source !== undefined || this.opening || this.disposed) return
    this.opening = true
    void (async () => {
      try {
        const handle = await stream<SurfaceSnapshot>('modSurfaces', { session: this.sessionId })
        this.source = handle
        // The stream ends at once when the session's mods draw nothing.
        for await (const snapshot of handle) this.set(snapshot)
      } catch {
        // A dropped stream is reopened by the next subscriber.
      } finally {
        this.source = undefined
        this.opening = false
      }
    })()
  }

  dispose(): void {
    this.disposed = true
    this.source?.dispose()
    this.source = undefined
    this.listeners.clear()
  }
}

// -----------------------------------------------------------------------------
// Drawing
// -----------------------------------------------------------------------------

/** Claude Code's theme names, on DSH's alias tokens. */
const THEME: Readonly<Record<string, string>> = {
  text: 'var(--dsw-alias-label-primary, #1f2328)',
  subtle: 'var(--dsw-alias-label-secondary, #59636e)',
  inactive: 'var(--dsw-alias-label-tertiary, #8c959f)',
  suggestion: 'var(--dsw-alias-link, #4d6bfe)',
  permission: 'var(--dsw-alias-link, #4d6bfe)',
  claude: '#d97757',
  success: 'var(--dsw-alias-state-success-primary, #1a7f37)',
  error: 'var(--dsw-alias-state-error-primary, #cf222e)',
  warning: 'var(--dsw-alias-state-warn-label, #9a6700)',
  diffAdded: 'rgba(46, 160, 67, 0.15)',
  diffRemoved: 'rgba(248, 81, 73, 0.15)',
  diffAddedWord: '#1a7f37',
  diffRemovedWord: '#cf222e',
  red: '#cf222e', green: '#1a7f37', yellow: '#9a6700', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83',
  white: '#f6f8fa', black: '#1f2328', gray: '#8c959f', grey: '#8c959f',
}

function color(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  if (/^#[0-9a-f]{3,8}$/iu.test(value) || /^rgba?\(/iu.test(value)) return value
  return THEME[value] ?? THEME[value.replace(/^ansi:?/iu, '').replace(/Bright$/u, '').toLowerCase()]
}

const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
const cols = (value: unknown): string | undefined => (typeof value === 'number' ? `${value}ch` : typeof value === 'string' ? value : undefined)

function boxStyle(props: Readonly<Record<string, unknown>>): CSSProperties {
  const direction = typeof props['flexDirection'] === 'string' ? props['flexDirection'] as CSSProperties['flexDirection'] : 'column'
  const isRow = direction === 'row' || direction === 'row-reverse'
  const gap = num(props['gap'])
  const style: CSSProperties = {
    display: props['display'] === 'none' ? 'none' : 'flex',
    flexDirection: direction,
    minWidth: 0,
    ...(gap !== undefined ? { gap: isRow ? `0 ${gap}ch` : `${gap * 0.5}em 0` } : {}),
    ...(num(props['columnGap']) !== undefined ? { columnGap: `${num(props['columnGap'])}ch` } : {}),
    ...(num(props['rowGap']) !== undefined ? { rowGap: `${(num(props['rowGap']) ?? 0) * 0.5}em` } : {}),
    ...(num(props['flexGrow']) !== undefined ? { flexGrow: num(props['flexGrow']) } : {}),
    ...(num(props['flexShrink']) !== undefined ? { flexShrink: num(props['flexShrink']) } : {}),
    ...(typeof props['flexWrap'] === 'string' ? { flexWrap: props['flexWrap'] as CSSProperties['flexWrap'] } : {}),
    ...(typeof props['alignItems'] === 'string' ? { alignItems: props['alignItems'] as string } : {}),
    ...(typeof props['alignSelf'] === 'string' ? { alignSelf: props['alignSelf'] as string } : {}),
    ...(typeof props['justifyContent'] === 'string' ? { justifyContent: props['justifyContent'] as string } : {}),
    ...(props['width'] !== undefined ? { width: cols(props['width']), maxWidth: '100%' } : {}),
    ...(props['minWidth'] !== undefined ? { minWidth: cols(props['minWidth']) } : {}),
    ...(typeof props['height'] === 'number' ? { height: `${props['height'] * 1.5}em` } : {}),
    ...(props['overflow'] === 'hidden' ? { overflow: 'hidden' } : {}),
    ...(color(props['backgroundColor']) !== undefined ? { background: color(props['backgroundColor']) } : {}),
  }
  const pad = (side: string, value: unknown, horizontal: boolean): void => {
    const amount = num(value)
    if (amount !== undefined) (style as Record<string, string>)[side] = horizontal ? `${amount}ch` : `${amount * 0.5}em`
  }
  pad('paddingLeft', props['paddingLeft'] ?? props['paddingX'] ?? props['padding'], true)
  pad('paddingRight', props['paddingRight'] ?? props['paddingX'] ?? props['padding'], true)
  pad('paddingTop', props['paddingTop'] ?? props['paddingY'] ?? props['padding'], false)
  pad('paddingBottom', props['paddingBottom'] ?? props['paddingY'] ?? props['padding'], false)
  pad('marginLeft', props['marginLeft'] ?? props['marginX'] ?? props['margin'], true)
  pad('marginRight', props['marginRight'] ?? props['marginX'] ?? props['margin'], true)
  pad('marginTop', props['marginTop'] ?? props['marginY'] ?? props['margin'], false)
  pad('marginBottom', props['marginBottom'] ?? props['marginY'] ?? props['margin'], false)
  if (typeof props['borderStyle'] === 'string') {
    style.border = `1px ${props['borderStyle'] === 'double' ? 'double' : props['borderStyle'] === 'bold' ? 'solid' : 'solid'} ${color(props['borderColor']) ?? 'var(--dsw-alias-border-l2, #d0d7de)'}`
    style.borderRadius = props['borderStyle'] === 'round' ? 8 : 4
    if (props['borderDimColor'] === true) style.opacity = 0.85
  }
  return style
}

function textStyle(props: Readonly<Record<string, unknown>>): CSSProperties {
  const wrap = typeof props['wrap'] === 'string' ? props['wrap'] : 'wrap'
  return {
    ...(color(props['color']) !== undefined ? { color: color(props['color']) } : {}),
    ...(color(props['backgroundColor']) !== undefined ? { background: color(props['backgroundColor']) } : {}),
    ...(props['bold'] === true ? { fontWeight: 600 } : {}),
    ...(props['italic'] === true ? { fontStyle: 'italic' } : {}),
    ...(props['dimColor'] === true ? { opacity: 0.6 } : {}),
    textDecoration: [props['underline'] === true ? 'underline' : '', props['strikethrough'] === true ? 'line-through' : ''].filter(Boolean).join(' ') || undefined,
    ...(props['inverse'] === true ? { filter: 'invert(1)' } : {}),
    whiteSpace: wrap.startsWith('truncate') ? 'nowrap' : 'pre-wrap',
    ...(wrap.startsWith('truncate') ? { overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 } : {}),
  }
}

interface DrawContext {
  readonly busy: string | undefined
  act(action: string, value?: unknown): void
  /** The person moved the keyboard focus to a keyed control. */
  focus(key: string): void
}

function textOf(node: ModNode): string {
  return typeof node === 'string' ? node : node.children.map(textOf).join('')
}

function Draw({ node, draw }: { node: ModNode; draw: DrawContext }): ReactNode {
  if (typeof node === 'string') return node
  const children = node.children.map((child, index) => <Draw key={index} node={child} draw={draw} />)
  const props = node.props
  switch (node.type) {
    case 'Text':
      return <span style={textStyle(props)}>{children}</span>
    case 'Box':
      return <div style={boxStyle(props)}>{children}</div>
    case 'Button': {
      const action = node.actions?.['press']
      const label = typeof props['label'] === 'string' ? props['label'] : textOf(node)
      const hotkey = typeof props['hotkey'] === 'string' ? props['hotkey'] : undefined
      const plain = props['plain'] === true
      return (
        <button
          type="button"
          className={plain ? 'hf-mod-button hf-mod-button-plain' : 'hf-mod-button'}
          disabled={action === undefined || draw.busy !== undefined}
          aria-busy={draw.busy === action}
          style={props['dimColor'] === true ? { opacity: 0.6 } : undefined}
          onClick={() => { if (action !== undefined) draw.act(action) }}
          onFocus={() => { if (typeof props['key'] === 'string') draw.focus(props['key']) }}
          title={hotkey === undefined ? undefined : `${hotkey}`}
        >
          {plain && hotkey !== undefined ? <span className="hf-mod-hotkey">{hotkey}:</span> : null}
          {node.children.length > 0 ? children : label}
        </button>
      )
    }
    case 'Link': {
      const href = typeof props['href'] === 'string' ? props['href'] : '#'
      return <a href={href} target="_blank" rel="noreferrer" className="hf-mod-link">{node.children.length > 0 ? children : String(props['label'] ?? href)}</a>
    }
    case 'Code':
      return <CodeBlock props={props} />
    case 'Markdown':
      return <MarkdownBlock text={String(props['text'] ?? '')} dim={props['dimColor'] === true} />
    case 'Input':
      return <InputControl node={node} draw={draw} />
    case 'Select': {
      const action = node.actions?.['select']
      const options = Array.isArray(props['options']) ? props['options'] as Array<{ value?: unknown; label?: unknown }> : []
      return (
        <label className="hf-mod-field">
          {typeof props['label'] === 'string' ? <span>{props['label']}</span> : null}
          <select
            value={typeof props['value'] === 'string' ? props['value'] : undefined}
            disabled={action === undefined || draw.busy !== undefined}
            onChange={(event) => { if (action !== undefined) draw.act(action, event.target.value) }}
          >
            {options.map(option => <option key={String(option.value)} value={String(option.value)}>{String(option.label ?? option.value)}</option>)}
          </select>
        </label>
      )
    }
    case 'Svg': {
      const source = String(props['source'] ?? '')
      const width = num(props['width'])
      const height = num(props['height'])
      return <img alt={String(props['alt'] ?? '')} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`} style={{ maxWidth: '100%', ...(width !== undefined ? { width: `${width}ch` } : {}), ...(height !== undefined ? { height: `${height * 1.5}em` } : {}) }} />
    }
    default:
      return <span className="hf-mod-unsupported">[{node.type}]</span>
  }
}

function CodeBlock({ props }: { props: Readonly<Record<string, unknown>> }): ReactNode {
  const source = String(props['source'] ?? '')
  const isDiff = props['format'] === 'diff' || props['language'] === 'diff'
  const start = num(props['startLine'])
  const lines = source.split('\n')
  return (
    <pre className="hf-mod-code" style={{ whiteSpace: props['wrap'] === 'truncate-end' ? 'pre' : 'pre-wrap' }}>
      {typeof props['path'] === 'string' ? <div className="hf-mod-code-path">{props['path']}</div> : null}
      {lines.map((line, index) => {
        const tone = !isDiff ? undefined : line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : undefined
        return (
          <div key={index} className={tone === undefined ? undefined : `hf-mod-diff-${tone}`}>
            {start !== undefined ? <span className="hf-mod-gutter">{start + index}</span> : null}
            {line.length > 0 ? line : ' '}
          </div>
        )
      })}
    </pre>
  )
}

/** Markdown as a reader sees it: headings, lists, fenced code, inline code and emphasis. */
function MarkdownBlock({ text, dim }: { text: string; dim: boolean }): ReactNode {
  const blocks: ReactNode[] = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    if (line.startsWith('```')) {
      const body: string[] = []
      for (index++; index < lines.length && !(lines[index] ?? '').startsWith('```'); index++) body.push(lines[index] ?? '')
      blocks.push(<pre key={blocks.length} className="hf-mod-code">{body.join('\n')}</pre>)
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/u.exec(line)
    if (heading !== null) {
      blocks.push(<div key={blocks.length} style={{ fontWeight: 650, fontSize: heading[1]!.length <= 2 ? '1.05em' : '1em', margin: '0.3em 0 0.1em' }}>{inline(heading[2] ?? '')}</div>)
      continue
    }
    const item = /^\s*[-*]\s+(.*)$/u.exec(line)
    if (item !== null) {
      blocks.push(<div key={blocks.length} style={{ paddingLeft: '1.2em', textIndent: '-0.8em' }}>• {inline(item[1] ?? '')}</div>)
      continue
    }
    blocks.push(line.trim().length === 0 ? <div key={blocks.length} style={{ height: '0.5em' }} /> : <div key={blocks.length}>{inline(line)}</div>)
  }
  return <div style={dim ? { opacity: 0.65 } : undefined}>{blocks}</div>
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/gu
  let last = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) out.push(text.slice(last, match.index))
    const token = match[0]
    if (token.startsWith('`')) out.push(<code key={out.length} className="hf-mod-inline-code">{token.slice(1, -1)}</code>)
    else if (token.startsWith('**')) out.push(<strong key={out.length}>{token.slice(2, -2)}</strong>)
    else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/u.exec(token)
      out.push(<a key={out.length} href={link?.[2]} target="_blank" rel="noreferrer" className="hf-mod-link">{link?.[1]}</a>)
    }
    last = match.index + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function InputControl({ node, draw }: { node: ModElement; draw: DrawContext }): ReactNode {
  const props = node.props
  const [value, setValue] = useState(typeof props['value'] === 'string' ? props['value'] : '')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const submit = node.actions?.['submit']
  const change = node.actions?.['input']
  useEffect(() => () => { if (timer.current !== undefined) clearTimeout(timer.current) }, [])
  return (
    <form
      className="hf-mod-field"
      onSubmit={(event) => {
        event.preventDefault()
        if (submit !== undefined) draw.act(submit, value)
      }}
    >
      {typeof props['label'] === 'string' ? <span>{props['label']}</span> : null}
      <input
        value={value}
        placeholder={typeof props['placeholder'] === 'string' ? props['placeholder'] : undefined}
        autoFocus={props['autoFocus'] === true}
        onChange={(event) => {
          setValue(event.target.value)
          if (change === undefined) return
          if (timer.current !== undefined) clearTimeout(timer.current)
          const text = event.target.value
          timer.current = setTimeout(() => { draw.act(change, text) }, 300)
        }}
      />
      {submit !== undefined ? <button type="submit" className="hf-mod-button" disabled={draw.busy !== undefined}>{typeof props['submitLabel'] === 'string' ? props['submitLabel'] : 'OK'}</button> : null}
    </form>
  )
}

// -----------------------------------------------------------------------------
// The dock entry
// -----------------------------------------------------------------------------

const CSS = `
.hf-mods { display: flex; flex-direction: column; gap: 8px; margin: 0 0 8px; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary, #1f2328); font-variant-numeric: tabular-nums; }
.hf-mods-band { padding: 6px 12px; border: 1px solid var(--dsw-alias-border-l2, #d0d7de); border-radius: 12px; background: var(--dsw-alias-settings-card-fill, #f6f8fa); overflow-x: auto; }
.hf-mods-pane { border: 1px solid var(--dsw-alias-border-l2, #d0d7de); border-radius: 12px; background: var(--dsw-alias-bg-base, #fff); overflow: hidden; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
.hf-mods-pane-head { display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 12px; border-bottom: 1px solid var(--dsw-alias-border-l2, #d0d7de); background: var(--dsw-alias-settings-card-fill, #f6f8fa); }
.hf-mods-pane-title { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hf-mods-pane-plugin { font-size: 11px; opacity: 0.6; }
.hf-mods-pane-body { padding: 8px 12px; max-height: 42vh; overflow: auto; }
.hf-mods-icon { border: 0; background: transparent; cursor: pointer; padding: 2px 6px; border-radius: 6px; color: inherit; font-size: 14px; line-height: 1; opacity: 0.7; }
.hf-mods-icon:hover { opacity: 1; background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06)); }
.hf-mods-error { color: var(--dsw-alias-state-error-primary, #cf222e); font-size: 12px; }
.hf-mods-notice { font-size: 12px; opacity: 0.75; }
.hf-mod-button { font: inherit; padding: 1px 10px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2, #d0d7de); background: var(--dsw-alias-bg-base, #fff); color: inherit; cursor: pointer; white-space: nowrap; }
.hf-mod-button:hover:not(:disabled) { border-color: var(--dsw-alias-link, #4d6bfe); }
.hf-mod-button:disabled { cursor: default; opacity: 0.55; }
.hf-mod-button-plain { border-color: transparent; background: transparent; padding: 0 4px; border-radius: 6px; }
.hf-mod-button-plain:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06)); border-color: transparent; }
.hf-mod-hotkey { color: var(--dsw-alias-link, #4d6bfe); margin-right: 2px; }
.hf-mod-link { color: var(--dsw-alias-link, #4d6bfe); text-decoration: none; }
.hf-mod-link:hover { text-decoration: underline; }
.hf-mod-code { margin: 4px 0; padding: 6px 8px; border-radius: 8px; background: var(--dsw-alias-settings-card-fill, #f6f8fa); font-family: ui-monospace, monospace; font-size: 12px; overflow-x: auto; }
.hf-mod-code-path { opacity: 0.65; margin-bottom: 4px; }
.hf-mod-gutter { display: inline-block; min-width: 3.5ch; margin-right: 1ch; text-align: right; opacity: 0.45; user-select: none; }
.hf-mod-diff-add { background: rgba(46, 160, 67, 0.14); }
.hf-mod-diff-del { background: rgba(248, 81, 73, 0.14); }
.hf-mod-diff-hunk { color: var(--dsw-alias-label-secondary, #59636e); }
.hf-mod-inline-code { font-family: ui-monospace, monospace; font-size: 0.92em; padding: 0 4px; border-radius: 4px; background: var(--dsw-alias-settings-card-fill, #f6f8fa); }
.hf-mod-field { display: inline-flex; align-items: center; gap: 6px; }
.hf-mod-field input, .hf-mod-field select { font: inherit; padding: 2px 8px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2, #d0d7de); background: var(--dsw-alias-bg-base, #fff); color: inherit; }
.hf-mod-unsupported { opacity: 0.6; font-style: italic; }
`

let styled = false
function ensureStyles(): void {
  if (styled || typeof document === 'undefined') return
  styled = true
  const style = document.createElement('style')
  style.dataset['hfMods'] = ''
  style.textContent = CSS
  document.head.append(style)
}

interface ModsDockProps {
  readonly sessionId: string
  readonly useSurfaces: <T>(select: (snapshot: SurfaceSnapshot | undefined) => T) => T
  readonly store: SurfaceStore
  readonly t: TFn
}

function ModsDock({ sessionId, useSurfaces, store, t }: ModsDockProps): ReactNode {
  ensureStyles()
  const snapshot = useSurfaces(value => value)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())
  if (snapshot === undefined || (snapshot.band === null && snapshot.bandError === undefined && snapshot.panes.length === 0)) return null
  const moved = (kind: 'focus' | 'scroll', body: Record<string, unknown>): void => {
    call<{ snapshot: SurfaceSnapshot; refused?: string }>('modMove', { session: sessionId, kind, ...body })
      .then((result) => { store.set(result.snapshot) }, () => undefined)
  }
  const drawFor = (pane: string | undefined): DrawContext => ({
    busy,
    act: draw.act,
    focus: (key) => { moved('focus', { ...(pane !== undefined ? { pane } : {}), element: key }) },
  })
  const draw: DrawContext = {
    busy,
    focus: (key) => { moved('focus', { element: key }) },
    act: (action, value) => {
      setBusy(action)
      setNotice(undefined)
      call<SurfaceSnapshot>('modAct', { session: sessionId, generation: snapshot.generation, action, value })
        .then((next) => { store.set(next) }, (error: unknown) => { setNotice(error instanceof Error ? error.message : String(error)) })
        .finally(() => { setBusy(undefined) })
    },
  }
  const close = (pane: string): void => {
    setNotice(undefined)
    call<{ snapshot: SurfaceSnapshot; refused?: string }>('modClose', { session: sessionId, pane })
      .then((result) => {
        store.set(result.snapshot)
        if (result.refused !== undefined) setNotice(result.refused)
      }, (error: unknown) => { setNotice(error instanceof Error ? error.message : String(error)) })
  }
  return (
    <div className="hf-mods" data-generation={snapshot.generation}>
      {snapshot.panes.map(pane => (
        <section key={pane.id} className="hf-mods-pane" aria-label={pane.title}>
          <header className="hf-mods-pane-head">
            <span className="hf-mods-pane-title">{pane.title}</span>
            <span className="hf-mods-pane-plugin">{pane.plugin}</span>
            <button type="button" className="hf-mods-icon" aria-label={t(folded.has(pane.id) ? 'modExpand' : 'modCollapse')} onClick={() => {
              setFolded((current) => {
                const next = new Set(current)
                if (next.has(pane.id)) next.delete(pane.id)
                else next.add(pane.id)
                return next
              })
            }}>{folded.has(pane.id) ? '▸' : '▾'}</button>
            <button type="button" className="hf-mods-icon" aria-label={t('modClose')} onClick={() => { close(pane.id) }}>×</button>
          </header>
          {folded.has(pane.id) ? null : (
            <PaneBody onScroll={(by, offset, bodyRows, contentRows) => { moved('scroll', { pane: pane.id, by, offset, bodyRows, contentRows }) }}>
              {pane.error !== undefined ? <div className="hf-mods-error">{pane.error}</div> : null}
              {pane.tree === null ? null : <Draw node={pane.tree} draw={drawFor(pane.id)} />}
            </PaneBody>
          )}
        </section>
      ))}
      {snapshot.band === null && snapshot.bandError === undefined ? null : (
        <div className="hf-mods-band" role="group">
          {snapshot.bandError !== undefined ? <div className="hf-mods-error">{snapshot.bandError}</div> : null}
          {snapshot.band === null ? null : <Draw node={snapshot.band} draw={draw} />}
        </div>
      )}
      {notice === undefined ? null : <div className="hf-mods-notice" role="status">{notice}</div>}
    </div>
  )
}

/** A pane's scrolling body: the person's scroll reaches the mod as `ui.scroll`, in rows. */
function PaneBody({ children, onScroll }: { children: ReactNode; onScroll: (by: number, offset: number, bodyRows: number, contentRows: number) => void }): ReactNode {
  const last = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => { if (timer.current !== undefined) clearTimeout(timer.current) }, [])
  return (
    <div
      className="hf-mods-pane-body"
      onScroll={(event) => {
        const element = event.currentTarget
        const row = parseFloat(getComputedStyle(element).lineHeight) || 20
        if (timer.current !== undefined) clearTimeout(timer.current)
        timer.current = setTimeout(() => {
          const offset = Math.round(element.scrollTop / row)
          const by = offset - last.current
          last.current = offset
          if (by !== 0) onScroll(by, offset, Math.round(element.clientHeight / row), Math.round(element.scrollHeight / row))
        }, 120)
      }}
    >
      {children}
    </div>
  )
}

/** Register the dock entry that draws a session's mods. */
export function registerModsDock(ctx: ClientContext, t: TFn): void {
  const stores = new Map<string, SurfaceStore>()
  ctx.effect(() => () => {
    for (const store of stores.values()) store.dispose()
    stores.clear()
  }, 'harness-forge: mod surfaces')
  const storeOf = (sessionId: string): SurfaceStore => {
    let store = stores.get(sessionId)
    if (store === undefined) {
      store = new SurfaceStore(sessionId)
      stores.set(sessionId, store)
    }
    return store
  }
  const slots = (ctx as unknown as { slots: { inject(name: string, run: () => () => void): void; register(spec: unknown, component: unknown): () => void } }).slots
  slots.inject('conversation.input.dock', () => slots.register({
    name: 'conversation.input.dock',
    id: 'harness-forge-mods',
    order: 30,
    inject: (sessionId: string) => {
      const store = storeOf(sessionId)
      return { sessionId, store, hooks: { surfaces: store } }
    },
  }, ((props: Omit<ModsDockProps, 't'>) => <ModsDock {...props} t={t} />) as never))
}
