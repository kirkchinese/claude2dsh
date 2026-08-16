import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
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

  let listed = false
  const mock = {
    sessionPersistence: {
      async list() {
        listed = true
        return []
      },
    },
  }
  try {
    const report = await importClaudeSessions(mock as unknown as Context, { path: file, preview: true }, join(dir, 'dsh-home'))
    assert.equal(report.total, 1)
    assert.equal(report.items[0].status, 'preview')
    assert.equal(report.items[0].turns, 1)
    assert.equal(listed, true)
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
  let appended = 0
  const live = {
    sessionPersistence: {
      async list() { return [] },
      async create() {},
      async append() { appended += 1 },
    },
  }
  const first = await importClaudeSessions(live as unknown as Context, { path: file }, home)
  assert.equal(first.items[0]?.status, 'imported')
  const targetId = first.items[0]?.sessionId as string
  // Modify source after import and make DSH look longer than the record.
  await writeFile(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n' + JSON.stringify(records[0]) + '\n')
  const stored = { events: Array.from({ length: 99 }, (_, seq) => ({ type: 'turn/end', seq, time: 1, data: {} })) }
  const mock = {
    sessionPersistence: {
      async list() { return [{ id: targetId, version: 0, createdAt: 0, delegationDepth: 0 }] },
      async readFrom() { return { meta: { id: targetId, version: 0, createdAt: 0, delegationDepth: 0 }, events: stored.events } },
      async create() { throw new Error('must not create') },
      async append() { throw new Error('must not append') },
    },
  }
  const report = await importClaudeSessions(mock as unknown as Context, { path: file }, home)
  assert.equal(report.items[0]?.status, 'conflict')
  assert.equal(appended, 1)
})
