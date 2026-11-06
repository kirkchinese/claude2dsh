import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SESSION_FORMAT_VERSION, Session, type SessionEvent, type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session'
import { SUBAGENT_DESCRIPTOR_VERSION } from '@deepseek-ai/dsh-subagent'
import { synthesizeDshSession } from '@claude2dsh/core'
import { readClaudeSession, serializeClaudeJsonl } from '@claude2dsh/adapter-claude-code'
import { importedSessionHeader } from '../src/session-header.ts'
import { SUPPORTED_SESSION_FORMAT_VERSIONS } from '../src/compat.ts'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'

/** Restore a log through the installed format catalog with full current validation, as DSH does on load. */
function restoreStored(header: Record<string, unknown>, events: readonly Record<string, unknown>[]): number {
  const restore = sessionFormatCatalog.createRestore({ type: 'session', ...header } as never, { recovery: 'strict', validation: 'current' })
  for (const event of events) restore.decodeRow(JSON.parse(JSON.stringify(event)) as never)
  return restore.finish().events.length
}

test('the installed host format is one this build writes', () => {
  assert.ok(SUPPORTED_SESSION_FORMAT_VERSIONS.includes(SESSION_FORMAT_VERSION))
})

test('a synthesized session with real, failed and lost tool results restores in the installed Session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-format-'))
  const sessionId = '12121212-3434-4565-8787-909090909090'
  const file = join(dir, `${sessionId}.jsonl`)
  await writeFile(file, [
    { type: 'user', uuid: 'u1', parentUuid: null, isSidechain: false, cwd: '/tmp/p', sessionId, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'run both' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', isSidechain: false, cwd: '/tmp/p', sessionId, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', model: 'm', content: [
      { type: 'tool_use', id: 'call_ok', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_use', id: 'call_err', name: 'Bash', input: { command: 'false' } },
      { type: 'tool_use', id: 'call_lost', name: 'Read', input: { file_path: 'x' } },
    ] } },
    { type: 'user', uuid: 't1', parentUuid: 'a1', isSidechain: false, cwd: '/tmp/p', sessionId, timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'call_ok', content: [{ type: 'text', text: 'ok' }] },
      { type: 'tool_result', tool_use_id: 'call_err', content: 'exit 1', is_error: true },
    ] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 't1', isSidechain: false, cwd: '/tmp/p', sessionId, timestamp: '2026-01-01T00:00:03.000Z', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'done' }] } },
  ].map((record) => JSON.stringify(record)).join('\n') + '\n')
  try {
    const parsed = await readClaudeSession({ ref: file, sourceId: sessionId })
    const synthesized = synthesizeDshSession(parsed.session, { subagentDescriptorVersion: SUBAGENT_DESCRIPTOR_VERSION, sessionFormatVersion: SESSION_FORMAT_VERSION })
    const header = { delegationDepth: 0, ...importedSessionHeader(synthesized.meta, synthesized.meta.id) } as unknown as SessionHeader
    const events = JSON.parse(JSON.stringify(synthesized.events)) as SessionEvent[]
    const session = Session.create(header.id as SessionId, events as never, header)
    assert.equal(restoreStored(header as unknown as Record<string, unknown>, events as unknown as Record<string, unknown>[]), events.length)
    const toolMessages = session.deriveMessages().filter((message) => (message as { role?: string }).role === (SESSION_FORMAT_VERSION >= 4 ? 'tool' : 'user'))
    assert.ok(toolMessages.length >= 3)
    const exported = serializeClaudeJsonl({ id: String(header.id), createdAt: header.createdAt, cwd: '/tmp/p', events: synthesized.events })
    assert.equal(exported.toolResults, 3)
    assert.equal(exported.droppedToolResults, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an imported session still restores after DSH resumes it and rewrites the system head', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-resume-'))
  const sessionId = '34343434-5656-4787-8989-010101010101'
  const file = join(dir, `${sessionId}.jsonl`)
  await writeFile(file, [
    { type: 'user', uuid: 'u1', parentUuid: null, isSidechain: false, cwd: '/tmp/p', sessionId, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'hello' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', isSidechain: false, cwd: '/tmp/p', sessionId, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'hi' }] } },
  ].map((record) => JSON.stringify(record)).join('\n') + '\n')
  try {
    const parsed = await readClaudeSession({ ref: file, sourceId: sessionId })
    const synthesized = synthesizeDshSession(parsed.session, { subagentDescriptorVersion: SUBAGENT_DESCRIPTOR_VERSION, sessionFormatVersion: SESSION_FORMAT_VERSION })
    const header = { delegationDepth: 0, ...importedSessionHeader(synthesized.meta, synthesized.meta.id) } as Record<string, unknown>
    const imported = synthesized.events as unknown as Record<string, unknown>[]
    assert.equal(restoreStored(header, imported), imported.length)
    const headSeq = imported.findIndex((event) => event.type === 'system/message')
    assert.ok(headSeq >= 0)
    // The agent loop's first resumed step replaces the protected head with the live prompt.
    const base = imported.length
    const prompt = { id: 'live-system', role: 'system', content: [{ type: 'text', text: 'You are an agent.' }], source: { kind: 'system-prompt' } }
    const resumed = [
      { type: 'turn/start', seq: base, time: 10, data: { turn: 2 } },
      { type: 'step/start', seq: base + 1, time: 10, data: { turn: 2, step: 1 } },
      { type: 'system/message', seq: base + 2, time: 10, data: { turn: 2, step: 1, message: prompt }, surfaceOp: { op: 'replace', startSeq: headSeq, endSeq: headSeq }, sourceEventSeqs: [headSeq] },
      { type: 'user/message', seq: base + 3, time: 10, data: { id: 'live-user', role: 'user', content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }, surfaceOp: 'append' },
      { type: 'step/end', seq: base + 4, time: 11, data: { turn: 2, step: 1 } },
      { type: 'turn/end', seq: base + 5, time: 11, data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    assert.equal(restoreStored(header, [...imported, ...resumed]), base + resumed.length)
    // Without a head, the same step would have to append a system message, which DSH refuses on load.
    const headless = imported.filter((event) => event.type !== 'system/message').map((event, seq) => ({ ...event, seq, ...(event.sourceEventSeqs !== undefined ? { sourceEventSeqs: (event.sourceEventSeqs as number[]).map((source) => source > headSeq ? source - 1 : source) } : {}) }))
    const appended = { ...resumed[2], seq: headless.length + 2, surfaceOp: 'append', sourceEventSeqs: undefined }
    delete (appended as Record<string, unknown>).sourceEventSeqs
    const broken = [...resumed.slice(0, 2), appended, ...resumed.slice(3)].map((event, index) => ({ ...event, seq: headless.length + index }))
    assert.throws(() => restoreStored(header, [...headless, ...broken]), /protected first surface head/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
