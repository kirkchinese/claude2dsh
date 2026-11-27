import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { CodeComponent } from '@kirkchinese/harness-forge-core'
import { mountClaudeMod } from '../src/mods/claude.js'
import { workspaceBundler } from './workspace-bundler.js'

const temporary: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-forge-code-'))
  temporary.push(root)
  return root
}

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

function component(root: string, name: string): CodeComponent {
  return {
    id: `demo:code:${name}`,
    kind: 'code',
    name,
    runtime: 'claude-mod',
    entryPath: join(root, 'mod.mjs'),
    path: 'mod.mjs',
  }
}

describe('code shims', () => {
  it('bundles a Claude mod and hands it to the mods service, seated by where it comes from', async () => {
    const root = tempRoot()
    writeFileSync(join(root, 'mod.mjs'), 'export function register(on) { on("turn.start", ($, e, next) => next(e)); on("session.start", async ($, e, next) => { await $.store.get("x"); return next(e) }) }\n', 'utf8')
    const added: Array<Record<string, unknown>> = []
    const mods = { async add(source: Record<string, unknown>) { added.push(source); return async () => {} } }
    const plugin = (name: string, author: string) => ({ id: `claude-code:${name}`, name, root, source: 'claude-code', manifest: { name, author: { name: author } }, components: [], warnings: [] })
    const mine = await mountClaudeMod(mods as never, component(root, 'demo'), plugin('notes', 'Someone') as never, async () => workspaceBundler)
    const builtIn = await mountClaudeMod(mods as never, component(root, 'demo'), plugin('diff', 'Anthropic') as never, async () => workspaceBundler)
    const guard = await mountClaudeMod(mods as never, component(root, 'demo'), plugin('sec-default', 'Anthropic') as never, async () => workspaceBundler)
    expect([mine.tier, builtIn.tier, guard.tier]).toEqual(['user', 'builtin', 'prepend'])
    expect(added[0]).toMatchObject({ name: 'notes', tier: 'user', uses: { events: ['turn.start', 'session.start'], calls: ['store.get'] } })
    expect(typeof (added[0]?.['bundle'] as { code?: unknown }).code).toBe('string')
    await mine.dispose()
  })

  it('carries the scan refusal of a module that keeps its engine.create table', async () => {
    const root = tempRoot()
    writeFileSync(join(root, 'mod.mjs'), 'let held\nexport function register(on) { on("engine.create", async (_$, e, next) => { const beneath = await next(e); held = beneath; return beneath }) }\n', 'utf8')
    const added: Array<Record<string, unknown>> = []
    const mods = { async add(source: Record<string, unknown>) { added.push(source); return async () => {} } }
    await mountClaudeMod(mods as never, component(root, 'demo'), { id: 'x', name: 'holding', root, source: 'claude-code', manifest: { name: 'holding' }, components: [], warnings: [] } as never, async () => workspaceBundler)
    expect(String(added[0]?.['refusal'])).toMatch(/keeps the table/u)
  })

})
