import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ForeignComponent } from '@kirkchinese/harness-forge-core'
import { HarnessRemoteService } from '../src/workbench/remote.js'
import { partOf } from '../src/workbench/overview.js'
import { HomeContext } from '../src/client/paths.js'
import { ConfirmInstall, DiscoverScreen } from '../src/client/discover.js'
import { GapsScreen, TaskPanel } from '../src/client/gaps.js'
import { MigratedScreen, TrustBanners } from '../src/client/migrated.js'
import { BackButton, MoreMenu } from '../src/client/index.js'
import { SessionRow, sessionRowState } from '../src/client/secondary.js'
import { newlyMigrated, sessionStartNote, type Harness, type Item, type Key, type Part, type TFn } from '../src/client/shared.js'
import english from '../src/client/locale/en.json' with { type: 'json' }
import chinese from '../src/client/locale/zh.json' with { type: 'json' }

const HOME = '/home/user'
/** What DSH's own chrome calls its buttons, which a Harness Forge button must not be named the same as. */
const DSH_CHROME_NAMES = ['More', '更多', 'Back', '返回', 'Close', '关闭']
const ROW_NOTE = "superpowers' SessionStart hook runs only when a new session starts; its other parts already work."
const ROW_NOTE_ZH = 'superpowers 的 SessionStart hook 只在新会话开始时运行；其余部分已经生效。'

const tIn = (strings: Record<string, string>): TFn => (key: Key) => strings[key] ?? key
const t = tIn(english)

function part(overrides: Partial<Part> & Pick<Part, 'kind' | 'name'>): Part {
  return { id: `demo:${overrides.kind}:${overrides.name}`, state: 'works', checked: false, reasons: [], ...overrides }
}

function item(overrides: Partial<Item> = {}): Item {
  return { id: 'claude-code:demo', name: 'demo', source: 'claude-code', root: `${HOME}/.claude/plugins/demo`, own: false, installed: false, parts: [part({ kind: 'skill', name: 'review' })], ...overrides }
}

function harness(items: Item[]): Harness {
  return { source: 'claude-code', label: 'Claude Code', items, toMigrate: items.filter(value => !value.installed).length }
}

/** `home` null: the Host told no home folder. */
function render(node: ReactNode, home: string | null = HOME): string {
  return renderToStaticMarkup(createElement(HomeContext.Provider, { value: home ?? undefined }, node))
}

const noop = async (): Promise<void> => undefined

describe('paths on the page', () => {
  it('shows a discovered plugin\'s folder as ~/…, and the full path where there is no home to fold', () => {
    const screen = createElement(DiscoverScreen, { t, harnesses: [harness([item()])], reload: noop })
    const markup = render(screen)
    expect(markup).toContain('~/.claude/plugins/demo')
    expect(markup).not.toContain(HOME)
    expect(render(screen, null)).toContain(`${HOME}/.claude/plugins/demo`)
  })

  it('shows a migrated plugin\'s folder, and a path inside a part\'s reason, as ~/…', () => {
    const failed = part({ kind: 'mcp', name: 'db', state: 'failed', reasons: [{ code: 'setup-failed', detail: `spawn ENOENT: ${HOME}/bin/db` }] })
    const markup = render(createElement(MigratedScreen, { t, items: [item({ installed: true, parts: [failed] })], signInWaiting: [], reload: noop }))
    expect(markup).toContain('~/.claude/plugins/demo')
    expect(markup).not.toContain(HOME)
  })

  it('shows a folder waiting for trust as ~/…', () => {
    const workspace = { workspace: `${HOME}/work/app`, trusted: false, sources: [], dismissed: false, waiting: [{ componentId: 'x', kind: 'hooks', name: 'h', does: '', message: '' }] }
    const markup = render(createElement(TrustBanners, { t, workspaces: [workspace], reload: noop }))
    expect(markup).toContain('~/work/app')
    expect(markup).not.toContain(HOME)
  })

  it('shows a Windows folder as ~\\…', () => {
    const windows = item({ root: 'C:\\Users\\Me\\.claude\\plugins\\demo' })
    const markup = render(createElement(DiscoverScreen, { t, harnesses: [harness([windows])], reload: noop }), 'C:\\Users\\Me')
    expect(markup).toContain('~\\.claude\\plugins\\demo')
    expect(markup).not.toContain('Users')
  })
})

