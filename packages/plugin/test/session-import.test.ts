import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
