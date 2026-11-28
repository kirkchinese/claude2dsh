import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { treeDigest } from '../src/forge/remote/archive.js'
import { SYSTEM_DEPS, type FetchDeps } from '../src/forge/remote/fetch.js'
import { HarnessForge } from '../src/forge/service.js'

const temporary: string[] = []
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-forge-net-'))
  temporary.push(root)
  return root
}
const forges: HarnessForge[] = []
afterEach(async () => {
  for (const forge of forges.splice(0)) await forge.dispose()
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=T', ...args], { cwd, encoding: 'utf8' }).trim()
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }
}

function repo(files: Record<string, string>): { dir: string; url: string; commit: (more: Record<string, string>) => void; head: () => string } {
  const dir = tempRoot()
  git(dir, 'init', '-q', '-b', 'main')
  write(dir, files)
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'initial')
  return {
    dir,
    url: pathToFileURL(dir).href,
    commit: (more) => {
      write(dir, more)
      git(dir, 'add', '.')
      git(dir, 'commit', '-qm', 'more')
    },
    head: () => git(dir, 'rev-parse', 'HEAD'),
  }
}

/**
 * HTTPS git hosts on a public address, played by local repositories: git is
 * handed the repository for each `https://git.test/…` URL a marketplace names,
 * and the file transport that serves it, everything else as Harness Forge asked.
 */
function httpsAs(map: Record<string, string>, fetch: typeof globalThis.fetch = SYSTEM_DEPS.fetch): FetchDeps {
  return {
    ...SYSTEM_DEPS,
    fetch,
    lookup: async () => ['93.184.216.34'],
    git: (command, args, options) => SYSTEM_DEPS.git(command, args.map(arg => map[arg] ?? (arg === 'protocol.file.allow=never' ? 'protocol.file.allow=always' : arg)), options),
  }
}

const skill = (name: string, body: string): string => `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}\n`

function forgeIn(root: string, deps?: FetchDeps): HarnessForge {
  const forge = new HarnessForge({ get: () => undefined } as never, join(root, 'state.json'), join(root, 'data'), deps !== undefined ? { remote: { deps } } : {})
  forges.push(forge)
  return forge
}

function staged(root: string): string[] {
  const dir = join(root, 'data', 'remote', 'staging')
  return existsSync(dir) ? readdirSync(dir) : []
}

