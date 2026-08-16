/** Claude2DSH settings page inside the dsh Settings shell. */

import { useCallback, useEffect, useState } from 'react'

const SETTINGS_PATH = '/plugins/claude2dsh/settings'

interface SettingsShape {
  autoSync: { enabled: boolean; claudeProjectsRoot: string; debounceMs: number; dshToClaude: boolean }
  importDefaults: { imageMode: 'auto' | 'placeholder' | 'native'; imageProvider: string; imageModel: string; includeSubagents: boolean; sidecarMaxBytes: number }
  writeback: { target: 'copy' | 'source'; allowOriginalClaudeDir: boolean; exportDir: string }
  hooks: { configPath: string; pluginRoot: string; projectDir: string }
}

const empty: SettingsShape = {
  autoSync: { enabled: false, claudeProjectsRoot: '', debounceMs: 500, dshToClaude: true },
  importDefaults: { imageMode: 'auto', imageProvider: 'deepseek-official', imageModel: 'deepseek-v4-flash', includeSubagents: false, sidecarMaxBytes: 64 * 1024 * 1024 },
  writeback: { target: 'copy', allowOriginalClaudeDir: false, exportDir: '' },
  hooks: { configPath: '', pluginRoot: '', projectDir: '' },
}

const label: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }
const input: React.CSSProperties = { boxSizing: 'border-box', minHeight: 32, padding: '5px 10px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' }
const button: React.CSSProperties = { minHeight: 34, padding: '6px 14px', borderRadius: 18, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' }
const page: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 720 }
const card: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12, padding: '16px 18px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, background: 'var(--dsw-alias-bg-module-platform)' }
const row: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(220px, 320px)', gap: 12, alignItems: 'center' }
const checkbox: React.CSSProperties = { justifySelf: 'start', width: 18, height: 18 }

