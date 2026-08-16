import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { importClaudeSessions } from '../src/session-import.ts'
import { loadSessionSourceMap } from '../src/session-sources.ts'

test('import records claude-main and claude-subagent source markers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-sources-'))
  const home = join(dir, 'dsh-home')
  const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const main = join(dir, `${sessionId}.jsonl`)
  const sub = join(dir, sessionId, 'subagents', 'agent-1.jsonl')
  const records = [
    { type: 'mode', mode: 'normal', sessionId },
    { type: 'user', uuid: 'u1', parentUuid: null, isSidechain: false, cwd: '/tmp/p', sessionId, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'hello' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', isSidechain: false, cwd: '/tmp/p', sessionId, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'hi' }] } },
  ]
  try {
    await mkdir(join(dir, sessionId, 'subagents'), { recursive: true })
    await writeFile(main, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
    const subRecords = records.map((record) => ({ ...record, sessionId, isSidechain: true }))
    await writeFile(sub, subRecords.map((record) => JSON.stringify(record)).join('\n') + '\n')
    const mock = { sessionPersistence: { async list() { return [] }, async create() {}, async append() {} } }
    const report = await importClaudeSessions(mock as unknown as Context, { path: dir, recursive: true, includeSubagents: true }, home)
    assert.equal(report.imported, 2)
    const map = await loadSessionSourceMap(home)
    assert.equal(map.sessions[`claude-${sessionId}`]?.kind, 'claude-main')
    const subRecord = Object.values(map.sessions).find((record) => record.kind === 'claude-subagent')
    assert.ok(subRecord !== undefined)
    assert.ok(subRecord.sourcePath.endsWith('/subagents/agent-1.jsonl'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
