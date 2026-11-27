import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readSettings, settingsPathFor, writeSettings } from '../src/workbench/settings.js'

const temporary: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-forge-settings-'))
  temporary.push(root)
  return root
}

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('workbench settings', () => {
  it('round-trips discovery roots and budget', () => {
    const root = tempRoot()
    const statePath = join(root, '.harness-forge', 'state.json')
    writeSettings(statePath, {
      schemaVersion: 1,
      discoveryRoots: [join(root, 'plugins')],
      autoDiscover: false,
      contextBudgetTokens: 12000,
    })
    const settings = readSettings(statePath)
    expect(settings.discoveryRoots).toEqual([join(root, 'plugins')])
    expect(settings.autoDiscover).toBe(false)
    expect(settings.contextBudgetTokens).toBe(12000)
    expect(settingsPathFor(statePath)).toContain('settings.json')
  })

  it('falls back to defaults for a missing file', () => {
    const settings = readSettings(join(tempRoot(), '.harness-forge', 'state.json'))
    expect(settings.autoDiscover).toBe(true)
    expect(settings.discoveryRoots.length).toBeGreaterThan(0)
  })
})
