/**
 * A migrated plugin follows the harness that installed it: to the folder of a
 * new version when the harness updates it, and out of DSH when the harness no
 * longer runs it, until the person keeps or removes it.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readState } from '../src/forge/state.js'
import { TestHarness } from './harness.js'

const temporary: string[] = []
afterAll(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/** A plugin version folder with one skill per name, in Codex's or Claude Code's layout. */
function pluginAt(root: string, harness: 'codex' | 'claude-code', name: string, version: string, skills: readonly string[]): string {
  write(join(root, harness === 'codex' ? '.codex-plugin' : '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version, ...(harness === 'codex' ? { skills: './skills/' } : {}) }))
  for (const skill of skills) write(join(root, 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: ${skill}\n---\n\n${skill}.\n`)
  return root
}

let home: string
let codex: string
let claude: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hf-follow-'))
  temporary.push(home)
  codex = join(home, '.codex')
  claude = join(home, '.claude', 'plugins')
  vi.stubEnv(process.platform === 'win32' ? 'USERPROFILE' : 'HOME', home)
  vi.stubEnv('CODEX_HOME', codex)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

/** Codex's record: the installed plugins of `config.toml`. */
function codexInstalls(entries: Readonly<Record<string, boolean>>): void {
  write(join(codex, 'config.toml'), Object.entries(entries).map(([key, enabled]) => `[plugins."${key}"]\nenabled = ${String(enabled)}\n`).join('\n'))
}

/** Claude Code's record: `installed_plugins.json`, one user-scope install per key. */
function claudeInstalls(entries: Readonly<Record<string, string>>): void {
  write(join(claude, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: Object.fromEntries(Object.entries(entries).map(([key, installPath]) => [key, [{ scope: 'user', installPath }]])) }))
}

function harness(): TestHarness {
  const service = new TestHarness({ get: () => undefined } as never, join(home, 'state.json'), join(home, 'data'))
  service.saveSettings({ discoveryRoots: [claude, join(codex, 'plugins')] })
  vi.spyOn(service.workbench, 'enabledAdapters').mockResolvedValue([])
  return service
}

async function items(service: TestHarness) {
  return (await service.workbench.overview()).harnesses.flatMap(group => group.items)
}

describe('a migrated plugin follows its harness', () => {
  it('moves to the folder of a Codex update when the old version is deleted, at the next start', async () => {
    const old = pluginAt(join(codex, 'plugins', 'cache', 'market', 'docs', '1.0.0'), 'codex', 'docs', '1.0.0', ['read'])
    codexInstalls({ 'docs@market': true })
    const first = harness()
    await first.start()
    await first.install(old, 'codex')
    expect(first.list()[0]?.harnessInstall).toEqual({ harness: 'codex', key: 'docs@market' })
    await first.dispose()

    // Codex updates it: a new version folder, the old one deleted.
    const next = pluginAt(join(codex, 'plugins', 'cache', 'market', 'docs', '2.0.0'), 'codex', 'docs', '2.0.0', ['read', 'write'])
    rmSync(old, { recursive: true })
    const second = harness()
    try {
      await second.start()
      const [record] = second.list()
      expect(record).toMatchObject({ id: 'codex:docs', root: next, version: '2.0.0', harnessUpdate: { from: '1.0.0', to: '2.0.0' } })
      expect(record?.detached).toBeUndefined()
      expect(second.listSkillRoots()).toEqual([join(next, 'skills')])
      const item = (await items(second)).find(found => found.id === 'codex:docs')!
      expect(item.parts.map(part => [part.name, part.state])).toEqual([['read', 'works'], ['write', 'works']])
      expect(item.updated).toMatchObject({ harness: 'codex', from: '1.0.0', to: '2.0.0' })
      // The new version is the migrated one: Discover does not offer it again.
      expect((await second.workbench.discover()).plugins.find(found => found.root === next)?.installed).toBe(true)
      expect(readState(join(home, 'state.json')).plugins[0]?.root).toBe(next)
    } finally {
      await second.dispose()
    }
  })

  it('moves to the folder installed_plugins.json names after a Claude Code update while running, keeping the parts switched off', async () => {
    const old = pluginAt(join(claude, 'cache', 'market', 'hud', '1.0.0'), 'claude-code', 'hud', '1.0.0', ['alpha', 'beta'])
    claudeInstalls({ 'hud@market': old })
    const service = harness()
    try {
      await service.start()
      await service.install(old, 'claude-code')
      expect(await service.forge.setPartEnabled('claude-code:hud', 'claude-code:hud:skill:beta', false)).toBe(true)

      const next = pluginAt(join(claude, 'cache', 'market', 'hud', '1.1.0'), 'claude-code', 'hud', '1.1.0', ['alpha', 'beta'])
      claudeInstalls({ 'hud@market': next })
      // Before the follow runs, the current install already counts as migrated: it is not offered twice.
      expect((await service.workbench.discover()).plugins.find(found => found.root === next)?.installed).toBe(true)
      await service.forge.follow()
      const [record] = service.list()
      expect(record).toMatchObject({ root: next, version: '1.1.0', disabled: ['claude-code:hud:skill:beta'], harnessUpdate: { from: '1.0.0', to: '1.1.0' } })
      const item = (await items(service)).find(found => found.id === 'claude-code:hud')!
      expect(item.parts.map(part => [part.name, part.state])).toEqual([['alpha', 'works'], ['beta', 'off']])
    } finally {
      await service.dispose()
    }
  })

  it('stops a plugin uninstalled in its harness until the person keeps it, and then follows that harness no more', async () => {
    const root = pluginAt(join(codex, 'plugins', 'cache', 'market', 'docs', '1.0.0'), 'codex', 'docs', '1.0.0', ['read'])
    codexInstalls({ 'docs@market': true })
    const service = harness()
    try {
      await service.start()
      await service.install(root, 'codex')
      expect(service.listSkillRoots()).toEqual([join(root, 'skills')])

      codexInstalls({})
      await service.forge.follow()
      expect(service.list()[0]?.detached?.reason).toBe('uninstalled')
      expect(service.listSkillRoots()).toEqual([])
      const item = (await items(service)).find(found => found.id === 'codex:docs')!
      expect(item).toMatchObject({ installed: true, detached: { reason: 'uninstalled', harness: 'codex', folderGone: false } })
      expect(item.parts.map(part => [part.state, part.reasons[0]?.code])).toEqual([['inactive', 'not-followed']])
      await expect(service.forge.setPartEnabled('codex:docs', 'codex:docs:skill:read', true)).resolves.toBe(false)

      await service.forge.keep('codex:docs')
      expect(service.list()[0]?.detached).toBeUndefined()
      expect(service.list()[0]?.harnessInstall).toBeUndefined()
      expect(typeof service.list()[0]?.keptAt).toBe('string')
      expect(service.listSkillRoots()).toEqual([join(root, 'skills')])
      // Installed in Codex again: the kept copy is the person's own and does not move.
      const again = pluginAt(join(codex, 'plugins', 'cache', 'market', 'docs', '3.0.0'), 'codex', 'docs', '3.0.0', ['read'])
      codexInstalls({ 'docs@market': true })
      await service.forge.follow()
      expect(service.list()[0]?.root).toBe(root)
      expect((await service.workbench.discover()).plugins.find(found => found.root === again)?.installed).toBe(false)
    } finally {
      await service.dispose()
    }
  })

  it('learns the harness install of a ledger written before installs carried one, without the person doing anything', async () => {
    const root = pluginAt(join(codex, 'plugins', 'cache', 'market', 'docs', '1.0.0'), 'codex', 'docs', '1.0.0', ['read'])
    codexInstalls({ 'docs@market': true })
    const first = harness()
    await first.start()
    await first.install(root, 'codex')
    await first.dispose()
    // As 0.4.0 wrote it: no harness install.
    const path = join(home, 'state.json')
    const ledger = JSON.parse(readFileSync(path, 'utf8')) as { plugins: Array<Record<string, unknown>> }
    for (const record of ledger.plugins) delete record['harnessInstall']
    writeFileSync(path, JSON.stringify(ledger))

    const second = harness()
    try {
      await second.start()
      expect(second.list()[0]?.harnessInstall).toEqual({ harness: 'codex', key: 'docs@market' })
      expect(readState(path).plugins[0]?.harnessInstall).toEqual({ harness: 'codex', key: 'docs@market' })
      expect(second.listSkillRoots()).toEqual([join(root, 'skills')])
    } finally {
      await second.dispose()
    }
  })

  it('stops what 0.4.0 migrated from a harness\'s folders that the harness never installed, or read as another harness\'s plugin', async () => {
    // A Claude Code marketplace offer, and a Codex install 0.4.0 read as a Claude Code plugin (it has both manifests).
    const offer = pluginAt(join(claude, 'marketplaces', 'market', 'plugins', 'offer'), 'claude-code', 'offer', '1.0.0', ['o'])
    const both = pluginAt(join(codex, 'plugins', 'cache', 'market', 'dual', '1.0.0'), 'codex', 'dual', '1.0.0', ['d'])
    pluginAt(both, 'claude-code', 'dual', '1.0.0', [])
    claudeInstalls({})
    codexInstalls({ 'dual@market': true })
    const record = (id: string, source: string, name: string, root: string) => ({ id, source, name, root, version: '1.0.0', installedAt: '2026-11-01T00:00:00.000Z', components: [{ kind: 'skill', name }] })
    write(join(home, 'state.json'), JSON.stringify({ schemaVersion: 2, plugins: [record('claude-code:offer', 'claude-code', 'offer', offer), record('claude-code:dual', 'claude-code', 'dual', both)] }))
    const service = harness()
    try {
      await service.start()
      const byId = new Map(service.list().map(found => [found.id, found]))
      expect(byId.get('claude-code:offer')).toMatchObject({ harnessInstall: { harness: 'claude-code', key: 'offer@market', inferred: true }, detached: { reason: 'never-installed' } })
      expect(byId.get('claude-code:dual')).toMatchObject({ harnessInstall: { harness: 'codex', key: 'dual@market' }, detached: { reason: 'misread' } })
      expect(service.listSkillRoots()).toEqual([])
      // The Codex install the misread record stood for is offered to migrate as what it is.
      const found = (await service.workbench.discover()).plugins.find(plugin => plugin.root === both && plugin.source === 'codex')
      expect(found?.installed).toBe(false)
      expect((await items(service)).find(item => item.id === 'codex:dual')?.installed).toBe(false)
    } finally {
      await service.dispose()
    }
  })

  it('shows a plugin whose folder is gone as a fault, never ready with no parts', async () => {
    const root = pluginAt(join(home, 'mine', 'tool'), 'claude-code', 'tool', '1.0.0', ['one', 'two'])
    const service = harness()
    try {
      await service.start()
      await service.install(root, 'claude-code')
      rmSync(root, { recursive: true })
      const item = (await items(service)).find(found => found.id === 'claude-code:tool')!
      expect(item.parts.map(part => [part.name, part.state, part.reasons[0]?.code])).toEqual([['one', 'failed', 'folder-gone'], ['two', 'failed', 'folder-gone']])
    } finally {
      await service.dispose()
    }
  })

  it('changes nothing while a harness record cannot be read in full, says so, and follows again once it can', async () => {
    const hud = pluginAt(join(claude, 'cache', 'market', 'hud', '1.0.0'), 'claude-code', 'hud', '1.0.0', ['alpha'])
    const docs = pluginAt(join(codex, 'plugins', 'cache', 'market', 'docs', '1.0.0'), 'codex', 'docs', '1.0.0', ['read'])
    claudeInstalls({ 'hud@market': hud })
    codexInstalls({ 'docs@market': true })
    const first = harness()
    await first.start()
    await first.install(hud, 'claude-code')
    await first.install(docs, 'codex')
    const mounted = [join(docs, 'skills'), join(hud, 'skills')].sort()
    expect(first.listSkillRoots().slice().sort()).toEqual(mounted)

    // Caught mid-write: the index cut off, config.toml malformed.
    write(join(claude, 'installed_plugins.json'), '{')
    write(join(codex, 'config.toml'), '[plugins."docs@market"')
    await first.forge.follow()
    expect(first.list().map(record => record.detached)).toEqual([undefined, undefined])
    expect(first.listSkillRoots().slice().sort()).toEqual(mounted)
    const said = first.forge.faults().map(fault => fault.message)
    expect(said.some(message => message.includes("couldn't read Claude Code's plugin list") && message.includes('nothing changed'))).toBe(true)
    expect(said.some(message => message.includes("couldn't read Codex's plugin list") && message.includes('nothing changed'))).toBe(true)
    await first.dispose()

    // At the next load as well.
    const second = harness()
    try {
      await second.start()
      expect(second.list().map(record => record.detached)).toEqual([undefined, undefined])
      expect(second.listSkillRoots().slice().sort()).toEqual(mounted)
      // Readable again, and really uninstalled: now they stop.
      claudeInstalls({})
      codexInstalls({})
      await second.forge.follow()
      expect(second.list().map(record => record.detached?.reason)).toEqual(['uninstalled', 'uninstalled'])
    } finally {
      await second.dispose()
    }
  })

  it('keeps following a plugin its harness still lists while the listed files are missing', async () => {
    const docs = pluginAt(join(codex, 'plugins', 'cache', 'market', 'docs', '1.0.0'), 'codex', 'docs', '1.0.0', ['read'])
    codexInstalls({ 'docs@market': true })
    const service = harness()
    try {
      await service.start()
      await service.install(docs, 'codex')
      rmSync(join(codex, 'plugins', 'cache', 'market', 'docs'), { recursive: true })
      await service.forge.follow()
      expect(service.list()[0]?.detached).toBeUndefined()
      const item = (await items(service)).find(found => found.id === 'codex:docs')!
      expect(item.parts.map(part => [part.state, part.reasons[0]?.code])).toEqual([['failed', 'folder-gone']])
    } finally {
      await service.dispose()
    }
  })

  it('says how many records are still being applied while it restores them', async () => {
    const roots = ['a', 'b'].map(name => pluginAt(join(home, 'mine', name), 'claude-code', name, '1.0.0', [name]))
    const first = harness()
    await first.start()
    for (const root of roots) await first.install(root, 'claude-code')
    await first.dispose()
    const second = harness()
    try {
      const seen: unknown[] = []
      const apply = second.forge.ledger.applyNow.bind(second.forge.ledger)
      vi.spyOn(second.forge.ledger, 'applyNow').mockImplementation(async (...args) => {
        seen.push(second.forge.applying())
        return apply(...args)
      })
      await second.start()
      expect(seen).toEqual([{ done: 0, total: 2 }, { done: 1, total: 2 }])
      expect(second.forge.applying()).toBeUndefined()
    } finally {
      await second.dispose()
    }
  })
})
