import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { HarnessForge } from '../src/forge/service.js'
import { qualifyDuplicateNames, type OverviewItem } from '../src/workbench/overview.js'

const temporary: string[] = []
const forges: HarnessForge[] = []
afterEach(async () => {
  for (const forge of forges.splice(0)) await forge.dispose()
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-forge-naming-'))
  temporary.push(root)
  return root
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }
}

const SKILL = '---\nname: design\ndescription: Design\n---\n\nDesign.\n'
const PLUGIN = { '.claude-plugin/plugin.json': '{"name":"frontend-design"}', 'skills/design/SKILL.md': SKILL }

function repo(files: Record<string, string> = PLUGIN): string {
  const dir = tempRoot()
  const git = (...args: string[]): void => { execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=T', ...args], { cwd: dir }) }
  git('init', '-q', '-b', 'main')
  write(dir, files)
  git('add', '.')
  git('commit', '-qm', 'initial')
  return pathToFileURL(dir).href
}

describe('a plugin installed twice from different places', () => {
  it('is shown under its own name by the confirmation, the installed list and the install report', async () => {
    const root = tempRoot()
    const forge = new HarnessForge({ get: () => undefined } as never, join(root, 'state.json'), join(root, 'data'))
    forges.push(forge)
    await forge.start()
    // The same name is installed already, from a copy on disk (a migrated one).
    const migrated = join(root, 'migrated')
    write(migrated, PLUGIN)
    await forge.install(migrated, 'claude-code')

    const plan = await forge.remote.prepare(repo())
    expect(plan.name).toBe('frontend-design')
    await forge.remote.install(plan.token)

    expect(forge.remote.installs().map(install => install.name)).toEqual(['frontend-design'])
    // Both copies read as the plugin's own name; the suffix stays in the id the ledger keeps them apart by.
    const records = forge.list()
    expect(records).toHaveLength(2)
    expect(records.map(record => record.displayName ?? record.name)).toEqual(['frontend-design', 'frontend-design'])
    expect(records.filter(record => record.displayName !== undefined)).toHaveLength(1)
  })
})

describe('plugins that genuinely share a name', () => {
  const item = (id: string, source: string, root: string, extra: Partial<OverviewItem> = {}): OverviewItem => ({
    id, name: 'frontend-design', source, root, own: false, installed: true, parts: [], counts: { works: 0, partial: 0, unsupported: 0, 'needs-port': 0, failed: 0, off: 0 }, checked: 0, ...extra,
  }) as OverviewItem

  it('are told apart by where they came from, in one way', () => {
    const named = qualifyDuplicateNames([
      item('a', 'claude-code', '/h/.claude/plugins/frontend-design'),
      item('b', 'claude-code', '/d/remote/plugins/ab/frontend-design', { fetched: true }),
      item('c', 'claude-code', '/h/other/lonely', { name: 'lonely' }),
    ])
    expect(named.map(entry => entry.name)).toEqual(['frontend-design (claude-code)', 'frontend-design (network)', 'lonely'])
  })
})

describe('the install confirmation', () => {
  it('gives the reasons a part has gaps as codes the browser words, as the overview does', async () => {
    const root = tempRoot()
    const forge = new HarnessForge({ get: () => undefined } as never, join(root, 'state.json'), join(root, 'data'))
    forges.push(forge)
    await forge.start()
    const plan = await forge.remote.prepare(repo({
      '.claude-plugin/plugin.json': '{"name":"idle"}',
      'hooks/hooks.json': JSON.stringify({ hooks: { TeammateIdle: [{ hooks: [{ type: 'command', command: 'echo idle' }] }] } }),
    }))
    const hooks = plan.parts.find(part => part.kind === 'hooks')
    expect(hooks?.reasons).toEqual([{ code: 'events-never-raised', detail: 'TeammateIdle' }])
  })
})

describe('the Remove dialog of a plugin from Get plugins', () => {
  it('says its downloaded files are deleted, in both languages', async () => {
    const { readFileSync } = await import('node:fs')
    for (const language of ['en', 'zh']) {
      const words = JSON.parse(readFileSync(join(process.cwd(), 'src', 'client', 'locale', `${language}.json`), 'utf8')) as Record<string, string>
      expect(words['removeConfirmFetched']).toMatch(language === 'en' ? /deleted/u : /删除/u)
      expect(words['removeConfirmFetched']).not.toMatch(language === 'en' ? /stay/u : /保留/u)
    }
  })
})
