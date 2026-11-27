import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { OpenCodeRuntime } from '../src/opencode/runtime.js'

const temporary: string[] = []
const disposers: Array<() => unknown> = []

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A V1 OpenCode plugin exercising a tool, chat.message, tool.execute.before/after, shell.env, events and the client. */
const PLUGIN = `
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
export const Demo = async ({ client }) => {
  const log = line => appendFileSync(join(LOG_DIR, 'events.log'), line + '\\n')
  return {
    tool: {
      greet: {
        description: 'Greet someone',
        args: {},
        async execute(args, context) {
          return { title: 'greeting', output: 'hello ' + args.name + ' in ' + context.sessionID }
        },
      },
    },
    'chat.message': async (input, output) => {
      output.parts.unshift({ type: 'text', text: 'MEMORY: likes tea', synthetic: true })
      await client.session.prompt({ path: { id: input.sessionID }, body: { noReply: true, parts: [{ type: 'text', text: 'SKILLS: none', synthetic: true }] } })
    },
    'tool.execute.before': async (input, output) => {
      if (input.tool === 'bash' && output.args.command.includes('rm -rf')) throw new Error('refusing rm -rf')
      if (input.tool === 'bash') output.args.command = output.args.command + ' && echo checked'
    },
    'tool.execute.after': async (input, output) => {
      if (input.tool === 'read') output.output = output.output + '\\n[read by ' + input.callID + ']'
    },
    'shell.env': async (_input, output) => { output.env.DEMO_FLAG = 'on' },
    event: async ({ event }) => { log(event.type) },
  }
}
`

interface FakeAgent {
  session: { header: { id: string; cwd: string }; seq: number; eventAt(seq: number): unknown }
  options: { provider: string; model: string }
  injected: unknown[]
  followup(message: unknown): void
  inject(message: unknown): void
  cancel(): void
  whenIdle(): Promise<void>
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'harness-forge-opencode-'))
  temporary.push(root)
  writeFileSync(join(root, 'plugin.mjs'), PLUGIN.replace('LOG_DIR', JSON.stringify(root)))
  const listeners = new Map<string, (...args: never[]) => unknown>()
  const tools = new Map<string, Record<string, unknown>>()
  const agent: FakeAgent = {
    session: { header: { id: 'session-demo', cwd: root }, seq: 0, eventAt: () => undefined },
    options: { provider: 'deepseek', model: 'deepseek-chat' },
    injected: [],
    followup() {},
    inject(message) { agent.injected.push(message) },
    cancel() {},
    async whenIdle() {},
  }
  const ctx = {
    get(name: string) {
      if (name === 'tools') return { register(definition: Record<string, unknown>) { tools.set(String(definition['name']), definition); return () => { tools.delete(String(definition['name'])) } } }
      if (name === 'agents') return { get: (id: string) => (id === agent.session.header.id ? agent : undefined), list: () => [agent], roots: () => [agent] }
      return undefined
    },
    on(name: string, listener: (...args: never[]) => unknown) {
      listeners.set(name, listener)
      return () => { listeners.delete(name) }
    },
  }
  const rewrites = new Map<string, Record<string, unknown>>()
  const observed: string[] = []
  const runtime = new OpenCodeRuntime(ctx as unknown as Context, {
    dataRoot: join(root, 'data'),
    observe: (_component, signal) => { observed.push(signal) },
    directory: async () => root,
    rewrite: (callId, args) => { rewrites.set(callId, args) },
    agentName: () => undefined,
  })
  disposers.push(runtime.install())
  const component = { id: 'opencode:demo:code:plugin', kind: 'code' as const, name: 'plugin', runtime: 'opencode-plugin' as const, entryPath: join(root, 'plugin.mjs'), path: 'plugin.mjs' }
  const plugin = { id: 'opencode:demo', name: 'demo', root, source: 'opencode', components: [component], warnings: [], manifest: {} }
  const call = <T>(name: string, ...args: unknown[]): Promise<T> => Promise.resolve((listeners.get(name) as (...rest: unknown[]) => T)(...args))
  return { root, runtime, component, plugin, agent, tools, rewrites, observed, call }
}

