import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** Called with each path the loader resolves; a test swaps a file there right after its check. */
let onRealpath: (path: string) => void = () => {}

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const realpathSync = Object.assign((path: fs.PathLike, options?: fs.EncodingOption) => {
    const real = actual.realpathSync(path, options)
    onRealpath(String(path))
    return real
  }, { native: actual.realpathSync.native })
  return { ...actual, default: { ...actual, realpathSync }, realpathSync }
})

const { loadInstructions } = await import('../src/index.js')

const temporary: string[] = []
afterEach(() => {
  onRealpath = () => {}
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('loadInstructions against a file swapped after its check', () => {
  it.skipIf(process.platform === 'win32')('reads the file it checked, never what a link put in its place', () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'harness-forge-race-'))
    temporary.push(root)
    const home = join(root, 'home')
    const proj = join(home, 'proj')
    fs.mkdirSync(join(proj, '.git'), { recursive: true })
    fs.writeFileSync(join(home, 'secret.txt'), 'SECRET')
    fs.writeFileSync(join(proj, 'CLAUDE.md'), '@notes.md')
    const notes = join(proj, 'notes.md')
    fs.writeFileSync(notes, 'NOTES')
    let swapped = false
    onRealpath = (path) => {
      if (swapped || resolve(path) !== notes) return
      swapped = true
      fs.renameSync(notes, join(proj, 'notes.old'))
      fs.symlinkSync(join(home, 'secret.txt'), notes)
    }
    const set = loadInstructions({ cwd: proj, home })
    expect(swapped).toBe(true)
    expect(JSON.stringify(set.files)).not.toContain('SECRET')
  })
})
