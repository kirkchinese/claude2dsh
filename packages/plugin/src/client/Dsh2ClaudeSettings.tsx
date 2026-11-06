/** DSH2Claude settings, staging, and install panel inside the DSH Settings shell. */

import { useCallback, useEffect, useState } from 'react'

const SETTINGS_PATH = '/plugins/dsh2claude/settings'
const STAGE_PATH = '/plugins/dsh2claude/stage'
const INSTALL_PATH = '/plugins/dsh2claude/install'
const STATUS_PATH = '/plugins/dsh2claude/status'
const SESSIONS_PATH = '/plugins/dsh2claude/sessions'

interface SettingsShape {
  sessions: { dshHome: string; root: string; recursive: boolean; includeSubagents: boolean }
  assets: { skills: boolean; instructions: boolean; mcp: boolean }
  install: { claudeHome: string; overwrite: boolean }
  ui: { language: 'zh' | 'en' }
}

interface StageReport {
  sessions?: { total?: number; staged?: number; updated?: number; skippedIdentical?: number; skipped?: number; failed?: number; items?: Array<{ dshId: string; title?: string; status: string; reason?: string }> }
  skills?: { staged?: number; failed?: number }
  instructions?: { staged?: number }
  mcp?: { servers?: string[]; conflicts?: Array<{ server: string; reason: string }> }
  stagingRoot?: string
  preview?: boolean
}

interface InstallReport {
  dryRun?: boolean
  claudeHome?: string
  total?: number
  installed?: number
  skippedIdentical?: number
  conflicts?: number
  failed?: number
  items?: Array<{ kind: string; id: string; status: string; reason?: string; targetPath: string }>
  mcp?: Array<{ server: string; status: string; reason?: string }>
}

interface StatusShape {
  dshHome?: string
  claudeHome?: string
  sessionsRoot?: string
  stagingRoot?: string
  summary?: { total: number; staged: number; installed: number; kinds: Record<string, number> }
  items?: Array<{ kind: string; id: string; label: string; status: string; targetPath: string; installedAt?: number }>
}

interface SessionRow {
  dshId: string
  ref: string
  title?: string
  cwd?: string
  createdAt: number
  version: number
  auxiliary: boolean
  staged: boolean
  installed: boolean
}

const empty: SettingsShape = {
  sessions: { dshHome: '', root: '', recursive: true, includeSubagents: false },
  assets: { skills: true, instructions: true, mcp: true },
  install: { claudeHome: '', overwrite: false },
  ui: { language: 'zh' },
}

const COPY = {
  zh: {
    title: 'DSH2Claude',
    migration: '从 DeepSeek Harness 迁移',
    migrationHint: '只读取 $DSH_HOME；会话、技能、AGENTS.md 和 MCP 先进入暂存区，绝不会直接写 ~/.claude。',
    dshHome: 'DSH home（空 = $DSH_HOME 或 ~/.dsh）',
    sessionsRoot: '会话目录（空 = <DSH home>/sessions）',
    recursive: '递归扫描子目录',
    subagents: '包含子代理会话',
    assets: '同时暂存技能、全局指令和 MCP 服务器',
    preview: '预览转换',
    stage: '暂存',
    install: '安装到 Claude Code',
    installHint: '安装是唯一会写 ~/.claude 的步骤；默认预览，必须确认后才会写入。',
    claudeHome: 'Claude home（空 = $CLAUDE_CONFIG_DIR 或 ~/.claude）',
    overwrite: '允许覆盖冲突项（旧副本会改名为备份）',
    installPreview: '预览安装',
    installConfirm: '确认安装',
    status: '暂存状态',
    sessions: '发现会话',
    save: '保存设置',
    reload: '重新加载',
    saved: '已保存',
    staging: '暂存目录',
    total: '总计',
    staged: '已暂存',
    installed: '已安装',
    noSessions: '没有发现会话。',
    noItems: '暂存区为空。',
    session: '会话',
    titleCol: '标题',
    cwdCol: '目录',
    versionCol: '格式',
    stateCol: '状态',
    targetPath: '目标',
    installResult: '安装结果',
    stageResult: '暂存结果',
    language: '语言',
    stagedBadge: '已暂存',
    installedBadge: '已安装',
    idle: '尚未运行。',
    running: '运行中…',
  },
  en: {
    title: 'DSH2Claude',
    migration: 'Migrate from DeepSeek Harness',
    migrationHint: 'Reads $DSH_HOME only. Sessions, skills, AGENTS.md and MCP servers go to a staging area first; ~/.claude is never written until install.',
    dshHome: 'DSH home (empty = $DSH_HOME or ~/.dsh)',
    sessionsRoot: 'Sessions directory (empty = <DSH home>/sessions)',
    recursive: 'Scan nested directories',
    subagents: 'Include subagent sessions',
    assets: 'Also stage skills, global instructions and MCP servers',
    preview: 'Preview conversion',
    stage: 'Stage',
    install: 'Install into Claude Code',
    installHint: 'Install is the only step that writes ~/.claude. It previews by default and needs explicit confirmation.',
    claudeHome: 'Claude home (empty = $CLAUDE_CONFIG_DIR or ~/.claude)',
    overwrite: 'Allow overwriting conflicts (old copy is renamed to a backup)',
    installPreview: 'Preview install',
    installConfirm: 'Confirm install',
    status: 'Staging status',
    sessions: 'Discovered sessions',
    save: 'Save settings',
    reload: 'Reload',
    saved: 'Saved',
    staging: 'Staging directory',
    total: 'Total',
    staged: 'Staged',
    installed: 'Installed',
    noSessions: 'No sessions found.',
    noItems: 'The staging area is empty.',
    session: 'Session',
    titleCol: 'Title',
    cwdCol: 'Directory',
    versionCol: 'Format',
    stateCol: 'State',
    targetPath: 'Target',
    installResult: 'Install result',
    stageResult: 'Stage result',
    language: 'Language',
    stagedBadge: 'staged',
    installedBadge: 'installed',
    idle: 'Nothing has run yet.',
    running: 'Running…',
  },
} as const

