import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultDiscoveryRoots } from '@kirkchinese/harness-forge-core'
import { defaultSettings, readSettings } from '../src/workbench/settings.js'

describe('default discovery roots', () => {
  it('are the harnesses\' own folders, never the folder DSH was started from', () => {
    const started = mkdtempSync(join(tmpdir(), 'harness-forge-started-'))
    const before = process.cwd()
    process.chdir(started)
    try {
      expect(defaultSettings().discoveryRoots).toEqual(defaultDiscoveryRoots())
      expect(defaultSettings().discoveryRoots).not.toContain(resolve(started))
      expect(readSettings(join(started, 'missing', 'state.json')).discoveryRoots).not.toContain(resolve(started))
    } finally {
      process.chdir(before)
      rmSync(started, { recursive: true, force: true })
    }
  })
})
