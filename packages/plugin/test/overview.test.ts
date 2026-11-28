import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { scanClaudeUserAssets, scanCodexUserAssets, scanPlugin, type ComponentOutcome } from '@kirkchinese/harness-forge-core'
import { itemOf, overviewOf, partOf, unreadableItemOf } from '../src/workbench/overview.js'
import { HarnessRemoteService } from '../src/workbench/remote.js'
import { Workbench } from '../src/workbench/workbench.js'
import { fill, REASON_LABEL } from '../src/client/shared.js'
import english from '../src/client/locale/en.json' with { type: 'json' }
import chinese from '../src/client/locale/zh.json' with { type: 'json' }

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

  it('counts and migrates only what Claude Code installed and the person\'s own settings, never marketplace offers', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hf-overview-offers-'))
    roots.push(home)
    const write = (path: string, text: string): void => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
    }
    const plugins = join(home, '.claude', 'plugins')
    write(join(home, '.claude', 'skills', 'mine', 'SKILL.md'), '---\nname: mine\ndescription: Mine\n---\n\nMine.\n')
    const installed = join(plugins, 'cache', 'market', 'kept', '1.0.0')
    write(join(installed, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'kept', version: '1.0.0' }))
    write(join(installed, 'skills', 'k', 'SKILL.md'), '---\nname: k\ndescription: K\n---\n\nK.\n')
    write(join(plugins, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'kept@market': [{ installPath: installed }] } }))
    const market = join(plugins, 'marketplaces', 'market')
    write(join(market, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'market', plugins: [{ name: 'kept', source: './kept' }, { name: 'docker', source: './docker' }, { name: 'venv', source: './venv' }] }))
    for (const name of ['kept', 'docker', 'venv']) write(join(market, name, '.claude-plugin', 'plugin.json'), JSON.stringify({ name }))
    write(join(market, 'docker', '.mcp.json'), JSON.stringify({ mcpServers: { tf: { command: 'docker', args: ['run', 'hashicorp/terraform-mcp-server'] } } }))
    write(join(market, 'venv', 'hooks', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'python3 setup.py' }] }] } }))
    write(join(plugins, 'known_marketplaces.json'), JSON.stringify({ market: { source: { source: 'github', repo: 'x/market' }, installLocation: market } }))
    vi.stubEnv(process.platform === 'win32' ? 'USERPROFILE' : 'HOME', home)
    try {
      const install = vi.fn(async (root: string) => ({ plugin: { name: root } }))
      const workbench = new Workbench({
        ledger: {
          statePath: join(home, 'state.json'), live: new Map(), list: () => [],
          scan: (root: string) => root === join(home, '.claude') ? scanClaudeUserAssets(home)! : scanPlugin(root, { source: 'claude-code' }).plugin,
        },
        install,
      } as never)
      vi.spyOn(workbench, 'settings').mockReturnValue({ schemaVersion: 1, discoveryRoots: [plugins], autoDiscover: false })
      vi.spyOn(workbench, 'enabledAdapters').mockResolvedValue([])
      const claude = (await workbench.overview()).harnesses.find(harness => harness.source === 'claude-code')!
      expect(claude.items.map(item => item.name).sort()).toEqual(['kept', 'user'])
      expect(claude.toMigrate).toBe(2)
      const result = await workbench.migrate('claude-code')
      expect(install.mock.calls.map(call => call[0]).sort()).toEqual([join(home, '.claude'), installed].sort())
      expect(result.failed).toEqual([])
      // The marketplace is offered under "Get plugins" instead, to install from one plugin at a time.
      expect(workbench.localMarketplaces()).toEqual([{ input: market, name: 'market', harness: 'claude-code' }])
    } finally { vi.unstubAllEnvs() }
  })

  it('lists plugins switched off in Claude Code and Codex, but leaves them out of Migrate all', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hf-overview-disabled-'))
    roots.push(home)
    const write = (path: string, text: string): void => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
    }
    const skill = (root: string, name: string): void => write(join(root, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n\n${name}.\n`)
    const claudePlugins = join(home, '.claude', 'plugins')
    const claudeRoots = Object.fromEntries(['on', 'off'].map(name => [name, join(claudePlugins, 'cache', 'market', `claude-${name}`, '1.0.0')]))
    for (const [name, root] of Object.entries(claudeRoots)) {
      write(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: `claude-${name}` }))
      skill(root, `c-${name}`)
    }
    write(join(claudePlugins, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: Object.fromEntries(Object.entries(claudeRoots).map(([name, root]) => [`claude-${name}@market`, [{ scope: 'user', installPath: root }]])) }))
    write(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'claude-off@market': false } }))
    const codexPlugins = join(home, '.codex', 'plugins')
    const codexRoots = Object.fromEntries(['on', 'off'].map(name => [name, join(codexPlugins, 'cache', 'market', `codex-${name}`, '1.0.0')]))
    for (const [name, root] of Object.entries(codexRoots)) {
      write(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: `codex-${name}` }))
      skill(root, `x-${name}`)
    }
    write(join(home, '.codex', 'config.toml'), '[plugins."codex-on@market"]\nenabled = true\n\n[plugins."codex-off@market"]\nenabled = false\n')
    vi.stubEnv(process.platform === 'win32' ? 'USERPROFILE' : 'HOME', home)
    vi.stubEnv('CODEX_HOME', join(home, '.codex'))
    try {
      const install = vi.fn(async (root: string) => ({ plugin: { name: root } }))
      const workbench = new Workbench({
        ledger: {
          statePath: join(home, 'state.json'), live: new Map(), list: () => [],
          scan: (root: string, source?: string) => scanPlugin(root, { source: source ?? 'claude-code' }).plugin,
        },
        install,
      } as never)
      vi.spyOn(workbench, 'settings').mockReturnValue({ schemaVersion: 1, discoveryRoots: [claudePlugins, codexPlugins], autoDiscover: false })
      vi.spyOn(workbench, 'enabledAdapters').mockResolvedValue([])
      const overview = await workbench.overview()
      for (const [source, prefix, roots] of [['claude-code', 'claude', claudeRoots], ['codex', 'codex', codexRoots]] as const) {
        const harness = overview.harnesses.find(item => item.source === source)!
        const plugins = harness.items.filter(item => !item.own)
        // Still listed, marked off; the count the button shows leaves it out.
        expect(plugins.map(item => [item.name, item.enabled ?? true]).sort()).toEqual([[`${prefix}-off`, false], [`${prefix}-on`, true]])
        expect(harness.toMigrate).toBe(harness.items.filter(item => item.enabled !== false).length)
        install.mockClear()
        await workbench.migrate(source)
        const migrated = install.mock.calls.map(call => call[0])
        expect(migrated).toContain(roots['on'])
        expect(migrated).not.toContain(roots['off'])
        expect(migrated).toHaveLength(harness.toMigrate)
      }
    } finally { vi.unstubAllEnvs() }
  })

  it('leaves out of "Migrate all" an OpenCode plugin whose state its id leaves unknown, and says why', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hf-overview-opencode-'))
    roots.push(home)
    const config = join(home, '.config', 'opencode')
    const pkg = (name: string, id: string): string => {
      const root = join(config, 'node_modules', name)
      mkdirSync(root, { recursive: true })
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name, main: 'index.js' }))
      writeFileSync(join(root, 'index.js'), `export default Plugin.define({ id: ${id}, setup() {} })\n`)
      return root
    }
    const on = pkg('opencode-on', '"on.pkg"')
    const off = pkg('opencode-off', '"off.pkg"')
    const unsure = pkg('opencode-unsure', 'process.env.PLUGIN_ID')
    // `off\u002epkg` is `off.pkg` to JavaScript: the same entry switches it off.
    const escaped = pkg('opencode-escaped', "'off\\u002epkg'")
    writeFileSync(join(config, 'opencode.json'), JSON.stringify({ plugins: ['opencode-on', 'opencode-off', 'opencode-unsure', 'opencode-escaped', '-off.pkg'] }))
    vi.stubEnv(process.platform === 'win32' ? 'USERPROFILE' : 'HOME', home)
    try {
      const install = vi.fn(async (root: string) => ({ plugin: { name: root } }))
      const workbench = new Workbench({
        ledger: {
          statePath: join(home, 'state.json'), live: new Map(), list: () => [],
          scan: (root: string, source?: string) => scanPlugin(root, { source: source ?? 'opencode' }).plugin,
        },
        install,
      } as never)
      vi.spyOn(workbench, 'settings').mockReturnValue({ schemaVersion: 1, discoveryRoots: [join(config, 'plugins')], autoDiscover: false })
      vi.spyOn(workbench, 'enabledAdapters').mockResolvedValue([])
      const harness = (await workbench.overview()).harnesses.find(item => item.source === 'opencode')!
      const byRoot = new Map(harness.items.map(item => [item.root, item]))
      expect(byRoot.get(on)).not.toHaveProperty('enabledUnknown')
      expect(byRoot.get(off)).toMatchObject({ enabled: false })
      expect(byRoot.get(escaped)).toMatchObject({ enabled: false })
      expect(byRoot.get(unsure)).toMatchObject({ enabledUnknown: 'dynamic' })
      expect(harness.toMigrate).toBe(1)
      await workbench.migrate('opencode')
      expect(install.mock.calls.map(call => call[0])).toEqual([on])
      // In the person's language, with why.
      expect(fill((english as Record<string, string>)['enabledUnknownNote']!, { harness: 'OpenCode', why: (english as Record<string, string>)['pluginIdDynamic']! })).toContain('computed')
    } finally { vi.unstubAllEnvs() }
  })

  it('migrates all of the section it was asked for, Agent Skills included', async () => {
    const migrate = vi.fn(async () => ({ installed: ['skills'], failed: [] }))
    const remote = Object.create(HarnessRemoteService.prototype) as HarnessRemoteService
    Object.defineProperty(remote, 'workbench', { value: { migrate } })
    for (const source of ['agent-skills', 'codex', 'opencode', 'claude-code']) await remote.migrate({ source })
    expect(migrate.mock.calls.map(call => (call as unknown[])[0])).toEqual(['agent-skills', 'codex', 'opencode', 'claude-code'])
    await expect(remote.migrate({ source: 'nowhere' })).rejects.toMatchObject({ details: { operation: 'migrate' } })
    expect(migrate).toHaveBeenCalledTimes(4)
  })

  it('says Codex\'s global instructions and notify program work: DSH runs both', () => {
    const home = mkdtempSync(join(tmpdir(), 'hf-overview-codex-'))
    roots.push(home)
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex', 'AGENTS.md'), 'Answer in English.\n')
    writeFileSync(join(home, '.codex', 'config.toml'), 'notify = ["notify-send", "Codex"]\n')
    vi.stubEnv('CODEX_HOME', join(home, '.codex'))
    try {
      const item = itemOf(scanCodexUserAssets(home)!, undefined)
      expect(item.parts.map(part => [part.name, part.state])).toEqual(expect.arrayContaining([['agents-md', 'works'], ['notify', 'works']]))
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
  it('says why an MCP server is not started in codes, and a ChatGPT sign-in is not something an adapter fixes', () => {
    const root = mkdtempSync(join(tmpdir(), 'hf-overview-mcp-'))
    roots.push(root)
    mkdirSync(join(root, '.codex-plugin'), { recursive: true })
    writeFileSync(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }))
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: {
      off: { command: 'x', enabled: false },
      promo: { type: 'http', url: 'https://chatgpt.com/mcp', auth: 'chatgpt' },
    } }))
    const scanned = scanPlugin(root, { source: 'codex' }).plugin
    const skipped = (name: string): ComponentOutcome => ({ componentId: scanned.components.find(component => component.name === name)!.id, status: 'skipped', level: 'L0', evidence: 'source', message: 'English words' })
    const item = itemOf(scanned, { outcomes: [skipped('off'), skipped('promo')] })
    expect(item.parts.find(part => part.name === 'off')).toMatchObject({ reasons: [{ code: 'disabled-in-plugin', detail: '' }] })
    const promo = item.parts.find(part => part.name === 'promo')!
    expect(promo).toMatchObject({ state: 'unsupported', reasons: [{ code: 'needs-chatgpt-sign-in', detail: '' }] })
    expect(promo.portGap).toBeUndefined()
    // Before migration the prediction is the same.
    expect(itemOf(scanned, undefined).parts.find(part => part.name === 'promo')).toMatchObject({ state: 'unsupported', reasons: [{ code: 'needs-chatgpt-sign-in' }] })
  })

  it('says a project server Claude Code switched off in a code too', () => {
    const scanned = plugin()
    const skill = scanned.components.find(component => component.kind === 'skill')!
    const outcome: ComponentOutcome = { componentId: skill.id, status: 'skipped', level: 'L0', evidence: 'source', message: 'English words', skippedBy: 'disabled-in-claude-code' }
    expect(partOf(skill, [], outcome, undefined).reasons).toEqual([{ code: 'disabled-in-claude-code', detail: '' }])
  })

  it('words every reason code in both languages', () => {
    for (const [code, key] of Object.entries(REASON_LABEL)) {
      if (key === undefined) continue
      expect((english as Record<string, string>)[key], `${code} in English`).toBeTruthy()
      expect((chinese as Record<string, string>)[key], `${code} in Chinese`).toBeTruthy()
    }
  })
})
