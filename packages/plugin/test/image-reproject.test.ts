import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { saveImageMap } from '../src/image-map.ts'
import { registerImageReprojection } from '../src/image-reproject.ts'

test('re-projects placeholder image nodes to native image blocks for an image-capable model', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-reproject-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = join(dir, 'dsh-home')
  const sessionId = 'img-session'
  await saveImageMap(sessionId, [{
    seq: 4,
    messageId: `claude2dsh:${sessionId}:u1:1`,
    mode: 'placeholder',
    images: [{ mediaType: 'image/jpeg' as const, attachment: { attachmentId: 'sha256:a', mediaType: 'image/jpeg' as const, bytes: 3, width: 1, height: 1 } }],
  }], join(dir, 'dsh-home'))

  let captured: ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined
  const ctx = {
    llm: { async resolveModelInfo() { return { inputModalities: ['text', 'image'] } } },
    on(_name: string, listener: typeof captured) { captured = listener; return () => true },
  }
  registerImageReprojection(ctx as unknown as Context)
  assert.ok(captured)
  const appends: Array<{ type: string; data: Record<string, unknown>; opts?: unknown }> = []
  const agent = {
    id: sessionId,
    options: { provider: 'vision', model: 'v1' },
    session: { append(type: string, data: Record<string, unknown>, opts?: unknown) { appends.push({ type, data, opts }) } },
  }
  await captured?.({ agent }, async () => 'next')
  assert.equal(appends.length, 1)
  assert.equal(appends[0].type, 'user/message')
  assert.deepEqual(appends[0].opts, { surfaceOp: { op: 'replace', start: 4, end: 4 }, sourceEventSeqs: [4] })
  assert.equal((appends[0].data.content as Array<{ type: string }>)[0]?.type, 'image')
  await rm(dir, { recursive: true, force: true })
  if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
})
