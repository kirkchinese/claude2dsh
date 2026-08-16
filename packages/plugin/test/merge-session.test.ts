import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import { synthesizeDshSession } from '@claude2dsh/core'
import { readClaudeSession } from '@claude2dsh/adapter-claude-code'
import { importClaudeSessions } from '../src/session-import.ts'
import { mergeClaudeSession } from '../src/merge-session.ts'

const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

function claudeRecords(turnText = 'one'): Array<Record<string, unknown>> {
  return [
    { type: 'mode', mode: 'normal', sessionId },
    { type: 'user', uuid: 'u1', parentUuid: null, isSidechain: false, cwd: '/tmp/p', sessionId, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: `prompt-${turnText}` } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', isSidechain: false, cwd: '/tmp/p', sessionId, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: turnText }] } },
  ]
}

test('merge preserves both same-turn versions in a new DSH session and validates natively', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-merge-'))
  const home = join(dir, 'dsh-home')
  const file = join(dir, `${sessionId}.jsonl`)
  try {
    await writeFile(file, claudeRecords('base').map((record) => JSON.stringify(record)).join('\n') + '\n')
    await mkdir(join(home, 'claude2dsh'), { recursive: true })
    await writeFile(join(home, 'claude2dsh', 'registry.json'), JSON.stringify({ version: 1, imports: {}, exports: {} }))
    const empty = { sessionPersistence: { async list() { return [] }, async create() {}, async append() {} } }
    const first = await importClaudeSessions(empty as unknown as Context, { path: file }, home)
    const targetId = first.items[0]?.sessionId as string
    assert.equal(targetId, `claude-${sessionId}`)

    // DSH side grows turn 2; Claude side edits the same turn number with different content.
    const baseEvents = synthesizeDshSession((await readClaudeSession({ ref: file, sourceId: sessionId })).session).events
    const dshTurn2 = [
      { type: 'turn/start', seq: baseEvents.length, time: 20, data: { turn: 2 } },
      { type: 'step/start', seq: baseEvents.length + 1, time: 20, data: { turn: 2, step: 1 } },
      { type: 'user/message', seq: baseEvents.length + 2, time: 20, data: { id: 'u2', role: 'user', content: [{ type: 'text', text: 'dsh-continuation' }], source: { kind: 'user' } }, surfaceOp: 'append' },
      { type: 'step/end', seq: baseEvents.length + 3, time: 20, data: { turn: 2, step: 1 } },
      { type: 'turn/end', seq: baseEvents.length + 4, time: 20, data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    const stored = [...baseEvents, ...dshTurn2]
    await writeFile(file, [...claudeRecords('base'), { ...claudeRecords('claude-version')[1], uuid: 'x0', parentUuid: 'a1' }, { ...claudeRecords('claude-version')[2], uuid: 'x1', parentUuid: 'x0' }].map((record) => JSON.stringify(record)).join('\n') + '\n')

    const created: Array<{ id: string; events: unknown[] }> = []
    const ctx = {
      sessionPersistence: {
        async list() { return [{ id: targetId, version: 0, createdAt: 0, delegationDepth: 0 }, ...created.map((item) => ({ id: item.id, version: 0, createdAt: 0, delegationDepth: 0 }))] },
        async readFrom() { return { meta: { id: targetId, version: 0, createdAt: 0, delegationDepth: 0 }, events: stored } },
        async create() {},
        async append(id: string, events: unknown[]) {
          created.push({ id: String(id), events })
        },
      },
    }
    const result = await mergeClaudeSession(ctx as unknown as Context, { sessionId: targetId }, home)
    assert.equal(result.status, 'merged')
    assert.equal(result.mergedSessionId, `${targetId}-merged`)
    assert.equal(result.conflicts, 1)
    assert.equal(created.length, 1)

    const mergedEvents = created[0]?.events as Array<{ type: string; seq: number; time: number; data: Record<string, unknown>; surfaceOp?: string }>
    assert.ok(mergedEvents.every((event, index) => event.seq === index))
    assert.ok(mergedEvents.filter((event) => event.type === 'turn/start' && event.data.turn === 2).length === 2)
    assert.equal(mergedEvents.filter((event) => event.type === 'todo/write').length, 1)
    const session = Session.create(result.mergedSessionId as never, mergedEvents as never)
    assert.ok(session.deriveMessages().length > 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('dry-run never creates a session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-merge-dry-'))
  const home = join(dir, 'dsh-home')
  const file = join(dir, `${sessionId}.jsonl`)
  try {
    await writeFile(file, claudeRecords().map((record) => JSON.stringify(record)).join('\n') + '\n')
    await mkdir(join(home, 'claude2dsh'), { recursive: true })
    await writeFile(join(home, 'claude2dsh', 'registry.json'), JSON.stringify({ version: 1, imports: {}, exports: {} }))
    await importClaudeSessions({ sessionPersistence: { async list() { return [] }, async create() {}, async append() {} } } as unknown as Context, { path: file }, home)
    const targetId = `claude-${sessionId}`
    const baseEvents = synthesizeDshSession((await readClaudeSession({ ref: file, sourceId: sessionId })).session).events
    const dshTurn = [{ type: 'turn/start', seq: baseEvents.length, time: 20, data: { turn: 2 } }, { type: 'turn/end', seq: baseEvents.length + 1, time: 20, data: { turn: 2, reason: { kind: 'completed' } } }]
    await writeFile(file, [...claudeRecords(), { ...claudeRecords('next')[1], uuid: 'y0', parentUuid: 'a1' }, { ...claudeRecords('next')[2], uuid: 'y1', parentUuid: 'y0' }].map((record) => JSON.stringify(record)).join('\n') + '\n')
    let created = 0
    const ctx = {
      sessionPersistence: {
        async list() { return [{ id: targetId, version: 0, createdAt: 0, delegationDepth: 0 }] },
        async readFrom() { return { meta: { id: targetId, version: 0, createdAt: 0, delegationDepth: 0 }, events: [...baseEvents, ...dshTurn] } },
        async create() { created += 1 },
        async append() {},
      },
    }
    const result = await mergeClaudeSession(ctx as unknown as Context, { sessionId: targetId, dryRun: true }, home)
    assert.equal(result.status, 'dry-run')
    assert.equal(created, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
