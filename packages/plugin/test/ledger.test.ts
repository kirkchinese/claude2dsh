import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { readState, retryFile } from '../src/forge/state.js'

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
})