describe('plugins from the network', { timeout: 120_000 }, () => {
  it('opens a git marketplace, confirms, installs, updates and removes an entry', async () => {
    const external = repo({ '.claude-plugin/plugin.json': '{"name":"ext"}', 'hooks/hooks.json': JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'true' }] }] } }), 'skills/ext/SKILL.md': skill('ext', 'EXT') })
    const market = repo({
      '.claude-plugin/marketplace.json': JSON.stringify({
        name: 'net-market',
        owner: { name: 'Test' },
        plugins: [
          { name: 'inside', source: './plugins/inside', description: 'In the marketplace' },
          { name: 'ext', source: { source: 'url', url: 'https://git.test/ext.git' } },
          { name: 'bundle', source: './', strict: false, skills: ['./shared/a'] },
          { name: 'tool', source: { source: 'command', command: 'echo /tmp' } },
          { name: 'local-file', source: { source: 'url', url: external.url } },
        ],
      }),
      'plugins/inside/.claude-plugin/plugin.json': '{"name":"inside","version":"1.0.0"}',
      'plugins/inside/skills/one/SKILL.md': skill('one', 'ONE-1'),
      'plugins/inside/skills/two/SKILL.md': skill('two', 'TWO-1'),
      'shared/a/SKILL.md': skill('a', 'A'),
    })
    const root = tempRoot()
    const forge = forgeIn(root, httpsAs({ 'https://git.test/ext.git': external.url }))
    await forge.start()

    const view = await forge.remote.open(market.url)
    expect(view).toMatchObject({ kind: 'marketplace', name: 'net-market', harness: 'claude-code' })
    expect(view.entries.map(entry => entry.name)).toEqual(['inside', 'ext', 'bundle', 'tool', 'local-file'])
    expect(view.entries.find(entry => entry.name === 'tool')?.unsupported).toMatch(/runs a command/u)
    // A marketplace may not point Harness Forge at a folder on this computer.
    expect(view.entries.find(entry => entry.name === 'local-file')?.unsupported).toMatch(/only https/u)
    await expect(forge.remote.prepare(market.url, 'local-file')).rejects.toThrow(/only https/u)
    expect((await forge.remote.sources()).added.map(source => source.input)).toEqual([market.url])

    const plan = await forge.remote.prepare(market.url, 'inside')
    expect(plan).toMatchObject({ name: 'inside', version: '1.0.0', harness: 'claude-code', runsCode: [], alreadyInstalled: false })
    expect(plan.parts.map(part => `${part.kind}:${part.name}`).sort()).toEqual(['skill:one', 'skill:two'])
    expect(forge.list()).toHaveLength(0)
    await forge.remote.install(plan.token)
    const [record] = forge.list()
    expect(record?.name).toBe('inside')
    expect(record?.root.startsWith(join(root, 'data', 'remote', 'plugins'))).toBe(true)
    expect(readFileSync(join(record!.root, 'skills/one/SKILL.md'), 'utf8')).toContain('ONE-1')
    expect((await forge.remote.open(market.url)).entries.find(entry => entry.name === 'inside')?.installed).toBe(record?.id)
    expect(staged(root)).toEqual([])

    // The person switches a part off; an update keeps it off.
    const two = forge.scan(record!.root, 'claude-code').components.find(component => component.name === 'two')!
    await forge.setPartEnabled(record!.id, two.id, false)
    expect(await forge.remote.checkUpdates()).toEqual([expect.objectContaining({ pluginId: record!.id, update: false })])
    expect((await forge.remote.checkUpdates())[0]?.token).toBeUndefined()
    market.commit({ 'plugins/inside/skills/one/SKILL.md': skill('one', 'ONE-2'), 'plugins/inside/skills/three/SKILL.md': skill('three', 'THREE') })
    const checked = market.head()
    const [status] = await forge.remote.checkUpdates()
    expect(status).toMatchObject({ update: true, latest: checked.slice(0, 12) })
    // The marketplace moves on after the check: the update is still the revision that was checked.
    market.commit({ 'plugins/inside/skills/one/SKILL.md': skill('one', 'ONE-3') })
    const oldRoot = record!.root
    const updatePlan = await forge.remote.prepareUpdate(record!.id, status!.token!)
    expect(updatePlan.update).toEqual({ from: status!.current, to: checked.slice(0, 12), removed: [] })
    expect(updatePlan.revision).toBe(checked.slice(0, 12))
    expect(Object.fromEntries(updatePlan.parts.map(part => [part.name, part.change]))).toEqual({ one: 'changed', two: undefined, three: 'new' })
    // Nothing changed before the confirmation, and a check's token is good for one preparation.
    expect(forge.list()[0]?.root).toBe(oldRoot)
    await expect(forge.remote.prepareUpdate(record!.id, status!.token!)).rejects.toThrow(/expired/u)
    expect(await forge.remote.install(updatePlan.token)).toMatchObject({ pluginId: record!.id, updated: true })
    const [updated] = forge.list()
    expect(updated?.root).not.toBe(oldRoot)
    expect(existsSync(oldRoot)).toBe(false)
    expect(readFileSync(join(updated!.root, 'skills/one/SKILL.md'), 'utf8')).toContain('ONE-2')
    expect(updated?.disabled).toEqual([two.id])
    expect((await forge.remote.checkUpdates())[0]).toMatchObject({ update: true })

    // A plugin in a repository of its own, over HTTPS: its hooks run code, which the confirmation says.
    const extPlan = await forge.remote.prepare(market.url, 'ext')
    expect(extPlan.runsCode).toEqual(['hooks'])
    await forge.remote.install(extPlan.token)

    // An entry that is its own manifest: its skills come from the marketplace entry.
    const bundle = await forge.remote.prepare(market.url, 'bundle')
    expect(bundle.parts.map(part => part.name)).toContain('a')
    forge.remote.cancel(bundle.token)
    await expect(forge.remote.prepare(market.url, 'tool')).rejects.toThrow(/does not run marketplace commands/u)

    // Removal deletes what was fetched; a cancelled confirmation leaves nothing behind.
    const updatedRoot = updated!.root
    expect(await forge.uninstall(updated!.id)).toBe(true)
    expect(existsSync(updatedRoot)).toBe(false)
    expect(forge.remote.installs().map(install => install.name)).toEqual(['ext'])
    expect(staged(root)).toEqual([])
  })

  it('installs exactly what the confirmation showed, and never replaces a copy an install uses', async () => {
    const market = repo({
      '.claude-plugin/marketplace.json': JSON.stringify({ name: 'm', plugins: [{ name: 'p', source: './p' }] }),
      'p/.claude-plugin/plugin.json': '{"name":"p","version":"1.0.0"}',
      'p/skills/s/SKILL.md': skill('s', 'SHOWN'),
    })
    const root = tempRoot()
    const forge = forgeIn(root)
    await forge.start()
    // Files that change between the confirmation and the install are not installed.
    const tampered = await forge.remote.prepare(market.url, 'p')
    const [stage] = staged(root)
    writeFileSync(join(root, 'data', 'remote', 'staging', stage!, 'p', 'skills', 's', 'SKILL.md'), skill('s', 'SWAPPED'))
    await expect(forge.remote.install(tampered.token)).rejects.toThrow(/changed after they were shown/u)
    expect(forge.list()).toHaveLength(0)
    expect(staged(root)).toEqual([])

    // The same revision prepared twice: two staging copies; installing one and cancelling the other keeps the install whole.
    const first = await forge.remote.prepare(market.url, 'p')
    const second = await forge.remote.prepare(market.url, 'p')
    expect(staged(root)).toHaveLength(2)
    await forge.remote.install(first.token)
    const installed = forge.list()[0]!.root
    expect(forge.remote.cancel(second.token)).toBe(true)
    const third = await forge.remote.prepare(market.url, 'p')
    expect(third.alreadyInstalled).toBe(true)
    await forge.remote.install(third.token)
    expect(forge.list()[0]!.root).toBe(installed)
    expect(readFileSync(join(installed, 'skills/s/SKILL.md'), 'utf8')).toContain('SHOWN')
    expect(staged(root)).toEqual([])
  })

  it('refuses an update prepared against a copy that has changed since, so plans cannot be applied out of order', async () => {
    const market = repo({
      '.claude-plugin/marketplace.json': JSON.stringify({ name: 'm', plugins: [{ name: 'p', source: './p' }] }),
      'p/.claude-plugin/plugin.json': '{"name":"p"}',
      'p/skills/s/SKILL.md': skill('s', 'V1'),
    })
    const forge = forgeIn(tempRoot())
    await forge.start()
    await forge.remote.install((await forge.remote.prepare(market.url, 'p')).token)
    const id = forge.list()[0]!.id
    market.commit({ 'p/skills/s/SKILL.md': skill('s', 'V2') })
    const older = await forge.remote.prepareUpdate(id, (await forge.remote.checkUpdates())[0]!.token!)
    market.commit({ 'p/skills/s/SKILL.md': skill('s', 'V3') })
    const newer = await forge.remote.prepareUpdate(id, (await forge.remote.checkUpdates())[0]!.token!)
    await forge.remote.install(newer.token)
    await expect(forge.remote.install(older.token)).rejects.toThrow(/changed since this was prepared/u)
    expect(readFileSync(join(forge.list()[0]!.root, 'skills/s/SKILL.md'), 'utf8')).toContain('V3')
  })

  it('binds an update check to the copy it compared, so an older check cannot be prepared over a newer install', async () => {
    const market = repo({
      '.claude-plugin/marketplace.json': JSON.stringify({ name: 'm', plugins: [{ name: 'p', source: './p' }] }),
      'p/.claude-plugin/plugin.json': '{"name":"p"}',
      'p/skills/s/SKILL.md': skill('s', 'V1'),
    })
    const forge = forgeIn(tempRoot())
    await forge.start()
    await forge.remote.install((await forge.remote.prepare(market.url, 'p')).token)
    const id = forge.list()[0]!.id
    market.commit({ 'p/skills/s/SKILL.md': skill('s', 'V2') })
    const older = (await forge.remote.checkUpdates())[0]!.token!
    market.commit({ 'p/skills/s/SKILL.md': skill('s', 'V3') })
    await forge.remote.install((await forge.remote.prepareUpdate(id, (await forge.remote.checkUpdates())[0]!.token!)).token)
    // V2 was found against V1; V3 is installed now, which that check never compared.
    await expect(forge.remote.prepareUpdate(id, older)).rejects.toThrow(/changed since the check/u)
    expect(readFileSync(join(forge.list()[0]!.root, 'skills/s/SKILL.md'), 'utf8')).toContain('V3')
    expect(staged(forge.remote.root.replace(/[/\\]data[/\\]remote$/u, ''))).toEqual([])
  })

  it('keys what is installed by the marketplace\'s source, not by the names it gives itself', async () => {
    const files = (body: string): Record<string, string> => ({
      '.claude-plugin/marketplace.json': JSON.stringify({ name: 'claude-plugins-official', plugins: [{ name: 'p', source: './p' }] }),
      'p/.claude-plugin/plugin.json': '{"name":"p"}',
      'p/skills/s/SKILL.md': skill('s', body),
    })
    const real = repo(files('REAL'))
    const impostor = repo(files('IMPOSTOR'))
    const forge = forgeIn(tempRoot())
    await forge.start()
    await forge.remote.install((await forge.remote.prepare(real.url, 'p')).token)
    expect((await forge.remote.open(real.url)).entries[0]?.installed).toBeDefined()
    expect((await forge.remote.open(impostor.url)).entries[0]?.installed).toBeUndefined()
  })

  it('installs a single plugin repository pasted directly and restores it after a restart', async () => {
    const plugin = repo({ 'plugin.json': '{"name":"solo"}', '.codex-plugin/plugin.json': JSON.stringify({ name: 'solo', skills: './skills/' }), 'skills/s/SKILL.md': skill('s', 'S') })
    const root = tempRoot()
    const forge = forgeIn(root)
    await forge.start()
    const view = await forge.remote.open(plugin.url)
    expect(view).toMatchObject({ kind: 'plugin', harness: 'codex' })
    expect((await forge.remote.sources()).added).toEqual([])
    const plan = await forge.remote.prepare(plugin.url)
    expect(plan).toMatchObject({ name: 'solo', harness: 'codex' })
    await forge.remote.install(plan.token)
    await forge.dispose()
    forges.splice(0)

    const again = forgeIn(root)
    await again.start()
    expect(again.list().map(record => record.name)).toEqual(['solo'])
    expect(again.remote.installs()).toHaveLength(1)
    expect((await again.remote.checkUpdates())[0]).toMatchObject({ update: false })
  })

  it('names the local marketplace a plugin from this computer came from', async () => {
    const market = tempRoot()
    write(market, {
      '.claude-plugin/marketplace.json': JSON.stringify({ name: 'home-market', plugins: [{ name: 'near', source: './near' }] }),
      'near/.claude-plugin/plugin.json': '{"name":"near"}',
      'near/skills/n/SKILL.md': skill('n', 'N'),
    })
    const plugin = repo({ '.claude-plugin/plugin.json': '{"name":"far"}', 'skills/f/SKILL.md': skill('f', 'F') })
    const forge = forgeIn(tempRoot())
    await forge.start()
    await forge.remote.install((await forge.remote.prepare(market, 'near')).token)
    await forge.remote.install((await forge.remote.prepare(plugin.url)).token)
    const installs = (await forge.remote.sources()).installs
    expect(installs.find(install => install.name === 'near')).toMatchObject({ localMarketplace: 'home-market' })
    expect(installs.find(install => install.name === 'far')?.localMarketplace).toBeUndefined()
  })

  it('installs a copy of a plugin in a marketplace on this computer, taken when it was shown', async () => {
    const market = tempRoot()
    const outside = tempRoot()
    write(outside, { '.claude-plugin/plugin.json': '{"name":"elsewhere"}', 'skills/e/SKILL.md': skill('e', 'OUTSIDE'), 'secret.txt': 'SECRET' })
    write(market, {
      '.claude-plugin/marketplace.json': JSON.stringify({
        name: 'home-market',
        plugins: [
          { name: 'near', source: './near', skills: ['./extra'] },
          { name: 'jump', source: './jump' },
          { name: 'through', source: './jump/skills' },
          { name: 'file-url', source: { source: 'url', url: pathToFileURL(outside).href } },
        ],
      }),
      'near/.claude-plugin/plugin.json': '{"name":"near"}',
      'near/skills/n/SKILL.md': skill('n', 'SHOWN'),
      'near/extra/SKILL.md': skill('extra', 'EXTRA'),
    })
    symlinkSync(join(outside, 'secret.txt'), join(market, 'near', 'leak.txt'))
    symlinkSync(outside, join(market, 'jump'), 'dir')
    const before = treeDigest(market)
    const root = tempRoot()
    const forge = forgeIn(root)
    await forge.start()

    const plan = await forge.remote.prepare(market, 'near')
    expect(plan.parts.map(part => part.name).sort()).toEqual(['extra', 'n'])
    expect(plan.warnings.join('\n')).toMatch(/left out: leak\.txt/u)
    // The harness that owns the marketplace refreshes it between the confirmation and the install.
    write(market, { 'near/skills/n/SKILL.md': skill('n', 'REFRESHED'), 'near/skills/late/SKILL.md': skill('late', 'LATE') })
    await forge.remote.install(plan.token)
    const [record] = forge.list()
    expect(record?.root.startsWith(join(root, 'data', 'remote', 'plugins'))).toBe(true)
    expect(readFileSync(join(record!.root, 'skills/n/SKILL.md'), 'utf8')).toContain('SHOWN')
    expect(existsSync(join(record!.root, 'skills/late'))).toBe(false)
    expect(existsSync(join(record!.root, 'leak.txt'))).toBe(false)
    expect((await forge.remote.sources()).installs[0]).toMatchObject({ localMarketplace: 'home-market', revision: 'local' })
    // The marketplace's folder is left as the harness keeps it: the entry's manifest is combined in the copy only.
    write(market, { 'near/skills/n/SKILL.md': skill('n', 'SHOWN') })
    rmSync(join(market, 'near/skills/late'), { recursive: true })
    expect(treeDigest(market)).toBe(before)

    // A path that is, or passes through, a link out of the marketplace is not followed.
    await expect(forge.remote.prepare(market, 'jump')).rejects.toThrow(/link/u)
    await expect(forge.remote.prepare(market, 'through')).rejects.toThrow(/link/u)
    // An entry naming a source of its own takes the network policy of any marketplace entry.
    await expect(forge.remote.prepare(market, 'file-url')).rejects.toThrow(/only https/u)
    expect(forge.list()).toHaveLength(1)
    expect(staged(root)).toEqual([])
  })

  it('installs a copy of a plugin folder on this computer, taken when it was shown', async () => {
    const folder = tempRoot()
    write(folder, { '.claude-plugin/plugin.json': '{"name":"here"}', 'skills/h/SKILL.md': skill('h', 'SHOWN') })
    const root = tempRoot()
    const forge = forgeIn(root)
    await forge.start()
    const plan = await forge.remote.prepare(folder)
    write(folder, { 'skills/h/SKILL.md': skill('h', 'CHANGED') })
    await forge.remote.install(plan.token)
    const [record] = forge.list()
    expect(record?.root.startsWith(join(root, 'data', 'remote', 'plugins'))).toBe(true)
    expect(readFileSync(join(record!.root, 'skills/h/SKILL.md'), 'utf8')).toContain('SHOWN')
  })

  it('reads a marketplace.json served over HTTP; its relative entries cannot be installed', async () => {
    const external = repo({ '.claude-plugin/plugin.json': '{"name":"hosted-ext"}', 'skills/h/SKILL.md': skill('h', 'H') })
    const manifest = { name: 'hosted', plugins: [{ name: 'rel', source: './x' }, { name: 'ext', source: { source: 'url', url: 'https://git.test/hosted-ext.git' } }] }
    const fetch = (async () => new Response(JSON.stringify(manifest))) as typeof globalThis.fetch
    const forge = forgeIn(tempRoot(), httpsAs({ 'https://git.test/hosted-ext.git': external.url }, fetch))
    await forge.start()
    const view = await forge.remote.open('https://example.com/marketplace.json')
    expect(view.entries.find(entry => entry.name === 'rel')?.unsupported).toBeDefined()
    const plan = await forge.remote.prepare('https://example.com/marketplace.json', 'ext')
    expect(plan.name).toBe('hosted-ext')
  })
})