describe('OpenCode runtime', () => {
  it('loads a V1 plugin in Bun, offers its tool and runs it with OpenCode\'s context', async () => {
    const { runtime, component, plugin, tools, agent } = setup()
    const mount = await runtime.mount(component as never, plugin as never)
    disposers.push(() => mount.dispose())
    expect(mount.tools).toEqual(['greet'])
    expect(mount.hooks).toEqual(expect.arrayContaining(['chat.message', 'tool.execute.before', 'tool.execute.after', 'shell.env', 'event']))
    const greet = tools.get('greet') as { execute(args: unknown, exec: unknown): Promise<unknown> }
    await expect(greet.execute({ name: 'Ada' }, { agent, signal: new AbortController().signal, callId: 'call-1' })).resolves.toBe('hello Ada in session-demo')
  }, 120_000)

  it('runs chat.message before a prompt enters: changed parts enter with it, noReply prompts enter before it', async () => {
    const { runtime, component, plugin, agent, call } = setup()
    const mount = await runtime.mount(component as never, plugin as never)
    disposers.push(() => mount.dispose())
    const prompt = { id: 'msg-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'make tea' }] }
    const decision = await call<{ messages: Array<{ content: Array<{ text?: string }>; source?: { kind?: string } }> }>('agent/pre-step', { agent, messages: [prompt], signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [prompt] }))
    expect(decision.messages.map(message => message.content.map(block => block.text).join('|'))).toEqual(['SKILLS: none', 'MEMORY: likes tea|make tea'])
    expect(decision.messages[0]?.source?.kind).toBe('opencode-plugin')
  }, 120_000)

  it('maps tool.execute.before onto DSH calls: a throw refuses, changed arguments run; shell.env adds variables', async () => {
    const { runtime, component, plugin, agent, rewrites, call } = setup()
    const mount = await runtime.mount(component as never, plugin as never)
    disposers.push(() => mount.dispose())
    const signal = new AbortController().signal
    const refused = await call<{ kind: string; reason?: string }>('tools/pre-execute', { name: 'pwsh', arguments: { command: 'rm -rf /', description: 'x' }, callId: 'c1', agent, signal }, async () => ({ kind: 'allow' }))
    expect(refused).toEqual({ kind: 'deny', reason: 'refusing rm -rf' })
    await call('tools/pre-execute', { name: 'pwsh', arguments: { command: 'ls', description: 'x' }, callId: 'c2', agent, signal }, async () => ({ kind: 'allow' }))
    expect(rewrites.get('c2')).toMatchObject({ command: 'ls && echo checked', description: 'x' })
    await expect(runtime.shellEnv({ name: 'pwsh', arguments: {}, callId: 'c2', agent, signal } as never)).resolves.toEqual({ DEMO_FLAG: 'on' })
  }, 120_000)

  it('lets tool.execute.after rewrite what the model reads, and delivers events to the plugin', async () => {
    const { root, runtime, component, plugin, agent, call } = setup()
    const mount = await runtime.mount(component as never, plugin as never)
    disposers.push(() => mount.dispose())
    const signal = new AbortController().signal
    const exec = { name: 'read', arguments: { file_path: 'a.txt' }, callId: 'c3', agent, signal }
    await call('tools/pre-execute', exec, async () => ({ kind: 'allow' }))
    const decision = await call<{ content: Array<{ text: string }> }>('tools/post-execute', exec, { isError: false, content: [{ type: 'text', text: 'file body' }] }, async () => ({ kind: 'accept' }))
    expect(decision.content[0]?.text).toBe('file body\n[read by c3]')
    await call('session/event', { id: 'session-demo' }, { type: 'turn/end', seq: 1, time: Date.now(), data: { turn: 1, reason: 'answer' } })
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(readFileSync(join(root, 'events.log'), 'utf8')).toContain('session.idle')
  }, 120_000)

  it('delivers a turn\'s last events before the runtime stops the plugin', async () => {
    const { root, runtime, component, plugin, call } = setup()
    // The runtime's own disposer, which setup registered for cleanup: this test runs it.
    const stop = disposers.pop()!
    await runtime.mount(component as never, plugin as never)
    // The turn ends and the process shuts down at once, as a one-shot DSH run does.
    await call('session/event', { id: 'session-demo' }, { type: 'turn/end', seq: 1, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } })
    await stop()
    const log = readFileSync(join(root, 'events.log'), 'utf8')
    expect(log).toContain('session.idle')
    expect(log).toContain('session.updated')
  }, 120_000)
})
