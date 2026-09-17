import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { contextWith, fakeHeader, liveContext } from './support/fake-persistence.ts'
import { importClaudeSessions } from '../src/session-import.ts'

test('preview mode converts without touching persistence or registry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-plugin-preview-'))
  const sessionId = '33333333-4444-4555-8666-777777777777'
  const file = join(dir, `${sessionId}.jsonl`)
  await writeFile(file, [
    { type: 'mode', mode: 'normal', sessionId },
    { type: 'user', uuid: 'u1', parentUuid: null, isSidechain: false, cwd: '/tmp/p', sessionId, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'hello' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', isSidechain: false, cwd: '/tmp/p', sessionId, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'hi' }] } },
  ].map((record) => JSON.stringify(record)).join('\n') + '\n')

  const mock = liveContext()
  try {
    const report = await importClaudeSessions(mock as unknown as Context, { path: file, preview: true }, join(dir, 'dsh-home'))
    assert.equal(report.total, 1)
    assert.equal(report.items[0].status, 'preview')
    assert.equal(report.items[0].turns, 1)
    assert.equal(mock.sessionPersistence.appendCalls, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('detects double-side growth as conflict and never appends', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-conflict-'))
  const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const file = join(dir, `${sessionId}.jsonl`)
  const records = [
    { type: 'mode', mode: 'normal', sessionId },
    { type: 'user', uuid: 'u1', parentUuid: null, isSidechain: false, cwd: '/tmp/p', sessionId, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'one' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', isSidechain: false, cwd: '/tmp/p', sessionId, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'one' }] } },
    { type: 'user', uuid: 'u2', parentUuid: 'a1', isSidechain: false, cwd: '/tmp/p', sessionId, timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'user', content: 'two' } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'u2', isSidechain: false, cwd: '/tmp/p', sessionId, timestamp: '2026-01-01T00:00:03.000Z', message: { role: 'assistant', model: 'm', content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', uuid: 't1', parentUuid: 'a2', isSidechain: false, cwd: '/tmp/p', sessionId, timestamp: '2026-01-01T00:00:04.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'ok' }] }] } },
  ]
  await writeFile(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
  const home = join(dir, 'dsh-home')
  const registryDir = join(home, 'claude2dsh')
  await mkdir(registryDir, { recursive: true })
  await writeFile(join(registryDir, 'registry.json'), JSON.stringify({ version: 1, imports: {}, exports: {} }))
  // Import once to establish a real record.
  const live = liveContext()
  const first = await importClaudeSessions(live as unknown as Context, { path: file }, home)
  assert.equal(first.items[0]?.status, 'imported')
  const appendedAfterImport = live.sessionPersistence.appendCalls
  const targetId = first.items[0]?.sessionId as string
  // Modify source after import and make DSH look longer than the record.
  await writeFile(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n' + JSON.stringify(records[0]) + '\n')
  live.sessionPersistence.seed(
    fakeHeader(targetId, { createdAt: 0 }),
    Array.from({ length: 99 }, (_, seq) => ({ type: 'turn/end', seq, time: 1, data: { turn: 1, reason: { kind: 'completed' } } })) as never[],
  )
  const report = await importClaudeSessions(live as unknown as Context, { path: file }, home)
  assert.equal(report.items[0]?.status, 'conflict')
  assert.equal(live.sessionPersistence.appendCalls, appendedAfterImport)
})

test('same-turn edits with interleaved tool results are treated as conflict when DSH also grew', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-same-turn-'))
  const sessionId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
  const file = join(dir, `${sessionId}.jsonl`)
  const records = [
    { type: 'mode', mode: 'normal', sessionId },
    { type: 'user', uuid: 'u1', parentUuid: null, isSidechain: false, cwd: '/tmp/p', sessionId, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'do work' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', isSidechain: false, cwd: '/tmp/p', sessionId, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', model: 'm', content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', uuid: 't1', parentUuid: 'a1', isSidechain: false, cwd: '/tmp/p', sessionId, timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'v1' }] }] } },
  ]
  await writeFile(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
  const home = join(dir, 'dsh-home')
  await mkdir(join(home, 'claude2dsh'), { recursive: true })
  await writeFile(join(home, 'claude2dsh', 'registry.json'), JSON.stringify({ version: 1, imports: {}, exports: {} }))
  const live = liveContext()
  await importClaudeSessions(live as unknown as Context, { path: file }, home)
  // Same turn count, changed tool result content; DSH side also grew.
  records[3] = { ...records[3], message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'v2' }] }] } }
  await writeFile(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
  const targetId = `claude-${sessionId}`
  live.sessionPersistence.seed(
    fakeHeader(targetId, { createdAt: 0 }),
    Array.from({ length: 10 }, (_, seq) => ({ type: 'turn/end', seq, time: 1, data: { turn: 1, reason: { kind: 'completed' } } })) as never[],
  )
  const report = await importClaudeSessions(live as unknown as Context, { path: file }, home)
  assert.equal(report.items[0]?.status, 'conflict')
})
