/** Claude2DSH settings + first-run migration guide inside the dsh Settings shell. */

import { useCallback, useEffect, useState } from 'react'

const SETTINGS_PATH = '/plugins/claude2dsh/settings'
const SOURCES_PATH = '/plugins/claude2dsh/session-sources'
const IMPORT_PATH = '/plugins/claude2dsh/import'
const IMAGE_PROBE_PATH = '/plugins/claude2dsh/image-probe'
const IMPORT_DEFAULTS_PATH = '/plugins/claude2dsh/import-defaults'
const HOOK_SCAN_PATH = '/plugins/claude2dsh/hook-scan'
const HOOK_APPLY_PATH = '/plugins/claude2dsh/hook-scan/apply'

interface SessionSourceRecord {
  sessionId: string
  kind: string
  sourcePath: string
  parentSession?: string
  recordedAt: number
}

interface SettingsShape {
  autoSync: { enabled: boolean; claudeProjectsRoot: string; debounceMs: number; dshToClaude: boolean }
  importDefaults: { imageMode: 'auto' | 'placeholder' | 'native'; imageProvider: string; imageModel: string; includeSubagents: boolean; sidecarMaxBytes: number; recursive: boolean }
  writeback: { target: 'copy' | 'source'; allowOriginalClaudeDir: boolean; exportDir: string }
  hooks: { configPath: string; pluginRoot: string; projectDir: string }
  ui: { language: 'zh' | 'en' }
}

interface ImportReport {
  total?: number
  previewed?: number
  imported?: number
  alreadyImported?: number
  appended?: number
  skipped?: number
  failed?: number
  items?: Array<{ path: string; status: string; sessionId?: string; reason?: string }>
}

const empty: SettingsShape = {
  autoSync: { enabled: false, claudeProjectsRoot: '', debounceMs: 500, dshToClaude: true },
  importDefaults: { imageMode: 'auto', imageProvider: '', imageModel: '', includeSubagents: false, sidecarMaxBytes: 64 * 1024 * 1024, recursive: true },
  writeback: { target: 'copy', allowOriginalClaudeDir: false, exportDir: '' },
  hooks: { configPath: '', pluginRoot: '', projectDir: '' },
  ui: { language: 'zh' },
}

