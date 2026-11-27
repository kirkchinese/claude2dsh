import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { readCodexSession } from '../src/sessions/codex.js'
import { readOpenCodeSession } from '../src/sessions/opencode.js'
import { claudeCodeAdapter, synthesizeDshSession, type NormalizedSession } from '@kirkchinese/harness-forge-core'

const temporary: string[] = []
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }) })

type Row = Record<string, unknown>

/** Restore a log through DSH's own format catalog with full current validation, as DSH does on load. */
function restore(header: Row, events: readonly Row[]): number {
  const restoring = sessionFormatCatalog.createRestore({ type: 'session', ...header } as never, { recovery: 'strict', validation: 'current' } as never)
  for (const event of events) restoring.decodeRow(JSON.parse(JSON.stringify(event)) as never)
  return restoring.finish().events.length
}

/** The header Harness Forge's importers write (see src/sessions/claude.ts). */
function headerOf(meta: { id: string; createdAt: number; cwd?: string; delegationDepth: number }): Row {
  return { version: 4, id: meta.id, createdAt: meta.createdAt, isSeeded: false, ...(meta.cwd !== undefined ? { cwd: meta.cwd } : {}), delegationDepth: meta.delegationDepth }
}

/** DSH's first step after resuming: the live system prompt replaces the protected head. */
function resumedTurn(base: number, headSeq: number, turn: number): Row[] {
  const prompt = { id: 'live-system', role: 'system', content: [{ type: 'text', text: 'You are an agent.' }], source: { kind: 'system-prompt' } }
  return [
    { type: 'turn/start', seq: base, time: 10, data: { turn } },
    { type: 'step/start', seq: base + 1, time: 10, data: { turn, step: 1 } },
    { type: 'system/message', seq: base + 2, time: 10, data: { turn, step: 1, message: prompt }, surfaceOp: { op: 'replace', startSeq: headSeq, endSeq: headSeq }, sourceEventSeqs: [headSeq] },
    { type: 'user/message', seq: base + 3, time: 10, data: { id: 'live-user', role: 'user', content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'step/end', seq: base + 4, time: 11, data: { turn, step: 1 } },
    { type: 'turn/end', seq: base + 5, time: 11, data: { turn, reason: { kind: 'completed' } } },
  ]
}

async function claudeSession(lines: readonly Row[]): Promise<NormalizedSession> {
  const dir = mkdtempSync(join(tmpdir(), 'hf-head-'))
  temporary.push(dir)
  const id = '34343434-5656-4787-8989-010101010101'
  const file = join(dir, `${id}.jsonl`)
  writeFileSync(file, `${lines.map(line => JSON.stringify({ isSidechain: false, cwd: '/tmp/p', sessionId: id, ...line })).join('\n')}\n`)
  return (await claudeCodeAdapter.readSession({ ref: file, sourceId: id })).session
}

describe('an imported session', () => {
  it('opens with an empty protected system head, loads in DSH, and still loads after DSH resumes it', async () => {
    const session = await claudeSession([
      { type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'run both' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', model: 'm', content: [
        { type: 'tool_use', id: 'call_ok', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_use', id: 'call_lost', name: 'Read', input: { file_path: 'x' } },
      ] } },
      { type: 'user', uuid: 't1', parentUuid: 'a1', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_ok', content: 'ok' }] } },
      { type: 'assistant', uuid: 'a2', parentUuid: 't1', timestamp: '2026-01-01T00:00:03.000Z', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'done' }] } },
    ])
    const synthesized = synthesizeDshSession(session)
    const header = headerOf(synthesized.meta)
    const events = synthesized.events as unknown as Row[]
    const head = events.findIndex(event => event.type === 'system/message')
    // The head is the first node on the conversation surface.
    expect(head).toBeGreaterThan(-1)
    expect(events.findIndex(event => event.surfaceOp !== undefined)).toBe(head)
    expect(restore(header, events)).toBe(events.length)
    const resumed = resumedTurn(events.length, head, 2)
    expect(restore(header, [...events, ...resumed])).toBe(events.length + resumed.length)
  })

  it('needs that head: without it DSH refuses the log once a resumed step adds the system prompt', async () => {
    const session = await claudeSession([
      { type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'hi' }] } },
    ])
    const synthesized = synthesizeDshSession(session)
    const header = headerOf(synthesized.meta)
    const headless = (synthesized.events as unknown as Row[]).filter(event => event.type !== 'system/message').map((event, seq) => ({ ...event, seq }))
    const appended = resumedTurn(headless.length, 0, 2).map(event => (event.type === 'system/message' ? { ...event, surfaceOp: 'append', sourceEventSeqs: undefined } : event))
    for (const event of appended) delete (event as Row)['sourceEventSeqs']
    expect(() => restore(header, [...headless, ...appended])).toThrow(/protected first surface head/u)
  })

  it('gives a first turn that is only a prompt a step to hold the head (Codex and OpenCode imports use the same synthesis)', () => {
    const session: NormalizedSession = { id: 'sess-only-prompt', createdAt: 1, cwd: '/tmp/p', turns: [{ number: 1, prompt: 'just a question', steps: [] }] } as unknown as NormalizedSession
    const synthesized = synthesizeDshSession(session)
    const events = synthesized.events as unknown as Row[]
    expect(events.map(event => event.type)).toEqual(['turn/start', 'step/start', 'system/message', 'user/message', 'step/end', 'turn/end'])
    expect(restore(headerOf(synthesized.meta), events)).toBe(events.length)
  })
})

