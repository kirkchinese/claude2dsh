import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import { synthesizeDshSession, type NormalizedSession } from '@kirkchinese/harness-forge-core'
import { codexSessionId, discoverCodexSessions, importCodexSession, readCodexSession } from '../src/sessions/codex.js'
import { importOpenCodeSession, openCodeSessionId } from '../src/sessions/opencode.js'
import { isSharedFolder, persistImported } from '../src/sessions/persist.js'
import { claudeIdentity } from '../src/sessions/claude.js'
import { startSessions } from '../src/sessions/row.js'
import { CHAT_IMPORT_PACKAGE, installChatImport, sessionImportStatus, YIELD_MESSAGE } from '../src/sessions/chat-import.js'
import * as zstd from '../src/sessions/zstd.js'
import { zstdChunks } from '../src/sessions/zstd.js'
import type { SessionsApi } from '../src/forge/contract.js'

const temporary: string[] = []
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-forge-import-'))
  temporary.push(dir)
  return dir
}

interface FakeHost {
  readonly ctx: Context
  readonly created: Array<Record<string, unknown>>
  readonly appended: unknown[][]
  readonly attached: Array<[string, string]>
  readonly resolved: string[]
  readonly resumed: string[]
}

/** A DSH with the services an import uses; `services` adds to or replaces them. */
function fakeHost(options: { stored?: ReadonlyArray<string | { readonly id: string; readonly createdAt?: number }>; controller?: boolean; services?: Record<string, unknown> } = {}): FakeHost {
  const created: Array<Record<string, unknown>> = []
  const appended: unknown[][] = []
  const attached: Array<[string, string]> = []
  const resolved: string[] = []
  const resumed: string[] = []
  const live = new Set<string>()
  const stored = new Map((options.stored ?? []).map(entry => (typeof entry === 'string' ? [entry, { id: entry }] : [entry.id, entry])))
  const services: Record<string, unknown> = {
    sessionPersistence: {
      async list() { return [...stored.values()].map(header => ({ header, revision: 1, sizeBytes: 1 })) },
      async create(header: Record<string, unknown>) {
        created.push(header)
        stored.set(header['id'] as string, header as { id: string })
        return {
          async append(events: unknown[]) { appended.push(events) },
          async flush() {},
          async close() {},
        }
      },
    },
    workspaceRegistry: {
      async create(path: string) {
        return { path, sessionIds: [], async attachSession(id: string) { attached.push([path, id]) } }
      },
    },
    agents: {
      get: (id: string) => (live.has(id) ? {} : undefined),
      async resume({ resumeSessionId }: { resumeSessionId: string }) { resumed.push(resumeSessionId); live.add(resumeSessionId) },
    },
    ...(options.controller === false ? {} : {
      sessionController: {
        async resolveAgent(id: string) { resolved.push(id); live.add(id); return { agent: {} } },
      },
    }),
    ...options.services,
  }
  const ctx = { get: (name: string) => services[name] } as unknown as Context
  return { ctx, created, appended, attached, resolved, resumed }
}

function session(cwd: string, id = 'claude-abc'): NormalizedSession {
  return {
    id,
    source: { tool: 'claude-code', path: '/x.jsonl', sessionId: 'abc' },
    createdAt: 1,
    cwd,
    title: 'A title',
    turns: [{ number: 1, prompt: 'Hello', steps: [{ number: 1, content: [{ type: 'text', text: 'Hi' }], toolCalls: [], toolResults: [] }] }],
  } as unknown as NormalizedSession
}

/** Persist a Claude Code session the way its import does; what the import reports of where it went. */
async function persist(ctx: Context, normalized: NormalizedSession) {
  return (await persistImported(ctx, normalized, claudeIdentity('abc'))).persisted
}

function codexRollout(dir: string, lines: readonly unknown[], name = 'rollout-2026-01-02T03-04-05-x.jsonl'): string {
  const path = join(dir, name)
  writeFileSync(path, lines.map(line => JSON.stringify(line)).join('\n'))
  return path
}

const META = { timestamp: '2026-01-02T00:00:00.000Z', type: 'session_meta', payload: { session_id: 'sid-1', timestamp: '2026-01-02T00:00:00.000Z', cwd: '/w' } }
const PROMPT = { timestamp: '2026-01-02T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Run it' } }