const COPY = {
  zh: {
    language: '语言', firstRun: '首次迁移向导', firstRunHint: '中文为默认语言；本向导只读导入，绝不写 ~/.claude。',
    sourcePath: 'Claude 会话目录（默认 ~/.claude/projects）', includeSubagents: '同时导入 subagent/workflow 子会话',
    preview: '预览导入', execute: '执行导入', importResult: '导入结果',
    save: '保存设置', reload: '重新加载', settingsSaved: '已保存',
    autoMirror: '自动镜像', enabled: '启用', projectsRoot: 'Claude projects 目录（空=默认）',
    debounce: '防抖毫秒（最小 50）', dshToClaude: '把 DSH 轮次镜像回 Claude 副本',
    importDefaults: '导入默认值', imageMode: '图片模式', imageProvider: '能力探测路由 provider（可选；留空跟随当前会话）', imageModel: '能力探测路由模型（可选；留空跟随当前会话）', imageProbe: '图片能力探测结论', recursiveSearch: '递归搜索子目录', sourceFound: '发现',
    includeSubagentsDefault: '默认导入子会话', sidecarMax: 'sidecar 单文件最大字节',
    writeback: '导出 / 写回', syncTarget: '同步目标', allowOriginal: '允许写回真实 ~/.claude（危险）',
    exportDir: '导出目录（空=默认）', hooks: 'Claude hook bridge（启动时生效）',
    hooksHint: '可选 hook 行仍通过启动环境变量 CLAUDE2DSH_HOOKS_CONFIG 激活；这些值在下次启动时生效。', hookScan: '扫描 hooks', hookApply: '保存候选并下次启动启用', hookScanned: '扫描文件', hookSupported: '可映射 command', hookSkipped: '跳过',
    hooksPath: 'hooks.json 路径', pluginRoot: '插件根目录', projectDir: '项目目录',
    sessionSources: '会话来源', noSources: '还没有导入会话。', sessionId: '会话 ID', kind: '来源', sourcePathCol: '来源路径',
    noImportYet: '尚未执行导入。', previewed: '预览', imported: '新导入', already: '已存在', appended: '追加', skipped: '跳过', failed: '失败',
    readOnly: '只读导入；所有写入仅进入 DSH。',
  },
  en: {
    language: 'Language', firstRun: 'First-run migration', firstRunHint: 'The guide is read-only and never writes ~/.claude.',
    sourcePath: 'Claude sessions directory (default ~/.claude/projects)', includeSubagents: 'Also import subagent/workflow sessions',
    preview: 'Preview import', execute: 'Run import', importResult: 'Import result',
    save: 'Save settings', reload: 'Reload', settingsSaved: 'Saved',
    autoMirror: 'Auto mirror', enabled: 'Enabled', projectsRoot: 'Claude projects root (empty = default)',
    debounce: 'Debounce ms (min 50)', dshToClaude: 'Mirror DSH turns to the Claude copy',
    importDefaults: 'Import defaults', imageMode: 'Image mode', imageProvider: 'Probe route provider (optional; empty follows the current session)', imageModel: 'Probe route model (optional; empty follows the current session)', imageProbe: 'Image capability probe', recursiveSearch: 'Recursive search', sourceFound: 'Discovery',
    includeSubagentsDefault: 'Include subagents by default', sidecarMax: 'Sidecar max bytes per file',
    writeback: 'Export / write-back', syncTarget: 'Sync target', allowOriginal: 'Allow writing real ~/.claude (danger)',
    exportDir: 'Export directory (empty = default)', hooks: 'Claude hook bridge (boot-time row)',
    hooksHint: 'The optional hook row still activates through CLAUDE2DSH_HOOKS_CONFIG at boot; these values apply after the next restart.', hookScan: 'Scan hooks', hookApply: 'Save candidate and enable next boot', hookScanned: 'Scanned files', hookSupported: 'Supported commands', hookSkipped: 'Skipped',
    hooksPath: 'hooks.json path', pluginRoot: 'Plugin root', projectDir: 'Project dir',
    sessionSources: 'Session sources', noSources: 'No imported sessions recorded yet.', sessionId: 'Session ID', kind: 'Kind', sourcePathCol: 'Source path',
    noImportYet: 'No import has been run yet.', previewed: 'Previewed', imported: 'Imported', already: 'Already imported', appended: 'Appended', skipped: 'Skipped', failed: 'Failed',
    readOnly: 'Read-only import; all writes stay inside DSH.',
  },
} as const

type Lang = 'zh' | 'en'
type CopyKey = keyof typeof COPY.zh

const label: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }
const input: React.CSSProperties = { boxSizing: 'border-box', minHeight: 32, padding: '5px 10px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' }
const button: React.CSSProperties = { minHeight: 34, padding: '6px 14px', borderRadius: 18, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' }
const page: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 840 }
const card: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12, padding: '16px 18px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, background: 'var(--dsw-alias-bg-module-platform)' }
const row: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(220px, 360px)', gap: 12, alignItems: 'center' }
const checkbox: React.CSSProperties = { justifySelf: 'start', width: 18, height: 18 }

