import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { onDsh } from '../src/dsh/host.js'
import { HarnessForge } from '../src/forge/service.js'
import { SessionLifecycle } from '../src/hooks/broker/lifecycle.js'
import { ToolGate } from '../src/hooks/broker/tools.js'
import { ModsService } from '../src/mods/service.js'
import { SessionRegistry } from '../src/mods/service/sessions.js'
import { ModTools } from '../src/mods/service/tools.js'
import { EventBridge } from '../src/opencode/runtime/events.js'
import { startHooks } from '../src/hooks/row.js'
import { startMods } from '../src/mods/row.js'
import { startOpenCode } from '../src/opencode/row.js'
import { startSessions } from '../src/sessions/row.js'

type Listener = (...args: unknown[]) => unknown

/** A host with Cordis's listener order (prepended first) and its waterfall without any per-listener guard. */
function fakeHost() {
  const listeners = new Map<string, Listener[]>()
  const warnings: string[] = []
  const host = {
    logger: { warn: (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) } },
    get: () => undefined,
    inject: () => ({ dispose() {} }),
    effect: <T>(run: () => T): T => run(),
    on(name: string, listener: Listener, options?: { prepend?: boolean }) {
      const list = listeners.get(name) ?? []
      if (options?.prepend === true) list.unshift(listener)
      else list.push(listener)
      listeners.set(name, list)
      return () => { list.splice(list.indexOf(listener), 1) }
    },
    waterfall(name: string, ...args: unknown[]): Promise<unknown> {
      const final = args.pop() as () => Promise<unknown>
      const list = [...listeners.get(name) ?? []]
      const run = async (index: number): Promise<unknown> => {
        const listener = list[index]
        return listener === undefined ? final() : listener(...args, () => run(index + 1))
      }
      return run(0)
    },
    async emit(name: string, ...args: unknown[]): Promise<void> {
      for (const listener of [...listeners.get(name) ?? []]) await listener(...args)
    },
  }
  return { host, warnings }
}

const temporary: string[] = []
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('isolation', () => {
  it('lets a throwing waterfall listener fall through to next, keeps a result next already gave, and passes downstream errors on', async () => {
    const { host, warnings } = fakeHost()
    onDsh(host, 'tools/execute', (() => { throw new Error('boom') }) as never, { owner: 'mods' })
    expect(await host.waterfall('tools/execute', { name: 'read' }, async () => 'tool ran')).toBe('tool ran')
    expect(warnings.join('\n')).toContain('harness-forge/mods: tools/execute listener failed: boom')

    const after = fakeHost()
    let calls = 0
    onDsh(after.host, 'tools/execute', (async (_exec: unknown, next: () => Promise<unknown>) => { await next(); throw new Error('late') }) as never)
    expect(await after.host.waterfall('tools/execute', {}, async () => { calls++; return 'once' })).toBe('once')
    expect(calls).toBe(1)

    const failing = fakeHost()
    onDsh(failing.host, 'tools/execute', (async (_exec: unknown, next: () => Promise<unknown>) => next()) as never)
    await expect(failing.host.waterfall('tools/execute', {}, async () => { throw new Error('the tool failed') })).rejects.toThrow('the tool failed')
    expect(failing.warnings).toEqual([])

    const aborted = fakeHost()
    onDsh(aborted.host, 'tools/execute', (() => { throw Object.assign(new Error('stop'), { name: 'AbortError' }) }) as never)
    await expect(aborted.host.waterfall('tools/execute', {}, async () => 'ran')).rejects.toThrow('stop')
  })

  it('keeps tool calls and the other rows working when the mods, OpenCode and hooks listeners throw', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-forge-isolation-'))
    temporary.push(root)
    const { host, warnings } = fakeHost()
    const fail = () => { throw new Error('broken part') }
    for (const method of ['preExecute', 'execute', 'postExecute'] as const) vi.spyOn(ModTools.prototype, method).mockImplementation(fail)
    vi.spyOn(SessionRegistry.prototype, 'created').mockImplementation(fail)
    for (const method of ['preExecute', 'postExecute', 'sessionCreated'] as const) vi.spyOn(EventBridge.prototype, method).mockImplementation(fail)
    for (const method of ['preTool', 'executeTool', 'postTool'] as const) vi.spyOn(ToolGate.prototype, method).mockImplementation(fail)
    vi.spyOn(SessionLifecycle.prototype, 'agentCreated').mockImplementation(fail)
    const forge = new HarnessForge(host as never, join(root, 'state.json'), root)
    const stops = [startHooks(host as never, forge), startMods(host as never, forge), startOpenCode(host as never, forge), startSessions(host as never, forge)]

    const exec = { name: 'read', arguments: { file_path: 'a.txt' }, signal: new AbortController().signal }
    expect(await host.waterfall('tools/pre-execute', exec, async () => ({ kind: 'allow' }))).toEqual({ kind: 'allow' })
    const result = { isError: false, content: [{ type: 'text', text: 'file' }] }
    expect(await host.waterfall('tools/execute', exec, async () => result)).toBe(result)
    expect(await host.waterfall('tools/post-execute', exec, result, async () => ({ kind: 'accept' }))).toEqual({ kind: 'accept' })
    await expect(host.emit('agent/created', { agent: { session: { header: { id: 's1' } } }, source: 'user' })).resolves.toBeUndefined()
    expect(warnings.some(line => line.includes('harness-forge/mods'))).toBe(true)
    expect(warnings.some(line => line.includes('harness-forge/opencode'))).toBe(true)
    expect(warnings.some(line => line.includes('harness-forge/hooks'))).toBe(true)
    // The other rows are untouched.
    expect(forge.lookup('sessions')).toBeDefined()
    expect(forge.lookup('hooks')).toBeDefined()
    for (const stop of stops) await stop()
    vi.restoreAllMocks()
  })

  it('starts the rest of a row when one of its parts does not start, and tears down the rest when one teardown throws', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-forge-isolation-'))
    temporary.push(root)
    const { host, warnings } = fakeHost()
    vi.spyOn(ModsService.prototype, 'install').mockImplementation(() => { throw new Error('mods cannot start') })
    vi.spyOn(ModsService.prototype, 'shutdown').mockImplementation(async () => { throw new Error('mods cannot stop') })
    const forge = new HarnessForge(host as never, join(root, 'state.json'), root)
    const stop = startMods(host as never, forge)
    expect(warnings.join('\n')).toContain('engine did not start: mods cannot start')
    expect(forge.faults().map(fault => fault.row)).toContain('mods')
    expect(forge.ledger.mounters.has('claude-mod')).toBe(true)
    expect(forge.lookup('mods')).toBeDefined()
    await stop()
    expect(warnings.join('\n')).toContain('mods cannot stop')
    expect(forge.ledger.mounters.has('claude-mod')).toBe(false)
    expect(forge.lookup('mods')).toBeUndefined()
    vi.restoreAllMocks()
  })
})