describe('imported sessions are registered with the running DSH', () => {
  it('groups the session under the workspace of its directory and makes it live through the session controller', async () => {
    const cwd = tempDir()
    const host = fakeHost()
    const result = await persist(host.ctx, session(cwd))
    expect(result).toEqual({ id: 'claude-abc', reused: false, live: true, workspace: cwd })
    expect(host.created[0]).toMatchObject({ id: 'claude-abc', cwd })
    expect(host.attached).toEqual([[cwd, 'claude-abc']])
    expect(host.resolved).toEqual(['claude-abc'])
    // The title is in the log the sidebar reads.
    expect(host.appended[0]).toContainEqual(expect.objectContaining({ type: 'session/title', data: expect.objectContaining({ title: 'A title' }) }))
  })

  it('resumes the session through agents.resume where there is no session controller (headless)', async () => {
    const host = fakeHost({ controller: false })
    const result = await persist(host.ctx, session(tempDir()))
    expect(result.live).toBe(true)
    expect(host.resumed).toEqual(['claude-abc'])
  })

  it('leaves a session whose directory is not on this computer ungrouped, and still imports it', async () => {
    const host = fakeHost()
    const result = await persist(host.ctx, session('/no/such/dir-7f3a'))
    expect(result.workspace).toBeUndefined()
    expect(host.attached).toEqual([])
    expect(host.created).toHaveLength(1)
  })

  it('leaves a session in the home folder or a system temp folder ungrouped, but not one in a folder inside it', async () => {
    for (const shared of [homedir(), tmpdir(), `${tmpdir()}${sep}`, ...(process.platform === 'win32' ? [] : ['/tmp', '/var/tmp'])]) {
      const host = fakeHost()
      const result = await persist(host.ctx, session(shared))
      expect(result.workspace, shared).toBeUndefined()
      expect(host.attached).toEqual([])
      expect(host.created).toHaveLength(1)
    }
    const project = tempDir()
    expect((await persist(fakeHost().ctx, session(project))).workspace).toBe(project)
    expect(isSharedFolder('/private/var/folders/ab/cd1234/T')).toBe(process.platform !== 'win32')
    expect(isSharedFolder('/var/folders/ab/cd1234/T/')).toBe(process.platform !== 'win32')
    expect(isSharedFolder('/private/tmp')).toBe(process.platform !== 'win32')
    expect(isSharedFolder('/var/folders/ab/cd1234/T/project')).toBe(false)
  })

  it('opens the session an earlier import wrote instead of failing with "already exists"', async () => {
    const host = fakeHost({ stored: ['claude-abc'] })
    const result = await persist(host.ctx, session(tempDir()))
    expect(result).toMatchObject({ id: 'claude-abc', reused: true, live: true })
    expect(host.created).toEqual([])
    expect(host.resolved).toEqual(['claude-abc'])
  })
})