export function Claude2DshSettings(): React.JSX.Element {
  const [value, setValue] = useState<SettingsShape>(empty)
  const [lang, setLang] = useState<Lang>('zh')
  const [error, setError] = useState<string | undefined>()
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [sources, setSources] = useState<SessionSourceRecord[]>([])
  const [guidePath, setGuidePath] = useState('~/.claude/projects')
  const [guideSubagents, setGuideSubagents] = useState(false)
  const [guideBusy, setGuideBusy] = useState(false)
  const [guideResult, setGuideResult] = useState<ImportReport | undefined>()
  const [importDefaults, setImportDefaults] = useState<{ sourceRoot: string; recursive: boolean }>({ sourceRoot: '~/.claude/projects', recursive: true })
  const [imageProbe, setImageProbe] = useState<{ routeSource?: string; provider?: string; model?: string; supports?: boolean; reason?: string } | undefined>()
  const [hookScan, setHookScan] = useState<{ scannedFiles?: number; supportedCommands?: number; skipped?: number; entries?: Array<{ sourcePath: string; event: string; supported: boolean; reason?: string; command?: string }> } | undefined>()
  const [hookApply, setHookApply] = useState<{ configPath?: string; activation?: string } | undefined>()

  const t = useCallback((key: CopyKey): string => COPY[lang][key], [lang])

  const load = useCallback(async () => {
    try {
      const response = await fetch(SETTINGS_PATH, { method: 'GET' })
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
      const next = await response.json() as SettingsShape
      setValue(next)
      setLang(next.ui?.language === 'en' ? 'en' : 'zh')
      setStatus('ready')
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setStatus('error')
    }
  }, [])

  const loadImportDefaults = useCallback(async () => {
    try {
      const response = await fetch(IMPORT_DEFAULTS_PATH, { method: 'GET' })
      if (response.ok) {
        const body = await response.json() as { sourceRoot: string; recursive: boolean }
        setImportDefaults(body)
        setGuidePath((current) => (current === '~/.claude/projects' || current === '' ? body.sourceRoot : current))
      }
    } catch {
      // keep placeholder
    }
  }, [])

  const loadProbe = useCallback(async () => {
    try {
      const response = await fetch(IMAGE_PROBE_PATH, { method: 'GET' })
      if (response.ok) setImageProbe(await response.json() as typeof imageProbe)
    } catch {
      setImageProbe(undefined)
    }
  }, [])

  useEffect(() => { void load(); void loadProbe(); void loadImportDefaults() }, [load, loadProbe, loadImportDefaults])
  useEffect(() => {
    void fetch(SOURCES_PATH, { method: 'GET' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
        return response.json() as Promise<{ sessions: Record<string, SessionSourceRecord> }>
      })
      .then((body) => setSources(Object.values(body.sessions).sort((a, b) => a.sessionId.localeCompare(b.sessionId))))
      .catch(() => setSources([]))
  }, [])

  const patch = (update: (draft: SettingsShape) => SettingsShape): void => {
    setValue((draft) => update(draft))
  }

  const save = async (): Promise<void> => {
    try {
      setError(undefined)
      const response = await fetch(SETTINGS_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
      const next = await response.json() as SettingsShape
      setValue(next)
      setLang(next.ui?.language === 'en' ? 'en' : 'zh')
      setStatus('ready')
      await loadProbe()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setStatus('error')
    }
  }

  const runGuide = async (preview: boolean): Promise<void> => {
    setGuideBusy(true)
    setError(undefined)
    try {
      const response = await fetch(IMPORT_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: guidePath, preview, includeSubagents: guideSubagents, recursive: value.importDefaults.recursive }) })
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
      setGuideResult(await response.json() as ImportReport)
      setStatus('ready')
      if (!preview) {
        const sourcesResponse = await fetch(SOURCES_PATH, { method: 'GET' })
        if (sourcesResponse.ok) {
          const body = await sourcesResponse.json() as { sessions: Record<string, SessionSourceRecord> }
          setSources(Object.values(body.sessions).sort((a, b) => a.sessionId.localeCompare(b.sessionId)))
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setStatus('error')
    } finally {
      setGuideBusy(false)
    }
  }

  return (
    <div style={page}>
      <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>Claude2DSH</h2>
      {status === 'loading' ? <p style={{ margin: 0 }}>Loading…</p> : null}
      {error !== undefined ? <p style={{ margin: 0, color: 'var(--dsw-alias-state-error-primary)' }}>{error}</p> : null}

      <section style={card}>
        <h3 style={{ margin: 0 }}>{t('firstRun')}</h3>
        <p style={{ margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>{t('firstRunHint')} {t('readOnly')}</p>
        <div style={row}><span style={label}>{t('language')}</span>
          <select style={input} value={lang} onChange={(event) => {
            const next = event.target.value as Lang
            setLang(next)
            patch((draft) => ({ ...draft, ui: { language: next } }))
          }}><option value="zh">中文</option><option value="en">English</option></select></div>
        <div style={row}><span style={label}>{t('sourcePath')}</span><input style={input} value={guidePath} onChange={(event) => setGuidePath(event.target.value)} /></div>
        <div style={row}><span style={label}>{t('includeSubagents')}</span><input style={checkbox} type="checkbox" checked={guideSubagents} onChange={(event) => setGuideSubagents(event.target.checked)} /></div>
        <div style={row}><span style={label}>{t('recursiveSearch')}</span><input style={checkbox} type="checkbox" checked={value.importDefaults.recursive} onChange={(event) => patch((draft) => ({ ...draft, importDefaults: { ...draft.importDefaults, recursive: event.target.checked } }))} /></div>
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>{t('sourceFound')}: {guidePath} · total={guideResult?.total ?? '—'} previewed={guideResult?.previewed ?? '—'} imported={guideResult?.imported ?? '—'} skipped={guideResult?.skipped ?? '—'}</div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" style={button} disabled={guideBusy} onClick={() => { void runGuide(true) }}>{t('preview')}</button>
          <button type="button" style={button} disabled={guideBusy} onClick={() => { void runGuide(false) }}>{t('execute')}</button>
        </div>
        {guideResult !== undefined ? (
          <pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: 240 }}>
            {`${t('previewed')}=${guideResult.previewed ?? 0} ${t('imported')}=${guideResult.imported ?? 0} ${t('already')}=${guideResult.alreadyImported ?? 0} ${t('appended')}=${guideResult.appended ?? 0} ${t('skipped')}=${guideResult.skipped ?? 0} ${t('failed')}=${guideResult.failed ?? 0}\n` +
            (guideResult.items ?? []).slice(0, 20).map((item) => `${item.status}\t${item.sessionId ?? ''}\t${item.path ?? ''}`).join('\n')}
          </pre>
        ) : <p style={{ margin: 0, fontSize: 12 }}>{t('noImportYet')}</p>}
      </section>

      <section style={card}>
        <h3 style={{ margin: 0 }}>{t('autoMirror')}</h3>
        <div style={row}><span style={label}>{t('enabled')}</span><input style={checkbox} type="checkbox" checked={value.autoSync.enabled} onChange={(event) => patch((draft) => ({ ...draft, autoSync: { ...draft.autoSync, enabled: event.target.checked } }))} /></div>
        <div style={row}><span style={label}>{t('projectsRoot')}</span><input style={input} value={value.autoSync.claudeProjectsRoot} onChange={(event) => patch((draft) => ({ ...draft, autoSync: { ...draft.autoSync, claudeProjectsRoot: event.target.value } }))} /></div>
        <div style={row}><span style={label}>{t('debounce')}</span><input style={input} type="number" min={50} value={value.autoSync.debounceMs} onChange={(event) => patch((draft) => ({ ...draft, autoSync: { ...draft.autoSync, debounceMs: Number(event.target.value) } }))} /></div>
        <div style={row}><span style={label}>{t('dshToClaude')}</span><input style={checkbox} type="checkbox" checked={value.autoSync.dshToClaude} onChange={(event) => patch((draft) => ({ ...draft, autoSync: { ...draft.autoSync, dshToClaude: event.target.checked } }))} /></div>
      </section>

      <section style={card}>
        <h3 style={{ margin: 0 }}>{t('importDefaults')}</h3>
        <div style={row}><span style={label}>{t('imageMode')}</span><select style={input} value={value.importDefaults.imageMode} onChange={(event) => patch((draft) => ({ ...draft, importDefaults: { ...draft.importDefaults, imageMode: event.target.value as SettingsShape['importDefaults']['imageMode'] } }))}><option value="auto">auto</option><option value="placeholder">placeholder</option><option value="native">native</option></select></div>
        <div style={row}><span style={label}>{t('imageProvider')}</span><input style={input} value={value.importDefaults.imageProvider} onChange={(event) => patch((draft) => ({ ...draft, importDefaults: { ...draft.importDefaults, imageProvider: event.target.value } }))} /></div>
        <div style={row}><span style={label}>{t('imageModel')}</span><input style={input} value={value.importDefaults.imageModel} onChange={(event) => patch((draft) => ({ ...draft, importDefaults: { ...draft.importDefaults, imageModel: event.target.value } }))} /></div>
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>{t('imageProbe')}: {imageProbe?.reason ?? '…'}</div>
        <div style={row}><span style={label}>{t('includeSubagentsDefault')}</span><input style={checkbox} type="checkbox" checked={value.importDefaults.includeSubagents} onChange={(event) => patch((draft) => ({ ...draft, importDefaults: { ...draft.importDefaults, includeSubagents: event.target.checked } }))} /></div>
        <div style={row}><span style={label}>{t('sidecarMax')}</span><input style={input} type="number" min={1} value={value.importDefaults.sidecarMaxBytes} onChange={(event) => patch((draft) => ({ ...draft, importDefaults: { ...draft.importDefaults, sidecarMaxBytes: Number(event.target.value) } }))} /></div>
      </section>

      <section style={card}>
        <h3 style={{ margin: 0 }}>{t('writeback')}</h3>
        <div style={row}><span style={label}>{t('syncTarget')}</span><select style={input} value={value.writeback.target} onChange={(event) => patch((draft) => ({ ...draft, writeback: { ...draft.writeback, target: event.target.value as 'copy' | 'source' } }))}><option value="copy">copy</option><option value="source">source</option></select></div>
        <div style={row}><span style={label}>{t('allowOriginal')}</span><input style={checkbox} type="checkbox" checked={value.writeback.allowOriginalClaudeDir} onChange={(event) => patch((draft) => ({ ...draft, writeback: { ...draft.writeback, allowOriginalClaudeDir: event.target.checked } }))} /></div>
        <div style={row}><span style={label}>{t('exportDir')}</span><input style={input} value={value.writeback.exportDir} onChange={(event) => patch((draft) => ({ ...draft, writeback: { ...draft.writeback, exportDir: event.target.value } }))} /></div>
      </section>

      <section style={card}>
        <h3 style={{ margin: 0 }}>{t('hooks')}</h3>
        <p style={{ margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>{t('hooksHint')}</p>
        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" style={button} onClick={() => { void fetch(HOOK_SCAN_PATH).then(async (r) => { if (r.ok) setHookScan(await r.json() as typeof hookScan); else setError(`${r.status} ${await r.text()}`) }).catch((cause) => setError(String(cause))) }}>{t('hookScan')}</button>
          <button type="button" style={button} onClick={() => { void fetch(HOOK_APPLY_PATH, { method: 'POST' }).then(async (r) => { const body = await r.json() as typeof hookApply; if (r.ok) setHookApply(body); else setError(`${r.status} ${JSON.stringify(body)}`) }).catch((cause) => setError(String(cause))) }}>{t('hookApply')}</button>
        </div>
        {hookScan !== undefined ? <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>{t('hookScanned')}={hookScan.scannedFiles ?? 0} · {t('hookSupported')}={hookScan.supportedCommands ?? 0} · {t('hookSkipped')}={hookScan.skipped ?? 0}</div> : null}
        {(hookScan?.entries ?? []).slice(0, 8).map((entry, index) => (
          <div key={index} style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }}>{entry.supported ? '✓' : '✗'} {entry.event} · {entry.command ?? entry.reason ?? entry.sourcePath}</div>
        ))}
        {hookApply !== undefined ? <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>{hookApply.configPath}<br />{hookApply.activation}</div> : null}
        <div style={row}><span style={label}>{t('hooksPath')}</span><input style={input} value={value.hooks.configPath} onChange={(event) => patch((draft) => ({ ...draft, hooks: { ...draft.hooks, configPath: event.target.value } }))} /></div>
        <div style={row}><span style={label}>{t('pluginRoot')}</span><input style={input} value={value.hooks.pluginRoot} onChange={(event) => patch((draft) => ({ ...draft, hooks: { ...draft.hooks, pluginRoot: event.target.value } }))} /></div>
        <div style={row}><span style={label}>{t('projectDir')}</span><input style={input} value={value.hooks.projectDir} onChange={(event) => patch((draft) => ({ ...draft, hooks: { ...draft.hooks, projectDir: event.target.value } }))} /></div>
      </section>

      <section style={card}>
        <h3 style={{ margin: 0 }}>{t('sessionSources')}</h3>
        {sources.length === 0 ? <p style={{ margin: 0, fontSize: 12 }}>{t('noSources')}</p> : (
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
            <thead><tr>{[t('sessionId'), t('kind'), t('sourcePathCol')].map((head) => <th key={head} style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>{head}</th>)}</tr></thead>
            <tbody>
              {sources.map((item) => (
                <tr key={item.sessionId}>
                  <td style={{ padding: '4px 8px', borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>{item.sessionId}</td>
                  <td style={{ padding: '4px 8px', borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>{item.kind}</td>
                  <td style={{ padding: '4px 8px', borderBottom: '1px solid var(--dsw-alias-border-l2)', wordBreak: 'break-all' }}>{item.sourcePath}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div style={{ display: 'flex', gap: 10 }}>
        <button type="button" style={button} onClick={() => { void save() }}>{t('save')}</button>
        <button type="button" style={button} onClick={() => { void load() }}>{t('reload')}</button>
      </div>
    </div>
  )
}