describe('button names that are DSH\'s own', () => {
  it('names the More button for Harness Forge, whatever its visible text', () => {
    for (const [language, strings] of [['en', english], ['zh', chinese]] as const) {
      const markup = renderToStaticMarkup(createElement(MoreMenu, { t: tIn(strings), onPick: () => undefined }))
      const label = /aria-label="([^"]*)"/u.exec(markup)?.[1]
      expect(label, language).toBe(strings.moreActions)
      expect(DSH_CHROME_NAMES, language).not.toContain(label)
      expect(label, language).toContain('Harness Forge')
      // The visible text stays short.
      expect(markup).toContain(`>${strings.more}<`)
    }
    expect(english.moreActions).toBe('Harness Forge: more actions')
    expect(chinese.moreActions).toBe('Harness Forge：更多操作')
  })

  it('names the other generic buttons that sit with DSH\'s chrome for Harness Forge too', () => {
    for (const strings of [english, chinese]) {
      const back = renderToStaticMarkup(createElement(BackButton, { t: tIn(strings), onClick: () => undefined }))
      expect(DSH_CHROME_NAMES).not.toContain(/aria-label="([^"]*)"/u.exec(back)?.[1])
      expect(back).toContain('aria-label')
      const close = renderToStaticMarkup(createElement(TaskPanel, { gap: { item: item(), part: part({ kind: 'ui', name: 'statusline' }) }, t: tIn(strings), language: undefined, onClose: () => undefined }))
      expect(DSH_CHROME_NAMES).not.toContain(/<button[^>]*aria-label="([^"]*)"[^>]*>[^<]*<\/button>/u.exec(close)?.[1])
      expect(close).toContain(`aria-label="${strings.closeTaskLabel}"`)
    }
  })

  it('has the new names in both languages', () => {
    for (const key of ['moreActions', 'backLabel', 'closeTaskLabel', 'startsHookOne', 'startsHookOneAlone', 'startsHookMany'] as const) {
      expect(english[key].length, key).toBeGreaterThan(0)
      expect(chinese[key].length, key).toBeGreaterThan(0)
    }
  })
})

