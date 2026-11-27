import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { defaultOpenCodeDatabase, discoverOpenCodeSessions, importOpenCodeSession, readOpenCodeSession } from '../src/sessions/opencode.js'

const temporary: string[] = []
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-forge-opencode-'))
  temporary.push(dir)
  const path = join(dir, 'opencode.db')
  const db = new DatabaseSync(path)
  db.exec(`
    create table session (id text primary key, parent_id text, title text, directory text, time_created integer, time_updated integer);
    create table message (id text primary key, session_id text, time_created integer, data text);
    create table part (id text primary key, message_id text, session_id text, time_created integer, data text);
  `)
  db.prepare('insert into session values (?, ?, ?, ?, ?, ?)').run('ses_fixture', null, 'Fixture session', 'C:/work', 1000, 2000)
  db.prepare('insert into message values (?, ?, ?, ?)').run('msg_u', 'ses_fixture', 1001, JSON.stringify({ role: 'user', time: { created: 1001 } }))
  db.prepare('insert into part values (?, ?, ?, ?, ?)').run('part_u', 'msg_u', 'ses_fixture', 1001, JSON.stringify({ type: 'text', text: 'Run echo' }))
  db.prepare('insert into message values (?, ?, ?, ?)').run('msg_a', 'ses_fixture', 1002, JSON.stringify({ role: 'assistant', time: { created: 1002 } }))
  db.prepare('insert into part values (?, ?, ?, ?, ?)').run('part_a', 'msg_a', 'ses_fixture', 1002, JSON.stringify({ type: 'text', text: 'Calling echo.' }))
  db.prepare('insert into part values (?, ?, ?, ?, ?)').run('part_t', 'msg_a', 'ses_fixture', 1003, JSON.stringify({
    type: 'tool',
    callID: 'call-1',
    tool: 'bash',
    state: { status: 'completed', input: { command: 'echo ok' }, output: 'ok' },
  }))
  db.close()
  return path
}

function fixtureV2(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-forge-opencode-v2-'))
  temporary.push(dir)
  const path = join(dir, 'opencode.db')
  const db = new DatabaseSync(path)
  db.exec(`
    create table session_v2 (id text primary key, parent_id text, title text, directory text, time_created integer, time_updated integer);
    create table session_message (id text primary key, session_id text, type text, seq integer, time_created integer, data text);
  `)
  db.prepare('insert into session_v2 values (?, ?, ?, ?, ?, ?)').run('ses_v2', null, 'V2 fixture', 'C:/v2', 2000, 3000)
  db.prepare('insert into session_message values (?, ?, ?, ?, ?, ?)').run('msg_v2_u', 'ses_v2', 'user', 1, 2001, JSON.stringify({ text: 'Hello v2', time: { created: 2001 } }))
  db.prepare('insert into session_message values (?, ?, ?, ?, ?, ?)').run('msg_v2_a', 'ses_v2', 'assistant', 2, 2002, JSON.stringify({
    time: { created: 2002 },
    content: [
      { type: 'text', text: 'Hi v2' },
      { type: 'tool', id: 'v2-call', name: 'shell', state: { status: 'completed', input: { command: 'echo ok' }, content: [{ type: 'text', text: 'ok' }] } },
    ],
  }))
  db.close()
  return path
}

describe('OpenCode session migration', () => {
  it('reads sessions/messages/parts into normalized turns', async () => {
    const path = fixture()
    const sessions = await discoverOpenCodeSessions(path)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.source).toBe('opencode')
    const parsed = await readOpenCodeSession(path, 'ses_fixture', 'opencode-target')
    expect(parsed.session.id).toBe('opencode-target')
    expect(parsed.session.turns).toHaveLength(1)
    expect(parsed.session.turns[0]?.prompt).toBe('Run echo')
    expect(parsed.session.turns[0]?.steps[0]?.toolCalls[0]).toMatchObject({ id: 'call-1', name: 'bash' })
  })

  it('imports the session with v4 tool-role results', async () => {
    const path = fixture()
    let events: Array<{ type?: string; data?: { message?: Record<string, unknown> } }> = []
    const ctx = {
      get(name: string) {
        if (name !== 'sessionPersistence') return undefined
        return {
          async create() {
            return {
              async append(next: readonly unknown[]) { events = next as never },
              async flush() {},
              async close() {},
            }
          },
        }
      },
    }
    const report = await importOpenCodeSession(ctx as never, path, 'ses_fixture', { targetId: 'opencode-fixture' })
    expect(report.turns).toBe(1)
    expect(events.some(event => event.type === 'tool/result' && event.data?.message?.['role'] === 'tool')).toBe(true)
  })

  it('exposes the default database path without opening it during discovery', () => {
    expect(defaultOpenCodeDatabase()).toMatch(/opencode\.db$/u)
  })

  it('reads the new OpenCode v2 session/message tables', async () => {
    const path = fixtureV2()
    const sessions = await discoverOpenCodeSessions(path)
    expect(sessions[0]?.sourceId).toBe('ses_v2')
    const parsed = await readOpenCodeSession(path, 'ses_v2', 'opencode-v2-target')
    expect(parsed.session.turns[0]?.prompt).toBe('Hello v2')
    expect(parsed.session.turns[0]?.steps[0]?.content).toContainEqual({ type: 'text', text: 'Hi v2' })
    expect(parsed.session.turns[0]?.steps[0]?.toolCalls[0]).toMatchObject({ id: 'v2-call', name: 'shell' })
    expect(parsed.session.turns[0]?.steps[0]?.toolResults[0]?.content).toContainEqual({ type: 'text', text: 'ok' })
  })
})
