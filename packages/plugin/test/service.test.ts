import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { TestHarness } from './harness.js'
import { readState } from '../src/forge/state.js'

const temporary: string[] = []
const host = { get: () => undefined } as never

/** A host whose command registry is `commands` (set it later for one that appears late). */
function commandHost(commands?: { register(definition: CommandDefinition): () => void }): { host: never; set(registry: typeof commands): void } {
  let registry = commands
  return { host: { get: (name: string) => name === 'commands' ? registry : undefined } as never, set: (next) => { registry = next } }
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-forge-service-'))
  temporary.push(root)
  return root
}

function claudePlugin(root: string, name: string, files: Record<string, string>): string {
  const pluginRoot = join(root, 'plugin')
  mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true })
  writeFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version: '0.1.0', license: 'MIT' }), 'utf8')
  for (const [path, content] of Object.entries(files)) {
    const target = join(pluginRoot, path)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  return pluginRoot
}

function invoke(definition: CommandDefinition, rawInput: string): Promise<{ result: unknown; followups: UserMessage[] }> {
  const followups: UserMessage[] = []
  const result = Promise.resolve(definition.handler({
    rawInput,
    agent: { followup: (message: UserMessage) => { followups.push(message) }, session: { header: { id: 'session-test' } } },
    attachments: [],
    signal: new AbortController().signal,
  } as never))
  return result.then(value => ({ result: value, followups }))
}

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('installing through the ledger and its rows', () => {
  it('restores the ledger before an install that arrives while startup waits, and keeps both records', async () => {
    const root = tempRoot()
    const statePath = join(root, 'state.json')
    const oldRoot = claudePlugin(join(root, 'old-home'), 'old-plugin', { 'skills/a/SKILL.md': '---\nname: a\ndescription: A\n---\n\nA.\n' })
    const first = new TestHarness(host, statePath, join(root, 'data'))
    await first.install(oldRoot, 'claude-code')
    await first.dispose()
    const newRoot = claudePlugin(join(root, 'new-home'), 'new-plugin', { 'skills/b/SKILL.md': '---\nname: b\ndescription: B\n---\n\nB.\n' })
    const service = new TestHarness(host, statePath, join(root, 'data'))
    let release: () => void = () => {}
    // Startup is waiting (for the capability catalog) when the install arrives.
    const startup = service.start([], () => new Promise<void>((resolve) => { release = resolve }))
    const install = service.install(newRoot, 'claude-code')
    await new Promise(resolve => setTimeout(resolve, 20))
    release()
    await startup
    await install
    expect(readState(statePath).plugins.map(plugin => plugin.name).sort()).toEqual(['new-plugin', 'old-plugin'])
    await service.dispose()
  })

  it('writes nothing over a ledger it could not read at startup', async () => {
    const root = tempRoot()
    const statePath = join(root, 'state.json')
    // Unreadable as a file (a directory where the ledger should be), so the restore fails.
    mkdirSync(statePath)
    const service = new TestHarness(host, statePath, join(root, 'data'))
    await expect(service.start()).rejects.toThrow()
    const pluginRoot = claudePlugin(root, 'after-failure', { 'skills/c/SKILL.md': '---\nname: c\ndescription: C\n---\n\nC.\n' })
    await expect(service.install(pluginRoot, 'claude-code')).rejects.toThrow(/could not be read at startup/u)
    await service.dispose()
  })

  it('installs a Claude plugin, names its command after the plugin, and removes both', async () => {
    const root = tempRoot()
    const pluginRoot = claudePlugin(root, 'demo-plugin', {
      'skills/review/SKILL.md': '---\nname: review\ndescription: Review code\n---\n\nReview.\n',
      'commands/greet.md': '---\ndescription: Greet someone by name\n---\n\nHello $ARGUMENTS\n',
    })
    const statePath = join(root, 'state.json')
    const definitions: CommandDefinition[] = []
    const disposed: number[] = []
    const service = new TestHarness(commandHost({
      register(definition) {
        if (definition.name !== 'output-style') definitions.push(definition)
        return () => { disposed.push(1) }
      },
    }).host, statePath, join(root, 'data'))

    const report = await service.install(pluginRoot, 'claude-code')
    expect(report.alreadyInstalled).toBe(false)
    expect(report.commands).toEqual(['demo-plugin-greet'])
    expect(service.listSkillRoots()).toContain(join(pluginRoot, 'skills'))
    expect(definitions[0]?.name).toBe('demo-plugin-greet')
    expect(definitions[0]?.description).toBe('Greet someone by name')

    const record = service.list()[0]
    expect(record?.outcomes?.find(outcome => outcome.componentId.endsWith(':command:greet'))?.status).toBe('mounted')
    expect(record?.compat?.achieved.declarativeRuntime).toBe('L1b')

    const { followups } = await invoke(definitions[0]!, ' world')
    expect(followups[0]?.content).toEqual([{ type: 'text', text: 'Hello world' }])
    const verified = service.list()[0]?.outcomes?.find(outcome => outcome.componentId.endsWith(':command:greet'))
    expect(verified?.status).toBe('verified')
    expect(verified?.observations?.[0]?.signal).toBe('command')
    expect(service.list()[0]?.compat?.achieved.declarativeRuntime).toBe('L2')

    expect(await service.uninstall('claude-code:demo-plugin')).toBe(true)
    expect(disposed.length).toBeGreaterThan(0)
    expect(service.listSkillRoots()).toEqual([])
    const after = JSON.parse(readFileSync(statePath, 'utf8')) as { plugins: unknown[] }
    expect(after.plugins).toHaveLength(0)
  })

  it('switches one part off and on again, and keeps it off across a restart', async () => {
    const root = tempRoot()
    const pluginRoot = claudePlugin(root, 'switchable', { 'skills/only/SKILL.md': '---\nname: only\ndescription: Only\n---\n\nOnly.\n' })
    const statePath = join(root, 'state.json')
    const service = new TestHarness(host, statePath, join(root, 'data'))
    await service.install(pluginRoot, 'claude-code')
    const skill = service.list()[0]!.outcomes!.find(outcome => outcome.componentId.endsWith(':skill:only'))!.componentId
    expect(service.listSkillRoots()).toContain(join(pluginRoot, 'skills'))

    expect(await service.forge.setPartEnabled('claude-code:switchable', skill, false)).toBe(true)
    expect(await service.forge.setPartEnabled('claude-code:switchable', skill, false)).toBe(false)
    expect(service.listSkillRoots()).toEqual([])
    expect(service.list()[0]).toMatchObject({ disabled: [skill] })
    expect(service.list()[0]!.outcomes!.find(outcome => outcome.componentId === skill)?.status).toBe('inactive')
    await service.dispose()

    const restarted = new TestHarness(host, statePath, join(root, 'data'))
    await restarted.start()
    expect(restarted.listSkillRoots()).toEqual([])
    expect(readState(statePath).plugins[0]?.disabled).toEqual([skill])

    expect(await restarted.forge.setPartEnabled('claude-code:switchable', skill, true)).toBe(true)
    expect(restarted.listSkillRoots()).toContain(join(pluginRoot, 'skills'))
    expect(restarted.list()[0]!.outcomes!.find(outcome => outcome.componentId === skill)?.status).toBe('mounted')
    expect(readState(statePath).plugins[0]?.disabled ?? []).toEqual([])
    await expect(restarted.forge.setPartEnabled('claude-code:nobody', skill, true)).rejects.toThrow(/no installed plugin/u)
    await restarted.dispose()
  })

  it('reports a part whose withdrawal failed instead of switching it off or removing it, and retries', async () => {
    const root = tempRoot()
    const pluginRoot = claudePlugin(root, 'stuck', { 'skills/only/SKILL.md': '---\nname: only\ndescription: Only\n---\n\nOnly.\n' })
    const service = new TestHarness(host, join(root, 'state.json'), join(root, 'data'))
    await service.install(pluginRoot, 'claude-code')
    const id = 'claude-code:stuck'
    const skill = service.list()[0]!.outcomes!.find(outcome => outcome.componentId.endsWith(':skill:only'))!.componentId
    // Its withdrawal fails until `fail` is cleared.
    const mounts = service.forge.ledger.live.get(id)!.mounts
    const { released } = await mounts.release()
    const actionId = service.forge.ledger.live.get(id)!.plan!.actions.find(action => action.componentId === skill)!.id
    let fail = true
    mounts.add(actionId, { componentId: skill, kind: released[0]!.kind, dispose: async () => { if (fail) throw new Error('busy') } })

    await expect(service.forge.setPartEnabled(id, skill, false)).rejects.toThrow(/failed to switch off: busy/u)
    expect(service.list()[0]!.outcomes!.find(outcome => outcome.componentId === skill)).toMatchObject({ status: 'failed', message: 'failed to switch off: busy' })
    expect(service.list()[0]!.disabled ?? []).toEqual([])
    await expect(service.uninstall(id)).rejects.toThrow(/failed to switch off: busy/u)
    expect(service.list().map(record => record.id)).toEqual([id])
    fail = false
    expect(await service.forge.setPartEnabled(id, skill, false)).toBe(true)
    expect(service.list()[0]!.outcomes!.find(outcome => outcome.componentId === skill)?.status).toBe('inactive')
    expect(await service.uninstall(id)).toBe(true)
    await service.dispose()
  })

  it('retries a command that was planned before the command registry existed', async () => {
    const root = tempRoot()
    const pluginRoot = claudePlugin(root, 'late-registry', { 'commands/greet.md': '---\ndescription: Greet\n---\n\nHello\n' })
    const late = commandHost()
    const service = new TestHarness(late.host, join(root, 'state.json'), join(root, 'data'))
    await service.install(pluginRoot, 'claude-code')
    expect(service.list()[0]?.outcomes?.[0]?.status).toBe('failed')

    const definitions: CommandDefinition[] = []
    late.set({ register(definition) { if (definition.name !== 'output-style') definitions.push(definition); return () => {} } })
    service.retryFailed()
    await service.forge.ready()
    expect(definitions.map(definition => definition.name)).toEqual(['late-registry-greet'])
    expect(service.list()[0]?.outcomes?.[0]?.status).toBe('mounted')
  })

  it('restores installations from the ledger and keeps runtime evidence', async () => {
    const root = tempRoot()
    const pluginRoot = claudePlugin(root, 'restore-demo', { 'commands/greet.md': '---\ndescription: Greet\n---\n\nHello $ARGUMENTS\n' })
    const statePath = join(root, 'state.json')
    const definitions: CommandDefinition[] = []
    const service = new TestHarness(commandHost({ register(definition) { if (definition.name !== 'output-style') definitions.push(definition); return () => {} } }).host, statePath, join(root, 'data'))
    await service.install(pluginRoot, 'claude-code')
    await invoke(definitions[0]!, 'Ada')
    await service.dispose()

    const restored = new TestHarness(commandHost({ register() { return () => {} } }).host, statePath, join(root, 'data'))
    await restored.start()
    const outcome = restored.list()[0]?.outcomes?.find(candidate => candidate.componentId.endsWith(':command:greet'))
    expect(outcome?.status).toBe('verified')
    expect(outcome?.observations).toHaveLength(1)
  })

  it('keeps a plugin whose source disappeared visible with the reason', async () => {
    const root = tempRoot()
    const pluginRoot = claudePlugin(root, 'vanishing', { 'skills/one/SKILL.md': '---\nname: one\ndescription: One\n---\n\nOne.\n' })
    const statePath = join(root, 'state.json')
    const service = new TestHarness(host, statePath, join(root, 'data'))
    await service.install(pluginRoot, 'claude-code')
    await service.dispose()
    rmSync(pluginRoot, { recursive: true, force: true })

    const restored = new TestHarness(host, statePath, join(root, 'data'))
    await restored.start()
    const outcome = restored.list()[0]?.outcomes?.[0]
    expect(outcome?.status).toBe('failed')
    expect(outcome?.message).toMatch(/source directory is missing/u)
  })

  it('writes a receipt that can be undone', async () => {
    const root = tempRoot()
    const pluginRoot = claudePlugin(root, 'receipt-demo', { 'skills/safe/SKILL.md': '---\nname: safe\ndescription: Safe\n---\n\nSafe.\n' })
    const statePath = join(root, 'state.json')
    const service = new TestHarness(host, statePath, join(root, 'data'))
    const report = await service.install(pluginRoot, 'claude-code')
    expect(report.receipt.actions.some(action => action.kind === 'link-skill-root' && action.status === 'applied')).toBe(true)

    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { schemaVersion: number; plugins: Array<{ receipts?: string[] }> }
    expect(state.schemaVersion).toBe(2)
    expect(state.plugins[0]?.receipts).toHaveLength(1)
    expect(existsSync(join(root, 'receipts', `${report.receipt.id}.json`))).toBe(true)

    expect(await service.undo(report.receipt.id)).toBe(true)
    expect(service.list()).toHaveLength(0)
    expect(service.skills.listRoots()).toEqual([])
  })

  it('dispose releases runtime without deleting the ledger', async () => {
    const root = tempRoot()
    const pluginRoot = claudePlugin(root, 'dispose-demo', { 'skills/one/SKILL.md': '---\nname: one\ndescription: One\n---\n\nOne.\n' })
    const statePath = join(root, 'state.json')
    const service = new TestHarness(host, statePath, join(root, 'data'))
    await service.install(pluginRoot, 'claude-code')
    await service.dispose()
    const persisted = JSON.parse(readFileSync(statePath, 'utf8')) as { plugins: unknown[] }
    expect(persisted.plugins).toHaveLength(1)
    expect(service.skills.listRoots()).toEqual([])

    const restored = new TestHarness(host, statePath, join(root, 'data'))
    await restored.start()
    expect(restored.list()).toHaveLength(1)
    expect(restored.listSkillRoots()).toContain(join(pluginRoot, 'skills'))
  })

  it('refuses a plugin whose plugin.json is not JSON, with the reason, and installs nothing of it', async () => {
    const root = tempRoot()
    const pluginRoot = claudePlugin(root, 'broken', { 'skills/one/SKILL.md': '---\nname: one\ndescription: One\n---\n\nOne.\n' })
    writeFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), '{ "name": "broken", ', 'utf8')
    const service = new TestHarness(host, join(root, 'state.json'), join(root, 'data'))
    await expect(service.install(pluginRoot, 'claude-code')).rejects.toThrow(/plugin\.json is not valid JSON; the plugin was not imported/u)
    expect(service.list()).toHaveLength(0)
  })

  it('installs a second plugin of the same name from another root under a stable suffixed name', async () => {
    const root = tempRoot()
    const first = claudePlugin(join(root, 'a'), 'twin', { 'commands/hello.md': '---\ndescription: A\n---\nA\n' })
    const second = claudePlugin(join(root, 'b'), 'twin', { 'commands/hello.md': '---\ndescription: B\n---\nB\n' })
    const service = new TestHarness(host, join(root, 'state.json'), join(root, 'data'))
    await service.install(first, 'claude-code')
    const report = await service.install(second, 'claude-code')
    expect(report.alreadyInstalled).toBe(false)
    expect(report.plugin.name).toMatch(/^twin-[0-9a-f]{6}$/u)
    expect(report.plugin.warnings.some(warning => warning.code === 'name-conflict')).toBe(true)
    expect(service.list().map(record => record.id).sort()).toEqual(['claude-code:twin', `claude-code:${report.plugin.name}`].sort())
    // The same root again is the same plugin: no third install.
    const again = await service.install(second, 'claude-code')
    expect(again.plugin.name).toBe(report.plugin.name)
    expect(again.alreadyInstalled).toBe(true)
    expect(service.list()).toHaveLength(2)
  })

  it('reports hook events DSH never raises as gaps', async () => {
    const root = tempRoot()
    const pluginRoot = claudePlugin(root, 'hooks-demo', {
      'hooks/hooks.json': JSON.stringify({ hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
        TeammateIdle: [{ hooks: [{ type: 'command', command: 'echo idle' }] }],
        Elicitation: [{ hooks: [{ type: 'http', url: 'http://localhost' }] }],
        Stop: [{ hooks: [{ type: 'websocket', url: 'ws://localhost' }] }],
      } }),
    })
    const service = new TestHarness(host, join(root, 'state.json'), join(root, 'data'))
    await service.install(pluginRoot, 'claude-code')
    const gaps = service.list()[0]?.compat?.gaps ?? []
    expect(gaps.some(gap => gap.kind === 'unsupported-event' && gap.summary.includes('TeammateIdle') && gap.summary.includes('Elicitation'))).toBe(true)
    // http handlers run; a handler type neither Claude Code nor DSH knows does not.
    expect(gaps.some(gap => gap.kind === 'unsupported-handler' && gap.summary.includes('websocket') && !gap.summary.includes('http'))).toBe(true)
  })

  it('builds a capability catalog and flags an over-budget context', async () => {
    const root = tempRoot()
    const pluginRoot = claudePlugin(root, 'catalog-demo', { 'skills/one/SKILL.md': '---\nname: one\ndescription: One\n---\n\nOne.\n' })
    const service = new TestHarness(host, join(root, 'state.json'), join(root, 'data'))
    await service.install(pluginRoot, 'claude-code')
    service.saveSettings({ contextBudgetTokens: 1 })
    const catalog = service.capabilities()
    expect(catalog.totals['skill']).toBe(1)
    expect(catalog.plugins[0]?.items[0]?.name).toBe('one')
    expect(catalog.overBudget).toBe(true)
  })

  it('reports unsupported OpenCode npm packages without failing the install', async () => {
    const root = tempRoot()
    writeFileSync(join(root, 'opencode.json'), JSON.stringify({ plugin: ['some-npm-package'] }), 'utf8')
    const service = new TestHarness(host, join(root, 'state.json'), join(root, 'data'))
    const report = await service.install(root, 'opencode')
    expect(report.outcomes.some(outcome => outcome.status === 'skipped')).toBe(true)
  })

  it('migrates a v1 ledger without a trust field', () => {
    const root = tempRoot()
    const statePath = join(root, 'state.json')
    writeFileSync(statePath, JSON.stringify({
      schemaVersion: 1,
      plugins: [{
        id: 'claude-code:legacy',
        source: 'claude-code',
        name: 'legacy',
        root: join(root, 'plugin'),
        installedAt: '2026-01-01T00:00:00.000Z',
        components: [{ kind: 'skill', name: 'legacy' }],
      }],
    }), 'utf8')
    const state = readState(statePath)
    expect(state.schemaVersion).toBe(2)
    expect(state.plugins[0]?.receipts).toEqual([])
  })

  it('drops a legacy trust object from a v2 ledger', () => {
    const root = tempRoot()
    const statePath = join(root, 'state.json')
    writeFileSync(statePath, JSON.stringify({
      schemaVersion: 2,
      plugins: [{
        id: 'claude-code:legacy-v2',
        source: 'claude-code',
        name: 'legacy-v2',
        root: join(root, 'plugin'),
        installedAt: '2026-01-01T00:00:00.000Z',
        components: [],
        trust: { execute: false, code: false },
      }],
    }), 'utf8')
    const state = readState(statePath)
    expect(state.plugins).toHaveLength(1)
    expect('trust' in (state.plugins[0] as object)).toBe(false)
  })
})
