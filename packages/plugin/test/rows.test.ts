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
import * as sessions from '../src/sessions/row.js'
import * as context from '../src/context/row.js'

/** Every capability row, by name, with the kinds it mounts and whether it offers an API. */
const ROWS: Record<string, { readonly module: object; readonly kinds: readonly MountKind[]; readonly api?: keyof RowApis }> = {
  porter: { module: porter, kinds: [] },
  workbench: { module: workbench, kinds: [] },
  skills: { module: skills, kinds: ['skill'], api: 'skills' },
  commands: { module: commands, kinds: ['command', 'output-style'], api: 'commands' },
  agents: { module: agents, kinds: ['agent'], api: 'agents' },
  hooks: { module: hooks, kinds: ['hooks', 'codex-notify', 'codex-instructions'], api: 'hooks' },
  mcp: { module: mcp, kinds: ['mcp'], api: 'mcp' },
  mods: { module: mods, kinds: ['claude-mod'], api: 'mods' },
  opencode: { module: opencode, kinds: ['opencode-plugin'] },
  sessions: { module: sessions, kinds: [], api: 'sessions' },
  context: { module: context, kinds: [], api: 'context' },
}

let home: string
let pluginRoot: string

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'harness-forge-rows-'))
  process.env.DSH_HOME = home
  pluginRoot = join(home, 'plugin')
  mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true })
  writeFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'demo', version: '0.1.0' }), 'utf8')
  mkdirSync(join(pluginRoot, 'skills', 'one'), { recursive: true })
  writeFileSync(join(pluginRoot, 'skills', 'one', 'SKILL.md'), '---\nname: one\ndescription: One\n---\n\nOne.\n', 'utf8')
  mkdirSync(join(pluginRoot, 'commands'), { recursive: true })
  writeFileSync(join(pluginRoot, 'commands', 'greet.md'), '---\ndescription: Greet\n---\n\nHello\n', 'utf8')
})

afterAll(() => {
  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
})

/** Boot the `harness-forge` row and every capability row but `off` on a bare Cordis context. */
async function boot(off: string | undefined): Promise<{ forge: HarnessForge; commands: string[]; dispose(): Promise<void> }> {
  const root = new Context()
  const commands: string[] = []
  root.provide('skills', { register: () => () => {}, registerProvider: (create: (control: unknown) => unknown) => { create({ signal: new AbortController().signal, invalidate() {} }); return () => {} } })
  root.provide('commands', { register: (definition: { name: string }) => { commands.push(definition.name); return () => { commands.splice(commands.indexOf(definition.name), 1) } } })
  const fibers = [root.plugin(main as never, { preload: [pluginRoot] } as never)]
  for (const [name, row] of Object.entries(ROWS)) if (name !== off) fibers.push(root.plugin(row.module as never))
  await Promise.all(fibers.map(fiber => Promise.race([fiber, new Promise(resolve => setTimeout(resolve, 100))])))
  const forge = root.get('harnessForge') as HarnessForge
  await forge.ready()
  return { forge, commands, dispose: async () => { for (const fiber of fibers.reverse()) await fiber.dispose() } }
}

describe('rows', () => {
  for (const off of [undefined, ...Object.keys(ROWS)]) {
    it(off === undefined ? 'mount every kind with every row on' : `keep the other rows working with the ${off} row off`, async () => {
      const { forge, commands, dispose } = await boot(off)
      const offKinds = new Set(off === undefined ? [] : ROWS[off]!.kinds)
      for (const [name, row] of Object.entries(ROWS)) {
        if (row.api !== undefined) expect(forge.lookup(row.api) !== undefined, `${name} API`).toBe(name !== off)
        for (const kind of row.kinds) expect(forge.ledger.mounters.has(kind), `${kind} mounter`).toBe(name !== off)
      }
      const outcomes = new Map((forge.list()[0]?.outcomes ?? []).map(outcome => [outcome.componentId.split(':').slice(-2)[0], outcome]))
      expect(outcomes.get('skill')?.status).toBe(offKinds.has('skill') ? 'inactive' : 'mounted')
      expect(outcomes.get('command')?.status).toBe(offKinds.has('command') ? 'inactive' : 'mounted')
      expect(commands.includes('demo-greet')).toBe(!offKinds.has('command'))
      expect(commands.includes('harness')).toBe(true)
      expect(forge.faults()).toEqual([])
      await dispose()
    })
  }
})
