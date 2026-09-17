import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { contextWith, fakeHeader, liveContext } from './support/fake-persistence.ts'
import { Session } from '@deepseek-ai/dsh-session'
import { synthesizeDshSession } from '@claude2dsh/core'
import { readClaudeSession } from '@claude2dsh/adapter-claude-code'
import { importClaudeSessions } from '../src/session-import.ts'
import { mergeClaudeSession, mergeDshToClaude } from '../src/merge-session.ts'
import { exportClaudeSession } from '../src/export-claude.ts'
import { appendStoredEvents } from '../src/persistence.ts'

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
    const live = liveContext()
    const first = await importClaudeSessions(live as unknown as Context, { path: file }, home)
    const targetId = first.items[0]?.sessionId as string
    assert.equal(targetId, `claude-${sessionId}`)

    // DSH side grows turn 2; Claude side edits the same turn number with different content.
    const baseEvents = live.sessionPersistence.eventsOf(targetId)
    const dshTurn2 = [
      { type: 'turn/start', seq: baseEvents.length, time: 20, data: { turn: 2 } },
      { type: 'step/start', seq: baseEvents.length + 1, time: 20, data: { turn: 2, step: 1 } },
      { type: 'user/message', seq: baseEvents.length + 2, time: 20, data: { id: 'u2', role: 'user', content: [{ type: 'text', text: 'dsh-continuation' }], source: { kind: 'user' } }, surfaceOp: 'append' },
      { type: 'step/end', seq: baseEvents.length + 3, time: 20, data: { turn: 2, step: 1 } },
      { type: 'turn/end', seq: baseEvents.length + 4, time: 20, data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    await writeFile(file, [...claudeRecords('base'), { ...claudeRecords('claude-version')[1], uuid: 'x0', parentUuid: 'a1' }, { ...claudeRecords('claude-version')[2], uuid: 'x1', parentUuid: 'x0' }].map((record) => JSON.stringify(record)).join('\n') + '\n')
    await appendStoredEvents(live as unknown as Context, targetId, dshTurn2 as never)
    const createsBefore = live.sessionPersistence.createCalls

    const result = await mergeClaudeSession(live as unknown as Context, { sessionId: targetId }, home)
    assert.equal(result.status, 'merged')
    assert.equal(result.mergedSessionId, `${targetId}-merged`)
    assert.equal(result.conflicts, 1)
    assert.equal(live.sessionPersistence.createCalls, createsBefore + 1)

    const mergedId = result.mergedSessionId as string
    const mergedEvents = live.sessionPersistence.eventsOf(mergedId) as unknown as Array<{ type: string; seq: number; time: number; data: Record<string, unknown>; surfaceOp?: string }>
    assert.ok(mergedEvents.every((event, index) => event.seq === index))
    assert.ok(mergedEvents.filter((event) => event.type === 'turn/start' && event.data.turn === 2).length === 2)
    assert.equal(mergedEvents.filter((event) => event.type === 'todo/write').length, 1)
    const header = (await live.sessionPersistence.stat(mergedId as never))?.header
    assert.ok(header !== undefined)
    const session = Session.create(header.id, mergedEvents as never, header)
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
    const live = liveContext()
    await importClaudeSessions(live as unknown as Context, { path: file }, home)
    const targetId = `claude-${sessionId}`
    const baseEvents = live.sessionPersistence.eventsOf(targetId)
    const dshTurn = [{ type: 'turn/start', seq: baseEvents.length, time: 20, data: { turn: 2 } }, { type: 'turn/end', seq: baseEvents.length + 1, time: 20, data: { turn: 2, reason: { kind: 'completed' } } }]
    await appendStoredEvents(live as unknown as Context, targetId, dshTurn as never)
    await writeFile(file, [...claudeRecords(), { ...claudeRecords('next')[1], uuid: 'y0', parentUuid: 'a1' }, { ...claudeRecords('next')[2], uuid: 'y1', parentUuid: 'y0' }].map((record) => JSON.stringify(record)).join('\n') + '\n')
    const createsBefore = live.sessionPersistence.createCalls
    const result = await mergeClaudeSession(live as unknown as Context, { sessionId: targetId, dryRun: true }, home)
    assert.equal(result.status, 'dry-run')
    assert.equal(live.sessionPersistence.createCalls, createsBefore)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('dsh-to-claude merge writes a new copy and never mutates the export mapping file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-merge-export-'))
  const home = join(dir, 'dsh-home')
  const file = join(dir, `${sessionId}.jsonl`)
  try {
    await writeFile(file, claudeRecords().map((record) => JSON.stringify(record)).join('\n') + '\n')
    await mkdir(join(home, 'claude2dsh'), { recursive: true })
    await writeFile(join(home, 'claude2dsh', 'registry.json'), JSON.stringify({ version: 1, imports: {}, exports: {} }))
    const live = liveContext()
    await importClaudeSessions(live as unknown as Context, { path: file }, home)
    const targetId = `claude-${sessionId}`
    const exported = await exportClaudeSession(live as unknown as Context, { sessionId: targetId }, home)
    assert.equal(exported.status, 'exported')
    const exportFile = exported.filePath as string
    // Claude copy grows a second turn, chained from its real last record.
    const before = await readFile(exportFile, 'utf8')
    const lastRecord = before.trim().split('\n').at(-1)
    const last = lastRecord === undefined ? null : JSON.parse(lastRecord) as { uuid?: string; sessionId?: string }
    const lastUuid = last?.uuid ?? null
    const exportSessionId = last?.sessionId ?? lastUuid
    assert.ok(typeof lastUuid === 'string' && typeof exportSessionId === 'string')
    const extra = [{ ...claudeRecords('copy-next')[1], uuid: 'z0', parentUuid: lastUuid, sessionId: exportSessionId }, { ...claudeRecords('copy-next')[2], uuid: 'z1', parentUuid: 'z0', sessionId: exportSessionId }]
    await writeFile(exportFile, before.trimEnd() + '\n' + extra.map((record) => JSON.stringify(record)).join('\n') + '\n')
    // DSH grows a different turn.
    const baseEvents = live.sessionPersistence.eventsOf(targetId)
    await appendStoredEvents(live as unknown as Context, targetId, [
      { type: 'turn/start', seq: baseEvents.length, time: 30, data: { turn: 3 } },
      { type: 'turn/end', seq: baseEvents.length + 1, time: 30, data: { turn: 3, reason: { kind: 'completed' } } },
    ] as never)
    const result = await mergeDshToClaude(live as unknown as Context, { sessionId: targetId }, home)
    assert.equal(result.status, 'merged')
    assert.ok(result.filePath !== exportFile)
    assert.equal(await readFile(exportFile, 'utf8'), before.trimEnd() + '\n' + extra.map((record) => JSON.stringify(record)).join('\n') + '\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
