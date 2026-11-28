import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { scanPlugin } from '@kirkchinese/harness-forge-core'
import { adapterCoverage, enabledAdapters, type PluginManagerLike } from '../src/workbench/adapter-coverage.js'
import { coveringAdapter } from '../src/workbench/overview.js'
import { PortSessions } from '../src/porting/port-sessions.js'
import { verifyPort } from '../src/porting/verify-port.js'

const root = mkdtempSync(join(tmpdir(), 'hf-coverage-'))
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

function pkg(dir: string, manifest: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
}

describe('adapter coverage', () => {
  it('reads harnessForge.ports from packages installed in the profile and the shared profile root', () => {
    const profile = join(root, 'profiles', 'web')
    pkg(join(profile, 'node_modules', '@example', 'dsh-adapter-claude-hud-statusline'), {
      name: '@example/dsh-adapter-claude-hud-statusline',
      harnessForge: { ports: [{ plugin: 'claude-hud', component: 'statusline' }] },
    })
    pkg(join(root, 'profiles', 'node_modules', 'some-adapter'), { name: 'some-adapter', harnessForge: { ports: [{ plugin: 'demo', component: 'monitor-x' }, { plugin: 7 }] } })
    pkg(join(profile, 'node_modules', 'left-pad'), { name: 'left-pad' })
    // A local adapter from a porting brief that forgot its ports still counts by its name.
    pkg(join(profile, 'node_modules', 'dsh-adapter-demo-monitor'), { name: 'dsh-adapter-demo-monitor' })
    const coverage = adapterCoverage(profile)
    expect(coverage).toContainEqual({ name: 'dsh-adapter-demo-monitor', ports: [], dir: realpathSync(join(profile, 'node_modules', 'dsh-adapter-demo-monitor')) })
    expect(coverage).toContainEqual({ name: '@example/dsh-adapter-claude-hud-statusline', ports: [{ plugin: 'claude-hud', component: 'statusline' }], dir: realpathSync(join(profile, 'node_modules', '@example', 'dsh-adapter-claude-hud-statusline')) })
    expect(coverage).toContainEqual(expect.objectContaining({ name: 'some-adapter', ports: [{ plugin: 'demo', component: 'monitor-x' }] }))
    expect(coverage.some(item => item.name === 'left-pad')).toBe(false)
  })

  it('gives a locally installed adapter the directory its link points to', () => {
    const profile = join(root, 'linked', 'web')
    const source = join(root, 'dsh-adapters', 'dsh-adapter-demo-x')
    pkg(source, { name: 'dsh-adapter-demo-x', harnessForge: { ports: [{ plugin: 'demo', component: 'x' }] } })
    mkdirSync(join(profile, 'node_modules'), { recursive: true })
    symlinkSync(source, join(profile, 'node_modules', 'dsh-adapter-demo-x'), 'dir')
    expect(adapterCoverage(profile)).toEqual([{ name: 'dsh-adapter-demo-x', ports: [{ plugin: 'demo', component: 'x' }], dir: realpathSync(source) }])
  })

  it('counts only adapters DSH lists as installed, enabled and loaded without a fault, as harness_verify_port does', async () => {
    // A failed install_bundle rolls the profile's package.json back but leaves its node_modules link behind.
    const profile = join(root, 'stray', 'web')
    const names = ['dsh-adapter-demo-enabled', 'dsh-adapter-demo-stray', 'dsh-adapter-demo-off', 'dsh-adapter-demo-broken', 'dsh-adapter-demo-faulted']
    for (const name of names) pkg(join(profile, 'node_modules', name), { name, harnessForge: { ports: [{ plugin: 'demo', component: name.slice('dsh-adapter-demo-'.length) }] } })
    const manager: PluginManagerLike = {
      listBundles: async () => [
        { name: 'dsh-adapter-demo-enabled', enabled: true, rows: [] },
        { name: 'dsh-adapter-demo-off', enabled: false, rows: [] },
        { name: 'dsh-adapter-demo-broken', enabled: true, error: { code: 'operation-error' }, rows: [] },
        // Enabled and listed, but its plugin row failed to start.
        { name: 'dsh-adapter-demo-faulted', enabled: true, rows: [{ rowId: 'main', entryId: 'faulted#main' }] },
      ],
      listPlugins: async () => [{ entryId: 'faulted#main', enabled: true, fiberPhase: 'failed', diagnostic: 'Error: boom' }],
    }
    const onDisk = adapterCoverage(profile)
    expect(onDisk.map(item => item.name).sort()).toEqual([...names].sort())
    const counted = await enabledAdapters(onDisk, manager)
    expect(counted.map(item => item.name)).toEqual(['dsh-adapter-demo-enabled'])
    expect(await enabledAdapters(onDisk, undefined)).toEqual([])

    // The verify tool agrees part by part: covered exactly where the overview counts an adapter.
    const source = join(root, 'demo-plugin')
    mkdirSync(join(source, '.claude-plugin'), { recursive: true })
    writeFileSync(join(source, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'demo' }))
    mkdirSync(join(source, 'skills', 'x'), { recursive: true })
    writeFileSync(join(source, 'skills', 'x', 'SKILL.md'), '---\nname: x\ndescription: x\n---\nbody\n')
    const plugin = scanPlugin(source, { source: 'claude-code' }).plugin
    for (const name of names) {
      const component = { ...plugin.components[0]!, id: name, name: name.slice('dsh-adapter-demo-'.length) }
      const withPart = { ...plugin, components: [component] }
      const verified = await verifyPort({
        findPlugin: () => ({ plugin: withPart }),
        adapters: () => onDisk,
        pluginManager: manager,
        sessions: new PortSessions(join(root, `state-${name}.json`)),
      }, plugin.id, component.id)
      expect(verified.covered, name).toBe(coveringAdapter(withPart, component, counted) !== undefined)
    }
  })
})
