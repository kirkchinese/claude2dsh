import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverPlugins, detectSource } from '../src/discover.js'

const temporary: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-forge-discover-'))
  temporary.push(root)
  return root
}

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('plugin discovery', () => {
  it('finds nested manifest roots and stops descending at a plugin', () => {
    const root = tempRoot()
    const claude = join(root, 'cache', 'claude', 'demo')
    mkdirSync(join(claude, '.claude-plugin'), { recursive: true })
    writeFileSync(join(claude, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'claude-demo', version: '1.0.0' }))
    mkdirSync(join(claude, 'skills', 'one'), { recursive: true })
    writeFileSync(join(claude, 'skills', 'one', 'SKILL.md'), '---\nname: one\ndescription: One\n---\n\nOne.\n')
    const opencode = join(root, 'config', 'opencode')
    mkdirSync(opencode, { recursive: true })
    writeFileSync(join(opencode, 'opencode.json'), JSON.stringify({ plugin: [] }))

    const result = discoverPlugins([root])
    expect(result.plugins.map(plugin => plugin.name).sort()).toEqual(['claude-demo', 'opencode'])
    expect(result.plugins.find(plugin => plugin.name === 'claude-demo')?.components.skill).toBe(1)
    expect(detectSource(claude)).toBe('claude-code')
  })

  it('reports missing roots instead of throwing', () => {
    const root = tempRoot()
    const result = discoverPlugins([join(root, 'missing')])
    expect(result.plugins).toEqual([])
    expect(result.missingRoots).toHaveLength(1)
  })
})