describe('what acts at the start of a session', () => {
  const startHook = part({ kind: 'hooks', name: 'hooks', atStart: true })
  const skill = part({ kind: 'skill', name: 'brainstorming' })
  const superpowers = item({ id: 'claude-code:superpowers', name: 'superpowers', installed: true, parts: [startHook, skill] })
  /** Migrated's markup, its apostrophes as the text has them. */
  const migrated = (items: Item[], strings: Record<string, string> = english): string => render(createElement(MigratedScreen, { t: tIn(strings), items, signInWaiting: [], reload: noop })).replaceAll('&#x27;', "'")

  it('says it on the row of the plugin whose SessionStart hook is active, naming the plugin', () => {
    expect(migrated([superpowers])).toContain(ROW_NOTE)
    expect(migrated([superpowers], chinese)).toContain(ROW_NOTE_ZH)
    const other = item({ id: 'claude-code:other', name: 'other', installed: true, parts: [startHook, skill] })
    const markup = migrated([superpowers, other])
    expect(markup).toContain(ROW_NOTE)
    expect(markup).toContain("other's SessionStart hook runs only when a new session starts")
  })

  it('has no line at the top of the page any more', () => {
    expect(english).not.toHaveProperty('startsInNewSessions')
    expect(chinese).not.toHaveProperty('startsInNewSessions')
    expect(migrated([superpowers])).not.toContain('Takes effect in new sessions')
  })

  it('stays silent when the hook part, or its row, is off, or it cannot run', () => {
    for (const state of ['off', 'inactive', 'unsupported', 'failed'] as const) {
      const hook = part({ kind: 'hooks', name: 'hooks', atStart: true, state, ...(state === 'inactive' ? { reasons: [{ code: 'row-off' as const, detail: 'hooks' }] } : {}) })
      expect(migrated([item({ name: 'superpowers', installed: true, parts: [hook, skill] })]), state).not.toContain('SessionStart hook')
    }
  })

  it('stays silent for parts that take effect at once', () => {
    const live = [part({ kind: 'skill', name: 's' }), part({ kind: 'command', name: 'c' }), part({ kind: 'mcp', name: 'm' }), part({ kind: 'agent', name: 'a' }), part({ kind: 'hooks', name: 'h' })]
    expect(migrated([item({ installed: true, parts: live })])).not.toContain('SessionStart hook')
  })

  it('does not say the other parts work when the hook is all there is that works', () => {
    const alone = item({ name: 'starter', installed: true, parts: [startHook, part({ kind: 'ui', name: 'statusline', state: 'needs-port' })] })
    expect(sessionStartNote([alone], t)).toBe("starter's SessionStart hook runs only when a new session starts.")
    expect(sessionStartNote([alone], tIn(chinese))).toBe('starter 的 SessionStart hook 只在新会话开始时运行。')
  })

  it('names the plugins a migration added: the row sentence for one, one line listing several', () => {
    expect(sessionStartNote([superpowers], t)).toBe(ROW_NOTE)
    const other = item({ id: 'claude-code:other', name: 'other', installed: true, parts: [startHook, skill] })
    const plain = item({ id: 'claude-code:plain', name: 'plain', installed: true })
    expect(sessionStartNote([superpowers, plain, other], t)).toBe('The SessionStart hooks of superpowers, other run only when a new session starts; their other parts already work.')
    expect(sessionStartNote([superpowers, other], tIn(chinese))).toBe('superpowers、other 的 SessionStart hook 只在新会话开始时运行；其余部分已经生效。')
    expect(sessionStartNote([plain], t)).toBeUndefined()
    expect(sessionStartNote([item({ name: 'x', installed: true, parts: [part({ kind: 'hooks', name: 'hooks', atStart: true, state: 'off' })] })], t)).toBeUndefined()
  })

  it('finds the plugins a migration added, by what was migrated before', () => {
    const before = new Set(['claude-code:old'])
    const old = item({ id: 'claude-code:old', installed: true, parts: [startHook] })
    const added = item({ id: 'claude-code:new', installed: true, parts: [startHook] })
    const plain = item({ id: 'claude-code:plain', installed: true })
    const notYet = item({ id: 'claude-code:later', installed: false, parts: [startHook] })
    expect(newlyMigrated(before, [old, added, plain, notYet]).map(value => value.id)).toEqual(['claude-code:new', 'claude-code:plain'])
  })

  it('does not show the note on Gaps', () => {
    expect(render(createElement(GapsScreen, { t, items: [superpowers], openSession: () => undefined }))).not.toContain('SessionStart hook')
  })
})

describe('the install confirmation', () => {
  const plan = {
    token: 'x',
    name: 'claude-hud',
    harness: 'claude-code',
    source: `${HOME}/.claude/plugins/marketplaces/local/plugins/claude-hud`,
    revision: 'local',
    parts: [
      { kind: 'skill', name: 'hud' },
      { kind: 'ui', name: 'statusline', gap: `status line at ${HOME}/hud/install.mjs`, reasons: [{ code: 'no-equivalent-ui' as const, detail: '' }] },
    ],
    codeParts: [
      { kind: 'skill', name: 'hud', what: 'shell' as const, detail: `node ${HOME}/hud/bin.js`, runs: true },
      { kind: 'ui', name: 'statusline', what: 'script' as const, detail: 'install.mjs', runs: false, reasons: [{ code: 'no-equivalent-ui' as const, detail: '' }] },
    ],
    adaptable: true,
    works: 1,
    total: 2,
    pluginId: 'claude-code:claude-hud',
    alreadyInstalled: false,
  }
  const confirm = (value: typeof plan = plan): string => render(createElement(ConfirmInstall, { t, plan: value, busy: false, onConfirm: () => undefined, onCancel: () => undefined }))

  it('shows a source on this computer, and any path in the warning, as ~/…', () => {
    const markup = confirm()
    expect(markup).toContain('~/.claude/plugins/marketplaces/local/plugins/claude-hud')
    expect(markup).toContain('node ~/hud/bin.js')
    expect(markup).not.toContain(HOME)
  })

  it('colours only what runs code', () => {
    const markup = confirm()
    const warned = [...markup.matchAll(/<div class="hf-notice-warn">([^<]*)<\/div>/gu)].map(match => match[1])
    expect(warned).toEqual(['These parts run code with your permissions once installed: hud.', 'hud (Skill) — shell lines node ~/hud/bin.js: runs in DSH once installed.'])
    expect(markup).not.toContain('data-kind="error"')
    expect(markup).toContain(`<div>${english.confirmTrust}</div>`)
    expect(markup).toContain('<div>statusline (Interface) — script install.mjs: a gap, runs nothing in DSH.</div>')
  })
})

