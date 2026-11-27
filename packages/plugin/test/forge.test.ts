import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HarnessForge } from '../src/forge/service.js'

const temporary: string[] = []
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

function pluginWithSkill(): { root: string; pluginRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'harness-forge-forge-'))
  temporary.push(root)
  const pluginRoot = join(root, 'plugin')
  mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true })
  writeFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'demo', version: '0.1.0' }), 'utf8')
  mkdirSync(join(pluginRoot, 'skills', 'one'), { recursive: true })
  writeFileSync(join(pluginRoot, 'skills', 'one', 'SKILL.md'), '---\nname: one\ndescription: One\n---\n\nOne.\n', 'utf8')
  return { root, pluginRoot }
}

describe('the shared service', () => {
  it('keeps a component inactive while its row is off, mounts it when the row registers, and withdraws it when the row goes', async () => {
    const { root, pluginRoot } = pluginWithSkill()
    const forge = new HarnessForge({ get: () => undefined } as never, join(root, 'state.json'), join(root, 'data'))
    await forge.install(pluginRoot, 'claude-code')
    const status = () => forge.list()[0]?.outcomes?.[0]
    expect(status()?.status).toBe('inactive')
    expect(status()?.message).toBe('inactive because the skills row is off')
    expect(forge.list()[0]?.compat?.gaps.some(gap => gap.kind === 'runtime-failure')).toBe(false)

    let mounted = 0
    const unregister = forge.registerMounter('skill', {
      mount: async ({ component }) => {
        mounted++
        return { outcome: { componentId: component.id, status: 'mounted', level: 'L1a', evidence: 'source' }, disposer: async () => { mounted-- } }
      },
    })
    await forge.ready()
    expect(mounted).toBe(1)
    expect(status()?.status).toBe('mounted')
    expect(forge.list()[0]?.skillRoots).toEqual([join(pluginRoot, 'skills')])

    unregister()
    await forge.ready()
    expect(mounted).toBe(0)
    expect(status()?.status).toBe('inactive')
    await forge.dispose()
  })

  it('offers a row API to lookups and watchers while it is provided', () => {
    const { root } = pluginWithSkill()
    const forge = new HarnessForge({ get: () => undefined } as never, join(root, 'state.json'), join(root, 'data'))
    expect(forge.lookup('agents')).toBeUndefined()
    const used: string[] = []
    const stop = forge.watch('agents', (api) => {
      used.push(`on:${api.foreignName('x') ?? ''}`)
      return () => { used.push('off') }
    })
    const api = { foreignName: () => 'plugin:x', presetOf: () => undefined, agentHooks: () => undefined }
    const withdraw = forge.provide('agents', api)
    expect(forge.lookup('agents')).toBe(api)
    withdraw()
    expect(forge.lookup('agents')).toBeUndefined()
    forge.provide('agents', api)
    stop()
    expect(used).toEqual(['on:plugin:x', 'off', 'on:plugin:x', 'off'])
  })
})
