import test from 'node:test'
import assert from 'node:assert/strict'
import { claudeSessionUuid, claudeTranscriptRelativePath, renderClaudeTranscript, verifyClaudeJsonl } from '../src/index.ts'
import type { ForeignSessionView } from '@dsh2claude/core'

function view(): ForeignSessionView {
  return {
    id: 'session-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    createdAt: 1000,
    cwd: 'C:\\Users\\me\\Project',
    title: 'Hello',
    events: [
      { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 1000, data: { turn: 1, step: 1 } },
      { type: 'user/message', seq: 2, time: 1000, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } },
      {
        type: 'assistant/message',
        seq: 3,
        time: 1001,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'a1',
            role: 'assistant',
            content: [
              { type: 'reasoning', text: 'private reasoning' },
              { type: 'text', text: 'hi' },
              { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' },
            ],
            source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' },
          },
          stream: [],
        },
      },
      { type: 'step/end', seq: 4, time: 1001, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 5, time: 1001, data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  }
}

test('reuses a DSH UUID and hashes anything else deterministically', () => {
  assert.equal(claudeSessionUuid('session-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'), 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
  assert.equal(claudeSessionUuid('my-session'), claudeSessionUuid('my-session'))
  assert.match(claudeSessionUuid('my-session'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('renders a validated Claude chain with string prompts and text-block tool results', () => {
  const rendered = renderClaudeTranscript(view(), 'session-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
  assert.equal(rendered.sessionUuid, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
  assert.equal(rendered.relativePath.split('\\').join('/'), 'projects/C--Users-me-Project/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl')
  assert.equal(verifyClaudeJsonl(rendered.jsonl), true)
  const lines = rendered.jsonl.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
  assert.equal(lines[0]?.type, 'mode')
  const user = lines.find((record) => record.type === 'user') as { message: { content: unknown } }
  assert.equal(user.message.content, 'hello')
  const assistant = lines.find((record) => record.type === 'assistant') as { message: { content: { type: string }[] } }
  assert.equal(assistant.message.content.length, 2)
  assert.equal(assistant.message.content[0]?.type, 'text')
  assert.equal(assistant.message.content[1]?.type, 'tool_use')
})