describe('Import sessions', () => {
  it('shows a session\'s working directory as ~/…', () => {
    const session = { source: 'claude-code', path: `${HOME}/.claude/projects/app/1.jsonl`, sourceId: '1', title: 'Fix it', cwd: `${HOME}/work/app` }
    const markup = render(createElement(SessionRow, { t, session, state: sessionRowState(t, session, {}, undefined), busy: undefined, onOpen: () => undefined, onImport: () => undefined }))
    expect(markup).toContain('~/work/app')
    expect(markup).not.toContain(HOME)
    expect(render(createElement(SessionRow, { t, session, state: sessionRowState(t, session, {}, undefined), busy: undefined, onOpen: () => undefined, onImport: () => undefined }), null)).toContain(`${HOME}/work/app`)
  })
})

describe('the Host marks what acts at the start of a session', () => {
  const base = { id: 'p:x:y', name: 'y', path: '' }
  const mark = (component: unknown): unknown => partOf(component as ForeignComponent, [], undefined, undefined).atStart

  it('marks SessionStart hooks', () => {
    expect(mark({ ...base, kind: 'hooks', events: ['PreToolUse', 'SessionStart'], handlerTypes: ['command'], modules: [], configPath: '' })).toBe(true)
  })

  it('leaves out what takes effect at once: other hooks, system-prompt sections read at every step, skills, commands, agents, MCP servers, status lines', () => {
    expect(mark({ ...base, kind: 'ui', surface: 'output-style' })).toBeUndefined()
    expect(mark({ ...base, kind: 'other', originalKind: 'codex-instructions' })).toBeUndefined()
    expect(mark({ ...base, kind: 'hooks', events: ['PreToolUse', 'Stop'], handlerTypes: ['command'], modules: [], configPath: '' })).toBeUndefined()
    expect(mark({ ...base, kind: 'skill' })).toBeUndefined()
    expect(mark({ ...base, kind: 'command' })).toBeUndefined()
    expect(mark({ ...base, kind: 'agent' })).toBeUndefined()
    expect(mark({ ...base, kind: 'mcp', transport: 'stdio' })).toBeUndefined()
    expect(mark({ ...base, kind: 'ui', surface: 'statusline' })).toBeUndefined()
    expect(mark({ ...base, kind: 'other', originalKind: 'codex-notify' })).toBeUndefined()
  })
})

describe('the overview tells the page the home folder', () => {
  it('sends the Host\'s home folder with the overview', async () => {
    vi.stubEnv('HOME', '/home/someone')
    vi.stubEnv('USERPROFILE', 'C:\\Users\\Someone')
    try {
      const remote = Object.create(HarnessRemoteService.prototype) as HarnessRemoteService
      Object.defineProperty(remote, 'forge', { value: { follow: async () => undefined, applying: () => undefined, projects: { workspaces: async () => [] } } })
      Object.defineProperty(remote, 'workbench', { value: { overview: async () => ({ harnesses: [], fetched: [] }) } })
      const overview = await remote.overview() as { home?: string; harnesses: unknown[] }
      expect(overview.harnesses).toEqual([])
      expect(overview.home).toBe(process.platform === 'win32' ? 'C:\\Users\\Someone' : '/home/someone')
    } finally { vi.unstubAllEnvs() }
  })
})