describe('Codex import', () => {
  it('unwraps {"output", "metadata"} tool output to the output text', async () => {
    const dir = tempDir()
    const path = codexRollout(dir, [META, PROMPT,
      { type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"command":["ls"]}' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: 'a.txt\n', metadata: { exit_code: 0, duration_seconds: 0.1 } }) } },
    ])
    const { session: parsed } = await readCodexSession(path)
    expect(parsed.turns[0]!.steps[0]!.toolResults[0]!.content).toEqual([{ type: 'text', text: 'a.txt\n' }])
  })

  it('keeps output that is JSON of another shape as it is', async () => {
    const dir = tempDir()
    const path = codexRollout(dir, [META, PROMPT,
      { type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{}' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: '{"rows":[1]}' } },
    ])
    const { session: parsed } = await readCodexSession(path)
    expect(parsed.turns[0]!.steps[0]!.toolResults[0]!.content).toEqual([{ type: 'text', text: '{"rows":[1]}' }])
  })

  it('puts assistant text that follows a tool call in the next step, so the call stays next to its result', async () => {
    const dir = tempDir()
    const path = codexRollout(dir, [META, PROMPT,
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Looking.' }] } },
      { type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{}' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'While it runs…' }] } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'done' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] } },
    ])
    const { session: parsed } = await readCodexSession(path)
    const steps = parsed.turns[0]!.steps
    expect(steps.map(step => step.content.map(block => block.type))).toEqual([['text', 'tool-call'], ['text', 'text']])
    expect(steps[0]!.toolResults.map(result => result.toolCallId)).toEqual(['c1'])
    // In the synthesized log, the tool result directly follows the assistant message holding the call.
    const events = synthesizeDshSession(parsed).events.filter(event => event.type === 'assistant/message' || event.type === 'tool/result')
    expect(events.map(event => event.type)).toEqual(['assistant/message', 'tool/result', 'assistant/message'])
  })

  it('discovers and reads compressed rollouts (.jsonl.zst), written as several zstd frames', async () => {
    const root = tempDir()
    const day = join(root, '2026', '01', '02')
    mkdirSync(day, { recursive: true })
    const text = [META, PROMPT, { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi' }] } }].map(line => JSON.stringify(line)).join('\n')
    const half = text.length >> 1
    writeFileSync(join(day, 'rollout-2026-01-02T03-04-05-z.jsonl.zst'), Buffer.concat([zstdCompressSync(Buffer.from(text.slice(0, half))), zstdCompressSync(Buffer.from(text.slice(half)))]))
    const found = (await discoverCodexSessions(root)).sessions
    expect(found.map(item => item.sourceId)).toEqual(['sid-1'])
    const { session: parsed } = await readCodexSession(found[0]!.path)
    expect(parsed.turns[0]!.prompt).toBe('Run it')
    expect(parsed.turns[0]!.steps[0]!.content).toEqual([{ type: 'text', text: 'Hi' }])
  })

  it('lists a rollout once when both the plain and the compressed file are there', async () => {
    const root = tempDir()
    const path = codexRollout(root, [META, PROMPT])
    writeFileSync(`${path}.zst`, zstdCompressSync(Buffer.from(JSON.stringify(META))))
    expect((await discoverCodexSessions(root)).sessions.map(item => item.path)).toEqual([path])
  })

  it('gives new imports a prefixed id and reuses one an earlier version stored under the Codex id', async () => {
    const dir = tempDir()
    const path = codexRollout(dir, [META, PROMPT, { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi' }] } }])
    const fresh = fakeHost()
    expect((await importCodexSession(fresh.ctx, path)).id).toBe(codexSessionId('sid-1'))
    expect(codexSessionId('sid-1')).toBe('codex-sid-1')
    const earlier = fakeHost({ stored: [{ id: 'sid-1', createdAt: Date.parse(META.payload.timestamp) }] })
    expect(await importCodexSession(earlier.ctx, path)).toMatchObject({ id: 'sid-1', reused: true })
    expect(earlier.created).toEqual([])
  })
})

describe('OpenCode import', () => {
  function database(): string {
    const path = join(tempDir(), 'opencode.db')
    const db = new DatabaseSync(path)
    db.exec(`
      create table session (id text primary key, parent_id text, title text, directory text, time_created integer, time_updated integer);
      create table message (id text primary key, session_id text, time_created integer, data text);
      create table part (id text primary key, message_id text, session_id text, time_created integer, data text);
    `)
    db.prepare('insert into session values (?, ?, ?, ?, ?, ?)').run('ses_1', null, 'Fixture', '/w', 1000, 2000)
    db.prepare('insert into message values (?, ?, ?, ?)').run('m_u', 'ses_1', 1001, JSON.stringify({ role: 'user', time: { created: 1001 } }))
    db.prepare('insert into part values (?, ?, ?, ?, ?)').run('p_u', 'm_u', 'ses_1', 1001, JSON.stringify({ type: 'text', text: 'Edit it' }))
    db.prepare('insert into message values (?, ?, ?, ?)').run('m_a', 'ses_1', 1002, JSON.stringify({ role: 'assistant', time: { created: 1002 } }))
    db.prepare('insert into part values (?, ?, ?, ?, ?)').run('p_t', 'm_a', 'ses_1', 1002, JSON.stringify({ type: 'tool', callID: 'c1', tool: 'edit', state: { status: 'completed', input: {}, output: 'ok' } }))
    db.prepare('insert into part values (?, ?, ?, ?, ?)').run('p_x', 'm_a', 'ses_1', 1003, JSON.stringify({ type: 'text', text: 'Edited.' }))
    db.close()
    return path
  }

  it('gives new imports a prefixed id, splits text after a tool call into the next step, and reuses an earlier import', async () => {
    const path = database()
    const fresh = fakeHost()
    expect((await importOpenCodeSession(fresh.ctx, path, 'ses_1')).id).toBe(openCodeSessionId('ses_1'))
    const types = (fresh.appended[0] as Array<{ type: string }>).map(event => event.type).filter(type => type === 'assistant/message' || type === 'tool/result')
    expect(types).toEqual(['assistant/message', 'tool/result', 'assistant/message'])
    const earlier = fakeHost({ stored: ['ses_1'] })
    expect(await importOpenCodeSession(earlier.ctx, path, 'ses_1')).toMatchObject({ id: 'ses_1', reused: true })
  })
})

describe('yielding to dsh-chat-import', () => {
  function api(host: FakeHost): SessionsApi {
    let provided: SessionsApi | undefined
    startSessions(host.ctx, { provide: (_: string, value: SessionsApi) => { provided = value; return () => {} } } as never)
    return provided!
  }

  it('refuses import with a pointer to dsh-chat-import while it runs', async () => {
    const host = fakeHost({ services: { chatImport: {} } })
    const sessions = api(host)
    await expect(sessions.sessions(tempDir(), 'claude-code')).rejects.toThrow(YIELD_MESSAGE)
    expect(() => sessions.importSession('/x.jsonl', undefined, 'claude-code', undefined)).toThrow(YIELD_MESSAGE)
    expect(sessionImportStatus(host.ctx).provider).toBe('dsh-chat-import')
  })

  it('imports itself while dsh-chat-import is not there', async () => {
    const host = fakeHost()
    await expect(api(host).sessions(tempDir(), 'claude-code')).resolves.toEqual({ sessions: [] })
    expect(sessionImportStatus(host.ctx)).toMatchObject({ provider: 'harness-forge', canInstall: false, command: 'dsh plugin --profile web add dsh-chat-import' })
  })

  it('installs and enables dsh-chat-import through the plugin manager', async () => {
    const calls: unknown[] = []
    const services: Record<string, unknown> = {}
    const manager = {
      async listBundles() { return [] },
      async installBundle(spec: string, options: unknown) { calls.push(['install', spec, options]); services['chatImport'] = {}; return { changed: true, application: 'applied', stage: 'enable' } },
      async setBundleEnabled(name: string, enabled: boolean) { calls.push(['enable', name, enabled]); return { changed: true, application: 'applied' } },
    }
    services['pluginManager'] = manager
    const ctx = { get: (name: string) => services[name] } as unknown as Context
    expect(sessionImportStatus(ctx).canInstall).toBe(true)
    expect(await installChatImport(ctx)).toEqual({ application: 'applied', running: true })
    expect(calls).toEqual([['install', CHAT_IMPORT_PACKAGE, { enabled: true }]])
  })

  it('enables an installed but disabled copy instead of installing it again', async () => {
    const calls: unknown[] = []
    const manager = {
      async listBundles() { return [{ name: CHAT_IMPORT_PACKAGE, enabled: false, installed: true }] },
      async installBundle() { calls.push('install'); return { changed: true, application: 'applied' } },
      async setBundleEnabled(name: string, enabled: boolean) { calls.push(['enable', name, enabled]); return { changed: true, application: 'restart-required' } },
    }
    const ctx = { get: (name: string) => (name === 'pluginManager' ? manager : undefined) } as unknown as Context
    expect(await installChatImport(ctx)).toEqual({ application: 'restart-required', running: false })
    expect(calls).toEqual([['enable', CHAT_IMPORT_PACKAGE, true]])
  })

  it('counts an installation whose profile reports other entries failing to activate as installed', async () => {
    const manager = {
      async listBundles() { return [] },
      async installBundle() { return { changed: true, application: 'applied', bundle: CHAT_IMPORT_PACKAGE, error: { code: 'operation-error', diagnostic: 'dsh: warning: 1 entry did not activate' } } },
      async setBundleEnabled() { throw new Error('unexpected') },
    }
    const ctx = { get: (name: string) => (name === 'pluginManager' ? manager : undefined) } as unknown as Context
    expect(await installChatImport(ctx)).toEqual({ application: 'applied', running: false })
  })

  it('says why and names the command when the installation fails', async () => {
    const manager = {
      async listBundles() { return [] },
      async installBundle() { return { changed: false, application: 'failed', error: { code: 'operation-error', diagnostic: 'network down' } } },
      async setBundleEnabled() { throw new Error('unexpected') },
    }
    const ctx = { get: (name: string) => (name === 'pluginManager' ? manager : undefined) } as unknown as Context
    await expect(installChatImport(ctx)).rejects.toThrow(/network down.*dsh plugin --profile web add dsh-chat-import/u)
  })
})

describe('zstd frames', () => {
  async function decoded(path: string): Promise<string> {
    const parts: Buffer[] = []
    for await (const chunk of zstdChunks(path)) parts.push(Buffer.from(chunk))
    return Buffer.concat(parts).toString('utf8')
  }

  it('decodes every frame of a stream, skipping skippable ones, and names a truncated file', async () => {
    const dir = tempDir()
    const one = zstdCompressSync(Buffer.from('one\n'))
    const skippable = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 2, 0, 0, 0, 9, 9])
    const two = zstdCompressSync(Buffer.from('two'.repeat(1000)))
    const data = Buffer.concat([one, skippable, two])
    const whole = join(dir, 'x.zst')
    writeFileSync(whole, data)
    expect(await decoded(whole)).toBe(`one\n${'two'.repeat(1000)}`)
    const truncated = join(dir, 'cut.zst')
    writeFileSync(truncated, data.subarray(0, data.length - 3))
    await expect(decoded(truncated)).rejects.toThrow(/cut\.zst: malformed or truncated zstd data/u)
  })

  it('has one frame walker, the streaming one the import reads with (no whole-buffer decoder beside it)', () => {
    expect(Object.keys(zstd).sort()).toEqual(['decodeZstdHead', 'zstdAvailable', 'zstdChunks'])
  })
})
