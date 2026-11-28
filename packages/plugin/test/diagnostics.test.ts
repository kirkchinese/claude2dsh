import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanPlugin, type ComponentOutcome, type ForeignPlugin } from '@kirkchinese/harness-forge-core'
import { mountLabel } from '../src/client/shared.js'
import english from '../src/client/locale/en.json' with { type: 'json' }
import chinese from '../src/client/locale/zh.json' with { type: 'json' }
import { mountsFor } from '../src/forge/ledger.js'
import { forgeVersion, Workbench } from '../src/workbench/workbench.js'

const own = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string }

function workbench(faults: unknown[], mounts: unknown[]): Workbench {
  const ledger = {
    ctx: {}, statePath: '/state.json', dataRoot: '/data', live: new Map(),
    list: () => [{ id: 'claude-code:demo', name: 'demo', source: 'claude-code', root: '/demo', installedAt: '', mounts }],
  }
  return new Workbench({ ctx: {}, ledger, shell: { powershell: 'pwsh', defaultKind: 'bash' }, faults: () => faults, lookup: () => undefined } as never)
}

describe('diagnostics', () => {
  it('reads Harness Forge\'s version from its own package.json, built or not', () => {
    expect(forgeVersion()).toBe(own.version)
    expect(forgeVersion(join(import.meta.dirname, '..', 'lib', 'workbench', 'workbench.js'))).toBe(own.version)
    expect((workbench([], []).diagnostics()['versions'] as { forge: string }).forge).toBe(own.version)
  })

  it('does not call a run with failed parts a clean start', () => {
    expect(workbench([], []).diagnostics()['summary']).toEqual({ ok: true, faults: 0, failedMounts: 0 })
    const failed = workbench([], [{ kind: 'mcp', name: 'db', status: 'failed', error: 'spawn ENOENT' }, { kind: 'skill', name: 'one', status: 'mounted' }]).diagnostics()
    expect(failed['summary']).toEqual({ ok: false, faults: 0, failedMounts: 1 })
    expect(failed['failedMounts']).toEqual([{ pluginId: 'claude-code:demo', plugin: 'demo', kind: 'mcp', name: 'db', error: 'spawn ENOENT' }])
  })

  it('records a failed hook mount with its plugin, its events and why it failed, not the mount identity', () => {
    const scanned = scanned_()
    const hooks = scanned.components.find(component => component.kind === 'hooks')!
    const outcome = { componentId: hooks.id, status: 'failed', level: 'L1b', evidence: 'runtime', message: 'Interrupt,Stop,SubagentStop', observations: [{ signal: 'Stop', ok: false, at: '', detail: 'stop.sh exited 1' }] } as ComponentOutcome
    expect(mountsFor(scanned, new Map([[hooks.id, outcome]]))).toEqual([{ kind: 'hooks', name: 'inline', events: ['Interrupt', 'Stop', 'SubagentStop'], status: 'failed', error: 'Stop: stop.sh exited 1' }])
    const diagnosed = workbench([], mountsFor(scanned, new Map([[hooks.id, outcome]]))).diagnostics()
    expect(diagnosed['failedMounts']).toEqual([{ pluginId: 'claude-code:demo', plugin: 'demo', kind: 'hooks', name: 'inline', events: ['Interrupt', 'Stop', 'SubagentStop'], error: 'Stop: stop.sh exited 1' }])
  })

  it('words a failed mount for people, in their language', () => {
    const en = (key: string): string => (english as Record<string, string>)[key] ?? key
    const zh = (key: string): string => (chinese as Record<string, string>)[key] ?? key
    const hooks = { kind: 'hooks', name: 'inline', events: ['Interrupt', 'SubagentStop', 'Stop'] }
    expect(mountLabel(hooks, en as never)).toBe('Hooks (inline): Interrupt, SubagentStop, Stop')
    expect(mountLabel(hooks, zh as never)).toBe('Hook（inline）：Interrupt、SubagentStop、Stop')
    expect(mountLabel({ kind: 'mcp', name: 'db' }, en as never)).toBe('MCP server: db')
  })
})

function scanned_(): ForeignPlugin {
  const root = mkdtempSync(join(tmpdir(), 'hf-diagnostics-'))
  mkdirSync(join(root, '.claude-plugin'))
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'demo', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'stop.sh' }] }], Interrupt: [], SubagentStop: [] } }))
  return scanPlugin(root, { source: 'claude-code' }).plugin
}