export function Claude2DshSettings(): React.JSX.Element {
  const [value, setValue] = useState<SettingsShape>(empty)
  const [error, setError] = useState<string | undefined>()
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  const load = useCallback(async () => {
    try {
      const response = await fetch(SETTINGS_PATH, { method: 'GET' })
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
      setValue(await response.json() as SettingsShape)
      setStatus('ready')
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setStatus('error')
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const patch = (update: (draft: SettingsShape) => SettingsShape): void => {
    setValue((draft) => update(draft))
  }

  const save = async (): Promise<void> => {
    try {
      setError(undefined)
      const response = await fetch(SETTINGS_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
      setValue(await response.json() as SettingsShape)
      setStatus('ready')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setStatus('error')
    }
  }

  return (
    <div style={page}>
      <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>Claude2DSH</h2>
      {status === 'loading' ? <p style={{ margin: 0 }}>Loading…</p> : null}
      {error !== undefined ? <p style={{ margin: 0, color: 'var(--dsw-alias-state-error-primary)' }}>{error}</p> : null}

      <section style={card}>
        <h3 style={{ margin: 0 }}>Auto mirror</h3>
        <div style={row}><span style={label}>Enabled</span><input style={checkbox} type="checkbox" checked={value.autoSync.enabled} onChange={(event) => patch((draft) => ({ ...draft, autoSync: { ...draft.autoSync, enabled: event.target.checked } }))} /></div>
        <div style={row}><span style={label}>Claude projects root (empty = default)</span><input style={input} value={value.autoSync.claudeProjectsRoot} onChange={(event) => patch((draft) => ({ ...draft, autoSync: { ...draft.autoSync, claudeProjectsRoot: event.target.value } }))} /></div>
        <div style={row}><span style={label}>Debounce ms (min 50)</span><input style={input} type="number" min={50} value={value.autoSync.debounceMs} onChange={(event) => patch((draft) => ({ ...draft, autoSync: { ...draft.autoSync, debounceMs: Number(event.target.value) } }))} /></div>
        <div style={row}><span style={label}>Mirror DSH turns to Claude copy</span><input style={checkbox} type="checkbox" checked={value.autoSync.dshToClaude} onChange={(event) => patch((draft) => ({ ...draft, autoSync: { ...draft.autoSync, dshToClaude: event.target.checked } }))} /></div>
      </section>

      <section style={card}>
        <h3 style={{ margin: 0 }}>Import defaults</h3>
        <div style={row}><span style={label}>Image mode</span><select style={input} value={value.importDefaults.imageMode} onChange={(event) => patch((draft) => ({ ...draft, importDefaults: { ...draft.importDefaults, imageMode: event.target.value as SettingsShape['importDefaults']['imageMode'] } }))}><option value="auto">auto</option><option value="placeholder">placeholder</option><option value="native">native</option></select></div>
        <div style={row}><span style={label}>Image provider</span><input style={input} value={value.importDefaults.imageProvider} onChange={(event) => patch((draft) => ({ ...draft, importDefaults: { ...draft.importDefaults, imageProvider: event.target.value } }))} /></div>
        <div style={row}><span style={label}>Image model</span><input style={input} value={value.importDefaults.imageModel} onChange={(event) => patch((draft) => ({ ...draft, importDefaults: { ...draft.importDefaults, imageModel: event.target.value } }))} /></div>
        <div style={row}><span style={label}>Include subagents by default</span><input style={checkbox} type="checkbox" checked={value.importDefaults.includeSubagents} onChange={(event) => patch((draft) => ({ ...draft, importDefaults: { ...draft.importDefaults, includeSubagents: event.target.checked } }))} /></div>
        <div style={row}><span style={label}>Sidecar max bytes per file</span><input style={input} type="number" min={1} value={value.importDefaults.sidecarMaxBytes} onChange={(event) => patch((draft) => ({ ...draft, importDefaults: { ...draft.importDefaults, sidecarMaxBytes: Number(event.target.value) } }))} /></div>
      </section>

      <section style={card}>
        <h3 style={{ margin: 0 }}>Export / write-back</h3>
        <div style={row}><span style={label}>Sync target</span><select style={input} value={value.writeback.target} onChange={(event) => patch((draft) => ({ ...draft, writeback: { ...draft.writeback, target: event.target.value as 'copy' | 'source' } }))}><option value="copy">copy</option><option value="source">source</option></select></div>
        <div style={row}><span style={label}>Allow writing original ~/.claude</span><input style={checkbox} type="checkbox" checked={value.writeback.allowOriginalClaudeDir} onChange={(event) => patch((draft) => ({ ...draft, writeback: { ...draft.writeback, allowOriginalClaudeDir: event.target.checked } }))} /></div>
        <div style={row}><span style={label}>Export directory (empty = default)</span><input style={input} value={value.writeback.exportDir} onChange={(event) => patch((draft) => ({ ...draft, writeback: { ...draft.writeback, exportDir: event.target.value } }))} /></div>
      </section>

      <section style={card}>
        <h3 style={{ margin: 0 }}>Claude hook bridge (boot-time row)</h3>
        <p style={{ margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>The optional hook row still activates through CLAUDE2DSH_HOOKS_CONFIG at boot; these values document and prefill the hook environment after the next restart.</p>
        <div style={row}><span style={label}>hooks.json path</span><input style={input} value={value.hooks.configPath} onChange={(event) => patch((draft) => ({ ...draft, hooks: { ...draft.hooks, configPath: event.target.value } }))} /></div>
        <div style={row}><span style={label}>Plugin root</span><input style={input} value={value.hooks.pluginRoot} onChange={(event) => patch((draft) => ({ ...draft, hooks: { ...draft.hooks, pluginRoot: event.target.value } }))} /></div>
        <div style={row}><span style={label}>Project dir</span><input style={input} value={value.hooks.projectDir} onChange={(event) => patch((draft) => ({ ...draft, hooks: { ...draft.hooks, projectDir: event.target.value } }))} /></div>
      </section>

      <div style={{ display: 'flex', gap: 10 }}>
        <button type="button" style={button} onClick={() => { void save() }}>Save settings</button>
        <button type="button" style={button} onClick={() => { void load() }}>Reload</button>
      </div>
    </div>
  )
}