describe('every importer writes the head', () => {
  it('a Codex rollout imports, loads, and still loads after DSH resumes it', async () => {
    const { session } = await readCodexSession(join(import.meta.dirname, 'fixtures', 'codex-rollout.jsonl'))
    const synthesized = synthesizeDshSession(session)
    // The fixture was recorded on Windows (cwd C:/work); DSH requires an absolute cwd for the platform it runs on.
    const header = { ...headerOf(synthesized.meta), cwd: tmpdir() }
    const events = synthesized.events as unknown as Row[]
    const head = events.findIndex(event => event.surfaceOp !== undefined)
    expect(events[head]?.type).toBe('system/message')
    expect(restore(header, [...events, ...resumedTurn(events.length, head, 2)])).toBe(events.length + 6)
  })

  it('an OpenCode session imports, loads, and still loads after DSH resumes it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hf-head-opencode-'))
    temporary.push(dir)
    const path = join(dir, 'opencode.db')
    const db = new DatabaseSync(path)
    db.exec(`
      create table session (id text primary key, parent_id text, title text, directory text, time_created integer, time_updated integer);
      create table message (id text primary key, session_id text, time_created integer, data text);
      create table part (id text primary key, message_id text, session_id text, time_created integer, data text);
    `)
    db.prepare('insert into session values (?, ?, ?, ?, ?, ?)').run('ses_head', null, 'Head', '/tmp/p', 1000, 2000)
    db.prepare('insert into message values (?, ?, ?, ?)').run('msg_u', 'ses_head', 1001, JSON.stringify({ role: 'user', time: { created: 1001 } }))
    db.prepare('insert into part values (?, ?, ?, ?, ?)').run('part_u', 'msg_u', 'ses_head', 1001, JSON.stringify({ type: 'text', text: 'Run echo' }))
    db.prepare('insert into message values (?, ?, ?, ?)').run('msg_a', 'ses_head', 1002, JSON.stringify({ role: 'assistant', time: { created: 1002 } }))
    db.prepare('insert into part values (?, ?, ?, ?, ?)').run('part_t', 'msg_a', 'ses_head', 1003, JSON.stringify({ type: 'tool', callID: 'call-1', tool: 'bash', state: { status: 'completed', input: { command: 'echo ok' }, output: 'ok' } }))
    db.prepare('insert into part values (?, ?, ?, ?, ?)').run('part_a', 'msg_a', 'ses_head', 1004, JSON.stringify({ type: 'text', text: 'Done.' }))
    db.close()
    const { session } = await readOpenCodeSession(path, 'ses_head')
    const synthesized = synthesizeDshSession(session)
    const header = headerOf(synthesized.meta)
    const events = synthesized.events as unknown as Row[]
    const head = events.findIndex(event => event.surfaceOp !== undefined)
    expect(events[head]?.type).toBe('system/message')
    expect(restore(header, [...events, ...resumedTurn(events.length, head, 2)])).toBe(events.length + 6)
  })
})
