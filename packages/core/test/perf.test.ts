import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverPlugins } from '../src/discover.js'
import { scanPlugin } from '../src/manifest.js'

const temporary: string[] = []

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('discovery performance', () => {
  it('scans fifty small plugin roots within a bounded budget', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-forge-perf-'))
    temporary.push(root)
    for (let index = 0; index < 50; index += 1) {
      const plugin = join(root, `plugin-${index}`)
      mkdirSync(join(plugin, '.claude-plugin'), { recursive: true })
      writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: `perf-${index}` }))
      mkdirSync(join(plugin, 'skills', 'one'), { recursive: true })
      writeFileSync(join(plugin, 'skills', 'one', 'SKILL.md'), '---\nname: one\ndescription: One\n---\n\nOne.\n')
    }
    const started = performance.now()
    const result = discoverPlugins([root])
    const elapsed = performance.now() - started
    expect(result.plugins).toHaveLength(50)
    expect(elapsed).toBeLessThan(5000)
    expect(scanPlugin(join(root, 'plugin-0'), { source: 'claude-code' }).plugin.components).toHaveLength(1)
  })
})