type Lang = 'zh' | 'en'
type CopyKey = keyof typeof COPY.zh

const label: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }
const input: React.CSSProperties = { boxSizing: 'border-box', minHeight: 32, padding: '5px 10px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' }
const button: React.CSSProperties = { minHeight: 34, padding: '6px 14px', borderRadius: 18, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' }
const page: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 880 }
const card: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12, padding: '16px 18px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, background: 'var(--dsw-alias-bg-module-platform)' }
const row: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(220px, 380px)', gap: 12, alignItems: 'center' }
const checkbox: React.CSSProperties = { justifySelf: 'start', width: 18, height: 18 }
const note: React.CSSProperties = { margin: 0, fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }
const pre: React.CSSProperties = { margin: 0, fontSize: 11, whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: 220 }

async function responseError(response: Response): Promise<string> {
  const text = await response.text()
  try {
    const parsed = JSON.parse(text) as { error?: string }
    return parsed.error ?? text
  } catch {
    return text
  }
}

export function Dsh2ClaudeSettings(): React.JSX.Element {
  const [value, setValue] = useState<SettingsShape>(empty)
  const [lang, setLang] = useState<Lang>('zh')
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<StatusShape | undefined>()
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [stageReport, setStageReport] = useState<StageReport | undefined>()
  const [installReport, setInstallReport] = useState<InstallReport | undefined>()

  const t = useCallback((key: CopyKey): string => COPY[lang][key], [lang])

  const loadSettings = useCallback(async () => {
    const response = await fetch(SETTINGS_PATH)
    if (!response.ok) throw new Error(await responseError(response))
    const next = await response.json() as SettingsShape
    setValue(next)
    setLang(next.ui?.language === 'en' ? 'en' : 'zh')
  }, [])

  const loadStatus = useCallback(async () => {
    const response = await fetch(STATUS_PATH)
    if (response.ok) setStatus(await response.json() as StatusShape)
  }, [])

  const loadSessions = useCallback(async () => {
    const response = await fetch(SESSIONS_PATH)
    if (response.ok) {
      const body = await response.json() as { sessions?: SessionRow[] }
      setSessions(body.sessions ?? [])
    }
  }, [])

  useEffect(() => {
    void loadSettings().catch((cause) => setError(String(cause)))
    void loadStatus().catch(() => undefined)
    void loadSessions().catch(() => undefined)
  }, [loadSettings, loadStatus, loadSessions])

  const patch = (update: (draft: SettingsShape) => SettingsShape): void => setValue((draft) => update(draft))

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try { await action() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }

  const save = (): Promise<void> => run(async () => {
    const response = await fetch(SETTINGS_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
    if (!response.ok) throw new Error(await responseError(response))
    const next = await response.json() as SettingsShape
    setValue(next)
    setLang(next.ui?.language === 'en' ? 'en' : 'zh')
    await loadStatus()
  })

  const stage = (preview: boolean): Promise<void> => run(async () => {
    const response = await fetch(STAGE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        preview,
        includeSubagents: value.sessions.includeSubagents,
        skills: value.assets.skills,
        instructions: value.assets.instructions,
        mcp: value.assets.mcp,
      }),
    })
    if (!response.ok) throw new Error(await responseError(response))
    setStageReport(await response.json() as StageReport)
    await Promise.all([loadStatus(), loadSessions()])
  })

  const install = (confirm: boolean): Promise<void> => run(async () => {
    const response = await fetch(INSTALL_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm, force: value.install.overwrite }),
    })
    if (!response.ok) throw new Error(await responseError(response))
    setInstallReport(await response.json() as InstallReport)
    await Promise.all([loadStatus(), loadSessions()])
  })

  return (
    <div style={page}>
      <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>{t('title')}</h2>
      {error !== undefined ? <p style={{ margin: 0, color: 'var(--dsw-alias-state-error-primary)' }}>{error}</p> : null}

      <section style={card}>
        <h3 style={{ margin: 0 }}>{t('migration')}</h3>
        <p style={note}>{t('migrationHint')}</p>
        <div style={row}><span style={label}>{t('language')}</span>
          <select style={input} value={lang} onChange={(event) => {
            const next = event.target.value as Lang
            setLang(next)
            patch((draft) => ({ ...draft, ui: { language: next } }))
          }}><option value="zh">中文</option><option value="en">English</option></select></div>
        <div style={row}><span style={label}>{t('dshHome')}</span><input style={input} value={value.sessions.dshHome} onChange={(event) => patch((draft) => ({ ...draft, sessions: { ...draft.sessions, dshHome: event.target.value } }))} /></div>
        <div style={row}><span style={label}>{t('sessionsRoot')}</span><input style={input} value={value.sessions.root} onChange={(event) => patch((draft) => ({ ...draft, sessions: { ...draft.sessions, root: event.target.value } }))} /></div>
        <div style={row}><span style={label}>{t('recursive')}</span><input style={checkbox} type="checkbox" checked={value.sessions.recursive} onChange={(event) => patch((draft) => ({ ...draft, sessions: { ...draft.sessions, recursive: event.target.checked } }))} /></div>
        <div style={row}><span style={label}>{t('subagents')}</span><input style={checkbox} type="checkbox" checked={value.sessions.includeSubagents} onChange={(event) => patch((draft) => ({ ...draft, sessions: { ...draft.sessions, includeSubagents: event.target.checked } }))} /></div>
        <div style={row}><span style={label}>{t('assets')}</span>
          <span style={{ display: 'flex', gap: 12, fontSize: 12 }}>
            <label><input type="checkbox" checked={value.assets.skills} onChange={(event) => patch((draft) => ({ ...draft, assets: { ...draft.assets, skills: event.target.checked } }))} /> skills</label>
            <label><input type="checkbox" checked={value.assets.instructions} onChange={(event) => patch((draft) => ({ ...draft, assets: { ...draft.assets, instructions: event.target.checked } }))} /> AGENTS.md</label>
            <label><input type="checkbox" checked={value.assets.mcp} onChange={(event) => patch((draft) => ({ ...draft, assets: { ...draft.assets, mcp: event.target.checked } }))} /> MCP</label>
          </span></div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" style={button} disabled={busy} onClick={() => { void stage(true) }}>{t('preview')}</button>
          <button type="button" style={button} disabled={busy} onClick={() => { void stage(false) }}>{t('stage')}</button>
        </div>
        {status?.stagingRoot !== undefined ? <p style={note}>{t('staging')}: {status.stagingRoot}</p> : null}
        {stageReport !== undefined ? (
          <pre style={pre}>
            {`${t('stageResult')}: sessions staged=${stageReport.sessions?.staged ?? 0} updated=${stageReport.sessions?.updated ?? 0} identical=${stageReport.sessions?.skippedIdentical ?? 0} skipped=${stageReport.sessions?.skipped ?? 0} failed=${stageReport.sessions?.failed ?? 0} ` +
              `skills=${stageReport.skills?.staged ?? 0} instructions=${stageReport.instructions?.staged ?? 0} mcp=${stageReport.mcp?.servers?.length ?? 0}` +
              ((stageReport.sessions?.items ?? []).length > 0 ? `\n${(stageReport.sessions?.items ?? []).slice(0, 30).map((item) => `${item.status}\t${item.dshId}\t${item.title ?? ''}${item.reason ? `\t${item.reason}` : ''}`).join('\n')}` : '')}
          </pre>
        ) : <p style={note}>{t('idle')}</p>}
      </section>

      <section style={card}>
        <h3 style={{ margin: 0 }}>{t('install')}</h3>
        <p style={note}>{t('installHint')}</p>
        <div style={row}><span style={label}>{t('claudeHome')}</span><input style={input} value={value.install.claudeHome} onChange={(event) => patch((draft) => ({ ...draft, install: { ...draft.install, claudeHome: event.target.value } }))} /></div>
        <div style={row}><span style={label}>{t('overwrite')}</span><input style={checkbox} type="checkbox" checked={value.install.overwrite} onChange={(event) => patch((draft) => ({ ...draft, install: { ...draft.install, overwrite: event.target.checked } }))} /></div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" style={button} disabled={busy} onClick={() => { void install(false) }}>{t('installPreview')}</button>
          <button type="button" style={button} disabled={busy} onClick={() => { void install(true) }}>{t('installConfirm')}</button>
        </div>
        {installReport !== undefined ? (
          <pre style={pre}>
            {`${t('installResult')}: ${installReport.dryRun === true ? 'preview ' : ''}installed=${installReport.installed ?? 0} identical=${installReport.skippedIdentical ?? 0} conflicts=${installReport.conflicts ?? 0} failed=${installReport.failed ?? 0}` +
              ((installReport.items ?? []).length > 0 ? `\n${(installReport.items ?? []).map((item) => `${item.status}\t${item.kind}\t${item.id}\t${item.targetPath}${item.reason ? `\t${item.reason}` : ''}`).join('\n')}` : '')}
          </pre>
        ) : null}
      </section>

      <section style={card}>
        <h3 style={{ margin: 0 }}>{t('status')}</h3>
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>
          {t('total')}={status?.summary?.total ?? 0} · {t('staged')}={status?.summary?.staged ?? 0} · {t('installed')}={status?.summary?.installed ?? 0}
          {status?.dshHome !== undefined ? ` · DSH=${status.dshHome}` : ''}
          {status?.claudeHome !== undefined ? ` · Claude=${status.claudeHome}` : ''}
        </div>
        {(status?.items ?? []).length === 0 ? <p style={note}>{t('noItems')}</p> : (
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
            <thead><tr>{['kind', 'id', t('stateCol'), t('targetPath')].map((head) => <th key={head} style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>{head}</th>)}</tr></thead>
            <tbody>
              {(status?.items ?? []).slice(0, 100).map((item) => (
                <tr key={`${item.kind}:${item.id}`}>
                  <td style={{ padding: '4px 8px', borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>{item.kind}</td>
                  <td style={{ padding: '4px 8px', borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>{item.id}</td>
                  <td style={{ padding: '4px 8px', borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>{item.installedAt !== undefined ? t('installedBadge') : item.status}</td>
                  <td style={{ padding: '4px 8px', borderBottom: '1px solid var(--dsw-alias-border-l2)', wordBreak: 'break-all' }}>{item.targetPath}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={card}>
        <h3 style={{ margin: 0 }}>{t('sessions')}</h3>
        {sessions.length === 0 ? <p style={note}>{t('noSessions')}</p> : (
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
            <thead><tr>{[t('session'), t('titleCol'), t('cwdCol'), t('versionCol'), t('stateCol')].map((head) => <th key={head} style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>{head}</th>)}</tr></thead>
            <tbody>
              {sessions.slice(0, 200).map((item) => (
                <tr key={item.dshId + item.ref}>
                  <td style={{ padding: '4px 8px', borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>{item.dshId}{item.auxiliary ? ' · subagent' : ''}</td>
                  <td style={{ padding: '4px 8px', borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>{item.title ?? '—'}</td>
                  <td style={{ padding: '4px 8px', borderBottom: '1px solid var(--dsw-alias-border-l2)', wordBreak: 'break-all' }}>{item.cwd ?? '—'}</td>
                  <td style={{ padding: '4px 8px', borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>v{item.version}</td>
                  <td style={{ padding: '4px 8px', borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>{item.installed ? t('installedBadge') : item.staged ? t('stagedBadge') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div style={{ display: 'flex', gap: 10 }}>
        <button type="button" style={button} disabled={busy} onClick={() => { void save() }}>{t('save')}</button>
        <button type="button" style={button} disabled={busy} onClick={() => { void run(async () => { await Promise.all([loadSettings(), loadStatus(), loadSessions()]) }) }}>{t('reload')}</button>
      </div>
    </div>
  )
}
