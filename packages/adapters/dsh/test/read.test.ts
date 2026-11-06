import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { decodeDshLog, discoverDshSessions, readDshSession } from '../src/index.ts'

const SESSION_UUID = '11111111-2222-4333-8444-555555555555'
const SESSION_ID = `session-${SESSION_UUID}`

function records(): Record<string, unknown>[] {
  return [
    { type: 'session', version: 4, id: SESSION_ID, createdAt: 1000, cwd: '/tmp/project', isSeeded: false, delegationDepth: 0 },
    { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 1000, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 2, time: 1000, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } },
    { type: 'user/message', seq: 3, time: 1001, data: { id: 'ctx', role: 'user', content: [{ type: 'text', text: 'runtime context' }], source: { kind: 'time-context' } } },
    {
      type: 'assistant/message',
      seq: 4,
      time: 1002,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'thinking' },
            { type: 'text', text: 'running' },
            { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' },
          ],
          source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' },
        },
        stream: [],
      },
    },
    { type: 'tool/call', seq: 5, time: 1003, data: { turn: 1, step: 1, callId: 'call_1', name: 'bash', arguments: '{"command":"ls"}' } },
    {
      type: 'tool/result',
      seq: 6,
      time: 1004,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'r1',
          role: 'tool',
          toolCallId: 'call_1',
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
          source: { kind: 'tool', callId: 'call_1' },
        },
      },
    },
    { type: 'step/end', seq: 7, time: 1005, data: { turn: 1, step: 1 } },
    { type: 'session/title', seq: 8, time: 1006, data: { title: 'Greeting', messageSeqs: [2], source: { kind: 'user' } } },
    { type: 'turn/end', seq: 9, time: 1007, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

async function writeSession(root: string, recordsToWrite: Record<string, unknown>[], compressed: boolean): Promise<string> {
  const dir = join(root, 'workspace', SESSION_UUID)
  await mkdir(dir, { recursive: true })
  const path = join(dir, compressed ? 'session.v4.jsonl.zstd' : 'session.v4.jsonl')
  if (compressed) {
    const first = Buffer.from(recordsToWrite.slice(0, 1).map((row) => JSON.stringify(row)).join('\n') + '\n')
    const rest = Buffer.from(recordsToWrite.slice(1).map((row) => JSON.stringify(row)).join('\n') + '\n')
    await writeFile(path, Buffer.concat([zstdCompressSync(first), zstdCompressSync(rest)]))
  } else {
    await writeFile(path, recordsToWrite.map((row) => JSON.stringify(row)).join('\n') + '\n')
  }
  return path
}

test('discovers and reads a plain v4 session, normalizing v4 tool results', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh2claude-read-'))
  const root = join(dir, 'sessions')
  try {
    await writeSession(root, records(), false)
    const found = []
    for await (const item of discoverDshSessions(root)) found.push(item)
    assert.equal(found.length, 1)
    assert.equal(found[0]?.dshId, SESSION_ID)
    assert.equal(found[0]?.version, 4)
    assert.equal(found[0]?.cwd, '/tmp/project')

    const read = await readDshSession(found[0]!)
    assert.equal(read.view.title, 'Greeting')
    assert.equal(read.view.events.filter((event) => event.type === 'turn/start').length, 1)
    assert.equal(read.stats.injectedUserMessages, 1)
    assert.equal(read.stats.toolCalls, 1)
    assert.equal(read.stats.toolResults, 1)
    const result = read.view.events.find((event) => event.type === 'tool/result')
    assert.ok(result !== undefined)
    const content = (result.data.message as { content: { type: string; toolCallId: string }[] }).content
    assert.equal(content[0]?.type, 'tool-result')
    assert.equal(content[0]?.toolCallId, 'call_1')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('folds surface replacements so only the replacement survives', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh2claude-surface-'))
  const root = join(dir, 'sessions')
  try {
    const rows = [
      { type: 'session', version: 4, id: SESSION_ID, createdAt: 1000, cwd: '/tmp/project', isSeeded: false, delegationDepth: 0 },
      { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 1000, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'original' }], source: { kind: 'user' } }, surfaceOp: 'append' },
      { type: 'assistant/message', seq: 2, time: 1001, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], source: { kind: 'model', model: 'm' } }, stream: [] } },
      { type: 'user/message', seq: 3, time: 1002, data: { id: 'u1b', role: 'user', content: [{ type: 'text', text: 'replacement' }], source: { kind: 'user' } }, surfaceOp: { op: 'replace', start: 1, end: 1 } },
      { type: 'turn/end', seq: 4, time: 1003, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    await writeSession(root, rows, false)
    const found = []
    for await (const item of discoverDshSessions(root)) found.push(item)
    const read = await readDshSession(found[0]!)
    const users = read.view.events.filter((event) => event.type === 'user/message')
    assert.equal(users.length, 1)
    assert.match(JSON.stringify(users[0]?.data), /replacement/)
    assert.equal(read.stats.surfaceReplacements, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('decodes concatenated zstd frames and reports a torn final frame', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh2claude-zstd-'))
  const root = join(dir, 'sessions')
  try {
    const path = await writeSession(root, records(), true)
    const decoded = await decodeDshLog(path)
    assert.equal(decoded.frames, 2)
    assert.equal(decoded.tornBytes, 0)
    assert.match(decoded.text, /"type":"session"/)
    assert.match(decoded.text, /"type":"turn\/end"/)

    const complete = await readFile(path)
    const extra = zstdCompressSync(Buffer.from('{"type":"turn/start","seq":10,"time":1,"data":{"turn":2}}\n'))
    await writeFile(path, Buffer.concat([complete, extra.subarray(0, Math.min(12, extra.length))]))
    const torn = await decodeDshLog(path)
    assert.equal(torn.frames, 2)
    assert.ok(torn.tornBytes > 0)
    assert.match(torn.text, /turn\/start/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
