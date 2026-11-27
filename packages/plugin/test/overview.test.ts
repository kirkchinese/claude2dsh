import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { scanClaudeUserAssets, scanPlugin, type ComponentOutcome } from '@kirkchinese/harness-forge-core'
import { itemOf, overviewOf, partOf, unreadableItemOf } from '../src/workbench/overview.js'
import { Workbench } from '../src/workbench/workbench.js'

const roots: string[] = []
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

/** A Claude Code plugin: a skill, a status line, hooks on an event DSH serves and one it never raises. */
function plugin(): ReturnType<typeof scanPlugin>['plugin'] {
  const root = mkdtempSync(join(tmpdir(), 'hf-overview-'))
  roots.push(root)
  const files: Record<string, string> = {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '1.2.0', license: 'MIT', statusLine: { type: 'command', command: 'node hud.mjs' } }),
    'skills/review/SKILL.md': '---\nname: review\ndescription: Review code.\n---\nReview it.\n',
    'hooks/hooks.json': JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node a.mjs' }] }] } }),
    'hud.mjs': '',
  }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return scanPlugin(root, { source: 'claude-code' }).plugin
}

describe('workbench overview', () => {
  it('predicts each part before migration: a status line needs porting, the rest works', () => {
    const item = itemOf(plugin(), undefined)
    expect(item.installed).toBe(false)
    const ui = item.parts.find(part => part.kind === 'ui')!
    expect(ui).toMatchObject({ name: 'statusline', state: 'needs-port', reasons: [{ code: 'no-equivalent-ui' }] })
    expect(ui.portGap).toBeDefined()
    expect(item.parts.find(part => part.kind === 'skill')).toMatchObject({ state: 'works', checked: false })
    expect(item.counts['needs-port']).toBe(1)
  })

  it('reports what happened after migration: verified, failed in some runs, failed in all, failed to set up', () => {
    const scanned = plugin()
    const skill = scanned.components.find(component => component.kind === 'skill')!
    const hooks = scanned.components.find(component => component.kind === 'hooks')!
    const at = '2026-11-18T00:00:00Z'
    // As the service records them: any failing signal makes the outcome failed, its message the mount identity.
    const outcomes: ComponentOutcome[] = [
      { componentId: skill.id, status: 'verified', level: 'L1a', evidence: 'runtime', observations: [{ signal: 'load', ok: true, at }] } as ComponentOutcome,
      { componentId: hooks.id, status: 'failed', level: 'L2', evidence: 'runtime', message: 'demo hooks', observations: [{ signal: 'PreToolUse', ok: true, at }, { signal: 'Stop', ok: false, at, detail: 'a.mjs exited 1' }] } as ComponentOutcome,
    ]
    const item = itemOf(scanned, { outcomes })
    expect(item.parts.find(part => part.id === skill.id)).toMatchObject({ state: 'works', checked: true })
    expect(item.checked).toBe(1)
    expect(item.parts.find(part => part.id === hooks.id)).toMatchObject({ state: 'partial', reasons: [{ code: 'run-failed', detail: 'a.mjs exited 1' }] })
    const allFailed = itemOf(scanned, { outcomes: [{ componentId: hooks.id, status: 'failed', level: 'L2', evidence: 'runtime', message: 'demo hooks', observations: [{ signal: 'Stop', ok: false, at, detail: 'a.mjs exited 1' }] } as ComponentOutcome] })
    expect(allFailed.parts.find(part => part.id === hooks.id)).toMatchObject({ state: 'failed', reasons: [{ code: 'run-failed', detail: 'a.mjs exited 1' }] })
    const failed = itemOf(scanned, { outcomes: [{ componentId: skill.id, status: 'failed', level: 'L0', evidence: 'runtime', message: 'skill root unreadable' } as ComponentOutcome] })
    expect(failed.parts.find(part => part.id === skill.id)).toMatchObject({ state: 'failed', reasons: [{ code: 'setup-failed', detail: 'skill root unreadable' }] })
  })

  it('keeps an installed plugin whose files are gone, every part an error with the reason', () => {
    const item = unreadableItemOf({ id: 'claude-code:demo', name: 'demo', source: 'claude-code', root: '/gone', components: [{ kind: 'skill', name: 'review' }, { kind: 'hooks', name: 'hooks' }] }, 'ENOENT: /gone/.claude-plugin/plugin.json')
    expect(item).toMatchObject({ installed: true, counts: { failed: 2 }, checked: 0 })
    expect(item.parts.every(part => part.state === 'failed' && part.reasons[0]?.code === 'unreadable' && part.reasons[0].detail.includes('ENOENT'))).toBe(true)
  })

  it('shows a part an installed adapter brings as provided by it, and not as checked here', () => {
    const item = itemOf(plugin(), undefined, [{ name: 'dsh-adapter-demo-statusline', ports: [{ plugin: 'demo', component: 'statusline' }] }])
    expect(item.parts.find(part => part.kind === 'ui')).toMatchObject({ state: 'works', checked: false, adapter: 'dsh-adapter-demo-statusline' })
    expect(item.checked).toBe(0)
  })

  it('projects a configured plugin status line as one port, with coverage reflected in settings', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hf-overview-owner-'))
    roots.push(home)
    const claude = join(home, '.claude')
    mkdirSync(claude)
    const pluginRoot = join(claude, 'plugins', 'cache', 'market', 'hud', '1.0')
    mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true })
    writeFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'hud' }))
    writeFileSync(join(pluginRoot, 'hud.mjs'), '')
    writeFileSync(join(home, 'standalone.mjs'), '')
    writeFileSync(join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'hud@market': [{ installPath: pluginRoot }] } }))
    const settings = (path: string): void => writeFileSync(join(claude, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: `node "${path}"` } }))
    settings(join(pluginRoot, 'hud.mjs'))
    vi.stubEnv(process.platform === 'win32' ? 'USERPROFILE' : 'HOME', home)
    try {
      const workbench = new Workbench({ ledger: {
        statePath: join(home, 'state.json'), live: new Map(), list: () => [],
        scan: (root: string) => root === claude ? scanClaudeUserAssets(home) : scanPlugin(root, { source: 'claude-code' }).plugin,
      } } as never)
      const adapters = vi.spyOn(workbench, 'enabledAdapters').mockResolvedValue([])
      const before = (await workbench.overview()).harnesses.find(harness => harness.source === 'claude-code')!
      expect(before.counts['needs-port']).toBe(1)
      expect(before.items.flatMap(item => item.parts).filter(part => part.portGap !== undefined)).toMatchObject([{ id: 'claude-code:hud:ui:statusline' }])
      expect(before.items.find(item => item.own)?.parts).toMatchObject([{ name: 'statusline-settings', state: 'provided', providedBy: { name: 'hud' } }])
      expect(workbench.findPlugin('claude-code:hud').gaps.filter(gap => gap.kind === 'ui-surface')).toMatchObject([{ componentId: 'claude-code:hud:ui:statusline' }])
      expect(workbench.findPlugin('claude-code:user').plugin.components).toEqual([])
      adapters.mockResolvedValue([{ name: 'dsh-adapter-hud-statusline', ports: [{ plugin: 'hud', component: 'statusline' }] }])
      const after = (await workbench.overview()).harnesses.find(harness => harness.source === 'claude-code')!
      expect(after.counts['needs-port']).toBe(0)
      expect(after.items.find(item => item.own)?.parts).toMatchObject([{ state: 'provided', providedBy: { name: 'hud', adapter: 'dsh-adapter-hud-statusline' } }])
      expect(after.items.flatMap(item => item.parts).filter(part => part.adapter !== undefined)).toHaveLength(1)
      settings(join(home, 'standalone.mjs'))
      const standalone = (await workbench.overview()).harnesses.find(harness => harness.source === 'claude-code')!
      expect(standalone.items.find(item => item.own)?.parts).toMatchObject([{ name: 'statusline-settings', state: 'needs-port' }])
    } finally { vi.unstubAllEnvs() }
  })

  it('lists a plugin installed from the network apart from what the harnesses\' folders hold', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hf-overview-fetched-'))
    roots.push(home)
    const dataRoot = join(home, 'data')
    const local = plugin()
    const fetchedRoot = join(dataRoot, 'remote', 'plugins', 'abc', 'demo')
    mkdirSync(join(fetchedRoot, '.claude-plugin'), { recursive: true })
    writeFileSync(join(fetchedRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'fetched', license: 'MIT' }))
    const record = (id: string, root: string) => ({ id, name: id.split(':')[1], source: 'claude-code', root, installedAt: '2026-11-27T00:00:00Z', components: [] })
    vi.stubEnv(process.platform === 'win32' ? 'USERPROFILE' : 'HOME', home)
    try {
      const workbench = new Workbench({ ledger: {
        statePath: join(home, 'state.json'), dataRoot, live: new Map(),
        list: () => [record('claude-code:demo', local.root), record('claude-code:fetched', fetchedRoot)],
        scan: (root: string) => scanPlugin(root, { source: 'claude-code' }).plugin,
      } } as never)
      vi.spyOn(workbench, 'enabledAdapters').mockResolvedValue([])
      const overview = await workbench.overview()
      const claude = overview.harnesses.find(harness => harness.source === 'claude-code')!
      // What the harness's folders hold stays (other test plugins may be found too); the network install does not.
      expect(claude.items.map(item => item.name)).toContain('demo')
      expect(claude.items.map(item => item.name)).not.toContain('fetched')
      expect(overview.fetched).toMatchObject([{ name: 'fetched', installed: true, fetched: true }])
    } finally { vi.unstubAllEnvs() }
  })

  it('groups by harness and counts what is left to migrate', () => {
    const overview = overviewOf([itemOf(plugin(), undefined)])
    const claude = overview.harnesses.find(harness => harness.source === 'claude-code')!
    expect(overview.harnesses.map(harness => harness.source)).toEqual(['claude-code', 'codex', 'opencode'])
    expect(claude.toMigrate).toBe(1)
    expect(claude.counts.works).toBeGreaterThan(0)
  })

  it('shows a common-format dialect only when it found something, under its label', () => {
    const scanned = plugin()
    const skills = itemOf({ ...scanned, id: 'agent-skills:team', source: 'agent-skills', name: 'team' }, undefined)
    const overview = overviewOf([skills])
    expect(overview.harnesses.map(harness => [harness.source, harness.label])).toEqual([
      ['claude-code', 'Claude Code'], ['codex', 'Codex'], ['opencode', 'OpenCode'], ['agent-skills', 'Agent Skills'],
    ])
    expect(overview.harnesses.at(-1)?.items).toHaveLength(1)
  })

  it('says a Codex app connector cannot be ported: OpenAI hosts it', () => {
    const component = { id: 'codex:gmail:other:app', kind: 'other', name: 'app-connector-apps', originalKind: 'app-connector' } as never
    const gaps = [{ id: 'codex:gmail:other:app:unsupported', componentId: 'codex:gmail:other:app', kind: 'unsupported-component', summary: 'app-connector is not mapped to DSH', detail: '', suggestedAction: 'generate' }] as never
    expect(partOf(component, gaps, undefined, undefined)).toMatchObject({ state: 'unsupported', reasons: [{ code: 'hosted-connector' }] })
    expect(partOf(component, gaps, undefined, undefined).portGap).toBeUndefined()
  })

  it('tells a part the person switched off from one whose row is off, and names the row', () => {
    const scanned = plugin()
    const skill = scanned.components.find(component => component.kind === 'skill')!
    const rowOff: ComponentOutcome = { componentId: skill.id, status: 'inactive', level: 'L0', evidence: 'source', message: 'inactive because the skills row is off' }
    expect(itemOf(scanned, { outcomes: [rowOff] }).parts.find(part => part.id === skill.id)).toMatchObject({ state: 'inactive', reasons: [{ code: 'row-off', detail: 'skills' }] })
    const off = itemOf(scanned, { outcomes: [rowOff], disabled: [skill.id] })
    expect(off.parts.find(part => part.id === skill.id)).toMatchObject({ state: 'off', reasons: [] })
    expect(off.counts.off).toBe(1)
  })
})
