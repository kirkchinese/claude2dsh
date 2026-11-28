import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as main from '../src/index.js'
import type { MountKind, RowApis } from '../src/forge/contract.js'
import type { HarnessForge } from '../src/forge/service.js'
import * as porter from '../src/porting/row.js'
import * as workbench from '../src/workbench/row.js'
import * as skills from '../src/skills/row.js'
import * as commands from '../src/commands/row.js'
import * as agents from '../src/agents/row.js'
import * as hooks from '../src/hooks/row.js'
import * as mcp from '../src/mcp/row.js'
import * as mods from '../src/mods/row.js'
import * as opencode from '../src/opencode/row.js'
import { bindAddedCommands } from '../src/opencode/row.js'
import * as sessions from '../src/sessions/row.js'
import * as context from '../src/context/row.js'

/** Every capability row, with the kinds of the demo plugin it mounts and the API it offers. */
const ROWS: Record<string, { readonly module: object; readonly kinds: readonly MountKind[]; readonly api?: keyof RowApis }> = {
  porter: { module: porter, kinds: [] },
  workbench: { module: workbench, kinds: [] },
  skills: { module: skills, kinds: ['skill'], api: 'skills' },
  commands: { module: commands, kinds: ['command'], api: 'commands' },
  agents: { module: agents, kinds: ['agent'], api: 'agents' },
  hooks: { module: hooks, kinds: ['hooks'], api: 'hooks' },
  mcp: { module: mcp, kinds: ['mcp'], api: 'mcp' },
  mods: { module: mods, kinds: [], api: 'mods' },
  opencode: { module: opencode, kinds: [] },
  sessions: { module: sessions, kinds: [], api: 'sessions' },
  context: { module: context, kinds: [], api: 'context' },
}

const KIND_OF_PART: Readonly<Record<string, MountKind>> = { skill: 'skill', command: 'command', agent: 'agent', hooks: 'hooks', mcp: 'mcp' }

const STANDARD = '- name: \'@deepseek-ai/dsh-persona\'\n  config: {}\n'

let home: string
let pluginRoot: string

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'harness-forge-toggle-'))
  process.env.DSH_HOME = home
  pluginRoot = join(home, 'plugin')
  const write = (path: string, text: string): void => {
    mkdirSync(join(pluginRoot, path, '..'), { recursive: true })
    writeFileSync(join(pluginRoot, path), text, 'utf8')
  }
  write('.claude-plugin/plugin.json', JSON.stringify({ name: 'demo', version: '0.1.0' }))
  write('skills/one/SKILL.md', '---\nname: one\ndescription: One\n---\n\nOne.\n')
  write('commands/greet.md', '---\ndescription: Greet\n---\n\nHello\n')
  write('agents/alpha.md', '---\nname: alpha\ndescription: Alpha\n---\n\nYou are alpha.\n')
  write('agents/beta.md', '---\nname: beta\ndescription: Beta\n---\n\nYou are beta.\n')
  write('agents/gamma.md', '---\nname: gamma\ndescription: Gamma\n---\n\nYou are gamma.\n')
  write('hooks/hooks.json', JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'true' }] }] } }))
  write('.mcp.json', JSON.stringify({ mcpServers: { echo: { command: 'node', args: ['server.js'] } } }))
})

afterAll(() => {
  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
})

/** What the fake host has registered now. */
interface Host {
  readonly commands: string[]
  readonly presets: Set<string>
  readonly servers: Set<string>
}

