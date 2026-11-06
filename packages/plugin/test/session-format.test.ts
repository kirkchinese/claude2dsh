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
    const toolMessages = session.deriveMessages().filter((message) => (message as { role?: string }).role === (SESSION_FORMAT_VERSION >= 4 ? 'tool' : 'user'))
    assert.ok(toolMessages.length >= 3)
    const exported = serializeClaudeJsonl({ id: String(header.id), createdAt: header.createdAt, cwd: '/tmp/p', events: synthesized.events })
    assert.equal(exported.toolResults, 3)
    assert.equal(exported.droppedToolResults, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
