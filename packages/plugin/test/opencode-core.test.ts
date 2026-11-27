import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { OpenCodeCore } from '../src/opencode/runtime/core.js'
import type { PluginHost } from '../src/opencode/runtime/types.js'

/** A plugin host whose Bun process is gone: every delivery fails to connect. */
function goneHost(stopping: boolean): PluginHost {
  return { key: 'k', componentId: 'opencode:demo:code:plugin', pluginName: 'demo', root: '/demo', url: 'http://127.0.0.1:9', child: {} as never, hooks: new Set(['event']), tools: [], config: {}, events: Promise.resolve(), log: '', stopping }
}

describe('OpenCode events', () => {
  it('records a failed delivery to a running plugin, and not one cut off while the plugin is being stopped', async () => {
    const observed: Array<{ signal: string; ok: boolean }> = []
    const core = new OpenCodeCore({} as never, { dataRoot: '/data', observe: (_id, signal, ok) => { observed.push({ signal, ok }) }, directory: async () => '/work', rewrite: () => {}, agentName: () => undefined })
    const running = goneHost(false)
    core.hosts.set('k', running)
    core.emit({ type: 'session.idle', properties: {} })
    await running.events
    expect(observed).toEqual([{ signal: 'opencode:event', ok: false }, { signal: 'opencode:event:failed', ok: false }])
    observed.length = 0
    const stopping = goneHost(true)
    core.hosts.set('k', stopping)
    core.emit({ type: 'session.updated', properties: {} })
    await stopping.events
    expect(observed).toEqual([])
  })

  it('still records what a stopping plugin answered with an error', async () => {
    const server = createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: false, error: 'handler threw' })) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const observed: Array<{ signal: string; ok: boolean }> = []
      const core = new OpenCodeCore({} as never, { dataRoot: '/data', observe: (_id, signal, ok) => { observed.push({ signal, ok }) }, directory: async () => '/work', rewrite: () => {}, agentName: () => undefined })
      const host = { ...goneHost(true), url: `http://127.0.0.1:${String((server.address() as { port: number }).port)}` }
      core.hosts.set('k', host)
      core.emit({ type: 'session.updated', properties: {} })
      await host.events
      expect(observed).toEqual([{ signal: 'opencode:event', ok: false }, { signal: 'opencode:event:failed', ok: false }])
    } finally {
      server.close()
    }
  })
})

/** A plugin host answering every hook with `answer` (or never, when it is `undefined`). */
async function hookServer(answer: Record<string, unknown> | undefined): Promise<{ url: string; close(): void }> {
  const sockets = new Set<import('node:net').Socket>()
  const server = createServer((_request, response) => {
    if (answer === undefined) return
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(answer))
  })
  server.on('connection', socket => { sockets.add(socket) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${String((server.address() as { port: number }).port)}`, close: () => { for (const socket of sockets) socket.destroy(); server.close() } }
}

describe('OpenCode hooks', () => {
  const observed: Array<{ id: string; signal: string; ok: boolean }> = []
  const coreWith = (deadlineMs: number): OpenCodeCore => new OpenCodeCore({} as never, { dataRoot: '/data', observe: (id, signal, ok) => { observed.push({ id, signal, ok }) }, directory: async () => '/work', rewrite: () => {}, agentName: () => undefined }, deadlineMs)
  const plugin = (id: string, url: string): PluginHost => ({ ...goneHost(false), key: id, componentId: id, url, hooks: new Set(['tool.execute.before']) })

  it('skips a plugin that cannot be reached or does not answer in time, and runs the rest of the chain', async () => {
    observed.length = 0
    const hung = await hookServer(undefined)
    const good = await hookServer({ ran: 1, output: { args: { changed: true } } })
    try {
      const core = coreWith(150)
      core.hosts.set('gone', plugin('gone', 'http://127.0.0.1:9'))
      core.hosts.set('hung', plugin('hung', hung.url))
      core.hosts.set('good', plugin('good', good.url))
      const result = await core.trigger('tool.execute.before', {}, { args: {} })
      expect(result.error).toBeUndefined()
      expect(result.output).toEqual({ args: { changed: true } })
      expect(result.faults).toHaveLength(2)
      expect(result.faults[1]).toMatch(/did not answer/u)
      expect(observed.filter(entry => entry.signal === 'opencode:tool.execute.before:failed').map(entry => entry.id)).toEqual(['gone', 'hung'])
    } finally {
      hung.close()
      good.close()
    }
  })

  it('denies only on a plugin that explicitly refuses, and stops the chain there', async () => {
    observed.length = 0
    const refusing = await hookServer({ ran: 1, output: {}, error: 'refusing rm -rf', errorKind: 'stop' })
    const after = await hookServer({ ran: 1, output: {} })
    try {
      const core = coreWith(1000)
      core.hosts.set('refusing', plugin('refusing', refusing.url))
      core.hosts.set('after', plugin('after', after.url))
      expect((await core.trigger('tool.execute.before', {}, { args: {} })).error).toBe('refusing rm -rf')
      expect(observed.some(entry => entry.id === 'after')).toBe(false)
    } finally {
      refusing.close()
      after.close()
    }
  })

  it('treats a crash inside a plugin hook as a fault, not a refusal', async () => {
    observed.length = 0
    const crashing = await hookServer({ ran: 1, output: {}, error: 'x is not a function', errorKind: 'crash' })
    const good = await hookServer({ ran: 1, output: {} })
    try {
      const core = coreWith(1000)
      core.hosts.set('crashing', plugin('crashing', crashing.url))
      core.hosts.set('good', plugin('good', good.url))
      const result = await core.trigger('tool.execute.before', {}, { args: {} })
      expect(result.error).toBeUndefined()
      expect(result.faults).toEqual(['x is not a function'])
      expect(observed.some(entry => entry.id === 'good' && entry.ok)).toBe(true)
    } finally {
      crashing.close()
      good.close()
    }
  })
})