async function boot(): Promise<{ root: Context; forge: HarnessForge; host: Host; fibers: Map<string, { dispose(): Promise<unknown> }>; dispose(): Promise<void> }> {
  const root = new Context()
  const host: Host = { commands: [], presets: new Set(), servers: new Set() }
  root.provide('skills', { register: () => () => {}, registerProvider: (create: (control: unknown) => unknown) => { create({ signal: new AbortController().signal, invalidate() {} }); return () => {} } })
  root.provide('commands', { register: (definition: { name: string }) => { host.commands.push(definition.name); return () => { host.commands.splice(host.commands.indexOf(definition.name), 1) } } })
  root.provide('agentPresets', {
    defaultId: 'standard',
    readDocument: async () => ({ content: STANDARD }),
    register: async (definition: { id: string }) => {
      host.presets.add(definition.id)
      return async () => { host.presets.delete(definition.id) }
    },
  })
  root.provide('capabilityCatalogServers', { addMcpServer: async (server: { name: string }) => { host.servers.add(server.name); return async () => { host.servers.delete(server.name) } } })
  root.provide('capabilityCatalog', { request: async () => ({ servers: [] }) })
  const fibers = new Map<string, { dispose(): Promise<unknown> }>()
  const forgeFiber = root.plugin(main as never, { preload: [pluginRoot] } as never) as unknown as { dispose(): Promise<unknown> }
  for (const [name, row] of Object.entries(ROWS)) fibers.set(name, root.plugin(row.module as never) as never)
  const forge = await waitFor(() => root.get('harnessForge') as HarnessForge | undefined)
  await forge.ready()
  return {
    root, forge, host, fibers,
    dispose: async () => {
      for (const fiber of [...fibers.values()].reverse()) await fiber.dispose()
      await forgeFiber.dispose()
    },
  }
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 20_000
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/**
 * Run `check` (assertions on the mounted state) until it passes, then once more after the ledger's queue has run
 * out. The effects of a row switching run on their own, so how long they take depends on the machine; the state
 * itself is what is waited for, up to a deadline that only a failing run reaches.
 */
async function eventually(forge: HarnessForge, check: () => void): Promise<void> {
  const deadline = Date.now() + 20_000
  for (;;) {
    try {
      check()
      break
    } catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  await forge.ledger.queue
  check()
}

/** Outcomes of the demo plugin by part kind: `skill`, `agent`, … */
function outcomes(forge: HarnessForge): Map<string, Array<{ status: string; message?: string }>> {
  const out = new Map<string, Array<{ status: string; message?: string }>>()
  for (const outcome of forge.list()[0]?.outcomes ?? []) {
    const kind = outcome.componentId.split(':').slice(-2)[0]!
    out.set(kind, [...out.get(kind) ?? [], outcome])
  }
  return out
}

function expectAllOn(forge: HarnessForge, host: Host): void {
  const all = outcomes(forge)
  for (const kind of Object.keys(KIND_OF_PART)) {
    for (const outcome of all.get(kind) ?? []) expect(outcome.status, `${kind}: ${outcome.message ?? ''}`).toBe('mounted')
  }
  expect(all.get('agent')).toHaveLength(3)
  expect(host.commands).toContain('demo-greet')
  expect([...host.presets].sort()).toEqual(['demo-alpha', 'demo-beta', 'demo-gamma'])
  expect(host.servers.size).toBe(1)
  for (const name of ['alpha', 'beta', 'gamma']) expect(forge.lookup('agents')?.presetOf(`demo:${name}`), name).toBe(`demo-${name}`)
  for (const [name, row] of Object.entries(ROWS)) if (row.api !== undefined) expect(forge.lookup(row.api), `${name} API`).toBeDefined()
  expect(forge.faults()).toEqual([])
}

describe('switching a row off and on', () => {
  for (const [name, row] of Object.entries(ROWS)) {
    it(`withdraws and re-mounts the ${name} row's parts, twice`, async () => {
      const { root, forge, host, fibers, dispose } = await boot()
      try {
        await eventually(forge, () => { expectAllOn(forge, host) })
        for (let round = 0; round < 2; round++) {
          await fibers.get(name)!.dispose()
          await eventually(forge, () => {
            const all = outcomes(forge)
            for (const [part, kind] of Object.entries(KIND_OF_PART)) {
              for (const outcome of all.get(part) ?? []) {
                if (row.kinds.includes(kind)) {
                  expect(outcome.status, `${part} after switching ${name} off: ${outcome.message ?? ''}`).toBe('inactive')
                  expect(outcome.message).toMatch(/row is off/u)
                } else expect(outcome.status, `${part} with ${name} off: ${outcome.message ?? ''}`).toBe('mounted')
              }
            }
            if (row.kinds.includes('command')) expect(host.commands).not.toContain('demo-greet')
            if (row.kinds.includes('agent')) expect(host.presets.size).toBe(0)
            if (row.kinds.includes('mcp')) expect(host.servers.size).toBe(0)
            if (row.api !== undefined) expect(forge.lookup(row.api)).toBeUndefined()
            expect(forge.faults()).toEqual([])
          })
          fibers.set(name, root.plugin(row.module as never) as never)
          await eventually(forge, () => { expectAllOn(forge, host) })
        }
      } finally {
        await dispose()
      }
    })
  }
})

describe('commands an OpenCode plugin added', () => {
  const added = {
    name: 'oc-review',
    component: { id: 'opencode:demo:command:oc-review', kind: 'command' as const, name: 'oc-review', path: 'oc-review', description: 'Review', body: 'Review $ARGUMENTS', frontmatter: {} },
  }

  it('come back when the commands row starts after the plugin mounted, and go with either', async () => {
    const { root, forge, host, fibers, dispose } = await boot()
    try {
      await eventually(forge, () => { expectAllOn(forge, host) })
      // The plugin mounts while the commands row is off.
      await fibers.get('commands')!.dispose()
      await eventually(forge, () => { expect(forge.lookup('commands')).toBeUndefined() })
      const recorded: Array<readonly string[]> = []
      const owner = { pluginId: 'opencode:demo', pluginRoot, dataDir: join(home, 'data'), scope: {}, takenNames: () => new Set<string>() }
      const unbind = bindAddedCommands(forge, [added], owner, (names) => { recorded.push(names) })
      expect(host.commands).not.toContain('oc-review')
      for (let round = 0; round < 2; round++) {
        fibers.set('commands', root.plugin(commands as never) as never)
        await eventually(forge, () => { expect(host.commands, `round ${String(round)}`).toContain('oc-review') })
        await fibers.get('commands')!.dispose()
        await eventually(forge, () => { expect(host.commands).not.toContain('oc-review') })
      }
      expect(recorded).toEqual([['oc-review'], ['oc-review']])
      // The plugin's withdrawal takes its commands with it while the row runs.
      fibers.set('commands', root.plugin(commands as never) as never)
      await eventually(forge, () => { expect(host.commands).toContain('oc-review') })
      unbind()
      expect(host.commands).not.toContain('oc-review')
      await fibers.get('commands')!.dispose()
      fibers.set('commands', root.plugin(commands as never) as never)
      await eventually(forge, () => { expect(forge.lookup('commands')).toBeDefined() })
      expect(host.commands).not.toContain('oc-review')
      expect(forge.faults()).toEqual([])
    } finally {
      await dispose()
    }
  })
})
