import test from 'node:test'
import assert from 'node:assert/strict'
import { serializeClaudeJsonl, serializeClaudeJsonlTail } from '../src/serialize.ts'

test('serializes DSH events into a Claude JSONL chain with tool_result parenting', () => {
  let counter = 0
  const uuid = () => `uuid-${counter++}`
  const events = [
    { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 1000, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 2, time: 1000, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 3, time: 1100, data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'thinking' }, { type: 'tool-call', id: 'call_1', name: 'Bash', arguments: '{"command":"ls"}' }], source: { kind: 'model', provider: 'p', model: 'm' } } } },
    { type: 'tool/result', seq: 4, time: 1200, data: { turn: 1, step: 1, message: { id: 't1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'ok' }] }], source: { kind: 'tool', callId: 'call_1' } } } },
    { type: 'assistant/message', seq: 5, time: 1300, data: { turn: 1, step: 1, message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'done' }], source: { kind: 'model', provider: 'p', model: 'm' } } } },
    { type: 'step/end', seq: 6, time: 1300, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 7, time: 1300, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const out = serializeClaudeJsonl({ id: 'ds', createdAt: 1000, cwd: '/tmp/project', events }, { uuid })
  const records = out.jsonl.trimEnd().split('\n').map((line) => JSON.parse(line))
  assert.equal(records[0].type, 'mode')
  assert.equal(records[1].type, 'permission-mode')
  assert.equal(records[2].type, 'user')
  assert.equal(records[2].parentUuid, null)
  assert.equal(records[3].type, 'assistant')
  assert.equal(records[4].type, 'user')
  assert.equal(records[4].message.content[0].type, 'tool_result')
  assert.equal(records[4].parentUuid, records[3].uuid)
  assert.equal(records[4].sourceToolAssistantUUID, records[3].uuid)
  assert.equal(records[5].parentUuid, records[4].uuid)
  assert.equal(out.droppedToolResults, 0)
})

test('refuses to fabricate a parent for orphan tool results', () => {
  const events = [
    { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 1000, data: { content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } } },
    { type: 'tool/result', seq: 2, time: 1100, data: { message: { content: [{ type: 'tool-result', toolCallId: 'missing', content: [{ type: 'text', text: 'x' }] }] } } },
  ]
  const out = serializeClaudeJsonl({ id: 'ds', createdAt: 1000, cwd: '/tmp/p', events }, { uuid: () => 'u' })
  assert.equal(out.droppedToolResults, 1)
  assert.equal(out.toolResults, 0)
})

test('tail serializer emits a headless append continuing an anchor uuid', () => {
  let counter = 0
  const uuid = () => `t-${counter++}`
  const events = [
    { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 1000, data: { content: [{ type: 'text', text: 'old' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 2, time: 1100, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'old-a' }], source: { kind: 'model', model: 'm' } } } },
    { type: 'turn/end', seq: 3, time: 1100, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', seq: 4, time: 2000, data: { turn: 2 } },
    { type: 'user/message', seq: 5, time: 2000, data: { content: [{ type: 'text', text: 'new' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 6, time: 2100, data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'new-a' }], source: { kind: 'model', model: 'm' } } } },
    { type: 'turn/end', seq: 7, time: 2100, data: { turn: 2, reason: { kind: 'completed' } } },
  ]
  const out = serializeClaudeJsonlTail({ id: 'ds', createdAt: 1000, cwd: '/tmp/p', events }, { fromSeq: 4, sessionUuid: 'existing-session', anchorUuid: 'anchor-uuid', uuid })
  const records = out.jsonl.trimEnd().split('\n').map((line) => JSON.parse(line))
  assert.equal(records[0].type, 'user')
  assert.equal(records[0].sessionId, 'existing-session')
  assert.equal(records[0].parentUuid, 'anchor-uuid')
  assert.equal(records[1].parentUuid, records[0].uuid)
  assert.equal(out.lastUuid, records[1].uuid)
})
