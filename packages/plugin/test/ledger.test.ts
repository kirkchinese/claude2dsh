import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadState, readState, retryFile } from '../src/forge/state.js'
import { TestHarness } from './harness.js'

/** Temporary folders made by these tests, removed once all of them have run. */
const temporary: string[] = []
afterAll(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporary.push(dir)
  return dir
}

describe('the ledger', () => {
  it('is empty when missing, and a ledger that is not JSON is kept aside before a new one starts', () => {
    const dir = tempDir('hf-ledger-')
    expect(readState(join(dir, 'state.json')).plugins).toEqual([])
    writeFileSync(join(dir, 'state.json'), '{ "schemaVersion": 2, "plugins": [')
    expect(readState(join(dir, 'state.json')).plugins).toEqual([])
    expect(readdirSync(dir).some(name => name.startsWith('state.json.corrupt-'))).toBe(true)
  })

  it('refuses to answer "empty" when it cannot be read', () => {
    const dir = tempDir('hf-ledger-')
    // A directory where the ledger should be: EISDIR, not transient, not missing.
    const path = join(dir, 'state.json')
    mkdirSync(path)
    expect(() => readState(path)).toThrow()
  })

  it('outlives a moment without file handles, waiting without blocking', async () => {
    let calls = 0
    let ticked = false
    setTimeout(() => { ticked = true }, 0)
    const value = await retryFile(() => {
      calls++
      if (calls < 3) throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' })
      return 'written'
    })
    expect(value).toBe('written')
    expect(calls).toBe(3)
    // Other callbacks ran meanwhile: the handles DSH holds are released by its own.
    expect(ticked).toBe(true)
    await expect(retryFile(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) })).rejects.toThrow('ENOENT')
  })

  /** A plugin folder with one skill, to restore. */
  function plugin(dir: string, name: string): string {
    const root = join(dir, name)
    mkdirSync(join(root, '.claude-plugin'), { recursive: true })
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version: '0.1.0', license: 'MIT' }))
    mkdirSync(join(root, 'skills', name), { recursive: true })
    writeFileSync(join(root, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n\n${name}.\n`)
    return root
  }
  const copies = (dir: string): string[] => readdirSync(dir).filter(name => name.startsWith('state.json.unreadable-'))

  it('repairs a record missing its install time, keeps the valid peers of one it cannot read, and keeps the file first', async () => {
    const dir = tempDir('hf-ledger-')
    const path = join(dir, 'state.json')
    const original = JSON.stringify({
      schemaVersion: 2,
      plugins: [
        { id: 'claude-code:kept', source: 'claude-code', name: 'kept', root: plugin(dir, 'kept'), installedAt: '2026-01-01T00:00:00.000Z', components: [] },
        { id: 'claude-code:no-time', source: 'claude-code', name: 'no-time', root: plugin(dir, 'no-time'), components: [{ kind: 'skill', name: 'no-time' }] },
        { id: 'claude-code:no-root', source: 'claude-code', name: 'no-root', installedAt: '2026-01-01T00:00:00.000Z', components: [] },
      ],
    })
    writeFileSync(path, original)
    const loaded = loadState(path)
    expect(loaded.state.plugins.map(record => record.name)).toEqual(['kept', 'no-time'])
    expect(typeof loaded.state.plugins[1]?.installedAt).toBe('string')
    expect(loaded.repaired).toEqual(['claude-code:no-time'])
    expect(loaded.rejected).toEqual(['record 2: it has no root folder'])
    expect(readFileSync(loaded.backup!, 'utf8')).toBe(original)

    // Restored: the rejected record is a visible fault naming the copy; the next write keeps the copy as it was.
    const service = new TestHarness({ get: () => undefined } as never, path, join(dir, 'data'))
    try {
      await service.start()
      expect(service.list().map(record => record.name).sort()).toEqual(['kept', 'no-time'])
      const fault = service.forge.faults().find(item => item.row === 'ledger')
      expect(fault?.message).toContain('record 2: it has no root folder')
      const backups = copies(dir)
      expect(backups.length).toBeGreaterThanOrEqual(2)
      for (const copy of backups) expect(readFileSync(join(dir, copy), 'utf8')).toBe(original)
      expect(backups.some(copy => fault?.message.includes(copy) === true)).toBe(true)
      expect(readState(path).plugins.map(record => record.name).sort()).toEqual(['kept', 'no-time'])
    } finally {
      await service.dispose()
    }
  })

  it('keeps a copy before starting over from a ledger whose shape it cannot read', () => {
    for (const [why, text] of [
      ['not an object', '[1, 2]'],
      ['plugins not a list', JSON.stringify({ schemaVersion: 2, plugins: { a: 1 } })],
      ['unknown schema', JSON.stringify({ schemaVersion: 'two', plugins: [] })],
    ] as const) {
      const dir = tempDir('hf-ledger-')
      const path = join(dir, 'state.json')
      writeFileSync(path, text)
      const loaded = loadState(path)
      expect(loaded.state.plugins, why).toEqual([])
      expect(loaded.rejected, why).toHaveLength(1)
      expect(readFileSync(loaded.backup!, 'utf8'), why).toBe(text)
      // A second read keeps another copy; none is overwritten.
      const again = loadState(path)
      expect(again.backup).not.toBe(loaded.backup)
      expect(copies(dir), why).toHaveLength(2)
    }
  })

  it('never writes over a ledger of a newer Harness Forge: read-only, with a fault saying to upgrade', async () => {
    const dir = tempDir('hf-ledger-')
    const path = join(dir, 'state.json')
    const newer = JSON.stringify({ schemaVersion: 3, plugins: [{ id: 'claude-code:future', anything: true }] })
    writeFileSync(path, newer)
    expect(loadState(path).readOnly).toMatch(/newer Harness Forge.*upgrade Harness Forge/u)
    const service = new TestHarness({ get: () => undefined } as never, path, join(dir, 'data'))
    try {
      await service.start()
      expect(service.list()).toEqual([])
      expect(service.forge.faults().find(item => item.row === 'ledger')?.message).toMatch(/upgrade Harness Forge/u)
      await expect(service.install(plugin(dir, 'fresh'), 'claude-code')).rejects.toThrow(/newer Harness Forge/u)
      expect(readFileSync(path, 'utf8')).toBe(newer)
      expect(copies(dir)).toEqual([])
    } finally {
      await service.dispose()
    }
  })
})
