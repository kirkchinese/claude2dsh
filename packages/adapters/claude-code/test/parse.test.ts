import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { synthesizeDshSession } from '@claude2dsh/core'
import { readClaudeSession } from '../src/parse.ts'

test('normalizes Claude records using the current parent chain and merges stream chunks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-parse-'))
  const sessionId = '11111111-2222-4333-8444-555555555555'
  const file = join(dir, `${sessionId}.jsonl`)
  const prompt = 'first prompt with ide note'
  const records = [
    { type: 'mode', mode: 'normal', sessionId },
    { type: 'queue-operation', operation: 'enqueue', sessionId },
    {
      type: 'user',
      uuid: 'u1',
      parentUuid: null,
      isSidechain: false,
      cwd: '/tmp/project',
      sessionId,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: '<ide_note>' }, { type: 'text', text: prompt }] },
    },
    // Dead branch that must not become the current chain.
    {
      type: 'system',
      uuid: 'sys1',
      parentUuid: 'u1',
      isSidechain: false,
      cwd: '/tmp/project',
      sessionId,
      timestamp: '2026-01-01T00:00:05.000Z',
      message: { role: 'system', content: 'queued alternate branch' },
    },
    {
      type: 'user',
      uuid: 'alt1',
      parentUuid: 'sys1',
      isSidechain: false,
      cwd: '/tmp/project',
      sessionId,
      timestamp: '2026-01-01T00:00:06.000Z',
      message: { role: 'user', content: 'alternate prompt' },
    },
    {
      type: 'assistant',
      uuid: 'a1',
      parentUuid: 'u1',
      isSidechain: false,
      cwd: '/tmp/project',
      sessionId,
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'assistant', model: 'sonnet-test', content: [{ type: 'redacted_thinking', data: 'thinking' }] },
    },
    {
      type: 'assistant',
      uuid: 'a2',
      parentUuid: 'a1',
      isSidechain: false,
      cwd: '/tmp/project',
      sessionId,
      timestamp: '2026-01-01T00:00:02.000Z',
      message: { role: 'assistant', model: 'sonnet-test', content: [{ type: 'text', text: 'using tool' }, { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } }] },
    },
    {
      type: 'user',
      uuid: 't1',
      parentUuid: 'a2',
      isSidechain: false,
      cwd: '/tmp/project',
      sessionId,
      timestamp: '2026-01-01T00:00:03.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'ok' }], is_error: false }] },
    },
    {
      type: 'assistant',
      uuid: 'a3',
      parentUuid: 't1',
      isSidechain: false,
      cwd: '/tmp/project',
      sessionId,
      timestamp: '2026-01-01T00:00:04.000Z',
      message: { role: 'assistant', model: 'sonnet-test', content: [{ type: 'text', text: 'done' }] },
    },
  ]
  await writeFile(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
  try {
    const { session, stats } = await readClaudeSession({ ref: file, sourceId: sessionId })
    assert.equal(session.id, `claude-${sessionId}`)
    assert.equal(session.cwd, '/tmp/project')
    assert.equal(session.model, 'sonnet-test')
    assert.equal(stats.malformed, 0)
    assert.equal(stats.droppedToolResults, 0)
    assert.equal(stats.droppedUserRecords, 0)
    assert.equal(session.turns.length, 1)
    assert.equal(session.turns[0].prompt, `<ide_note>\n${prompt}`)
    assert.equal(session.turns[0].steps.length, 2)
    assert.equal(session.turns[0].steps[0].content.length, 3)
    assert.equal(session.turns[0].steps[0].toolCalls.length, 1)
    assert.equal(session.turns[0].steps[0].toolResults.length, 1)

    const synth = synthesizeDshSession(session)
    const call = synth.events.find((event) => event.type === 'tool/call')
    const result = synth.events.find((event) => event.type === 'tool/result')
    assert.ok(call)
    assert.ok(result)
    assert.equal(result.seq, call.seq + 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('synthesizes one empty result for an interrupted tool call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-interrupted-'))
  const sessionId = '22222222-3333-4444-8555-666666666666'
  const file = join(dir, `${sessionId}.jsonl`)
  const records = [
    { type: 'mode', mode: 'normal', sessionId },
    { type: 'user', uuid: 'u1', parentUuid: null, isSidechain: false, cwd: '/tmp/p', sessionId, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'do it' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', isSidechain: false, cwd: '/tmp/p', sessionId, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', model: 'm', content: [{ type: 'tool_use', id: 'call_1', name: 'Edit', input: { file_path: 'x' } }] } },
  ]
  await writeFile(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
  try {
    const { session } = await readClaudeSession({ ref: file, sourceId: sessionId })
    const synth = synthesizeDshSession(session)
    const call = synth.events.find((event) => event.type === 'tool/call')
    const result = synth.events.find((event) => event.type === 'tool/result')
    assert.ok(call)
    assert.ok(result)
    assert.equal(result.seq, call.seq + 1)
    assert.equal(synth.stats.synthesizedToolResults, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('rejects auxiliary transcripts without building a session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-aux-'))
  const file = join(dir, 'agent-abc.jsonl')
  await writeFile(file, JSON.stringify({ type: 'user', sessionId: 'different-id', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'x' } }) + '\n')
  try {
    const { session, stats } = await readClaudeSession({ ref: file, sourceId: 'agent-abc' })
    assert.equal(session.turns.length, 0)
    assert.ok(stats.reasons.some((reason) => reason.includes('does not match')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reads subagent transcripts as child sessions when allowAuxiliary is set', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-subagent-'))
  const parentSession = '44444444-5555-4666-8777-888888888888'
  const file = join(dir, 'subagents', 'agent-abc.jsonl')
  await mkdir(join(dir, 'subagents'), { recursive: true })
  await writeFile(file, [
    { type: 'user', uuid: 'u1', parentUuid: null, isSidechain: false, agentId: 'agent-abc', sessionId: parentSession, cwd: '/tmp/p', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'sub task' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', isSidechain: false, agentId: 'agent-abc', sessionId: parentSession, cwd: '/tmp/p', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'sub answer' }] } },
  ].map((record) => JSON.stringify(record)).join('\n') + '\n')
  try {
    const { session, stats } = await readClaudeSession({ ref: file, sourceId: 'agent-abc', parentSourceId: parentSession }, { allowAuxiliary: true })
    assert.equal(session.id, 'claude-agent-abc')
    assert.equal(session.origin, 'subagent')
    assert.equal(session.parentSession, `claude-${parentSession}`)
    assert.equal(session.turns.length, 1)
    assert.equal(stats.malformed, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('keeps base64 image blocks as degraded image content in user prompts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-image-'))
  const sessionId = '55555555-6666-4777-8888-999999999999'
  const file = join(dir, `${sessionId}.jsonl`)
  const records = [
    { type: 'mode', mode: 'normal', sessionId },
    { type: 'user', uuid: 'u1', parentUuid: null, isSidechain: false, cwd: '/tmp/p', sessionId, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/4AAQSkZJRgABAQAAAQABAAD' } }] } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', isSidechain: false, cwd: '/tmp/p', sessionId, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'seen' }] } },
  ]
  await writeFile(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
  try {
    const { session } = await readClaudeSession({ ref: file, sourceId: sessionId })
    assert.equal(session.turns.length, 1)
    assert.equal(session.turns[0].prompt, '[image 1]')
    assert.equal(session.turns[0].promptBlocks?.[0]?.type, 'image')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
