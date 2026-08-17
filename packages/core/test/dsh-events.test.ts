import test from 'node:test'
import assert from 'node:assert/strict'
import { synthesizeDshSession } from '../src/dsh-events.ts'
import type { NormalizedSession } from '../src/types.ts'

test('synthesizes balanced turn/step/tool pairs with contiguous seq', () => {
  const session: NormalizedSession = {
    id: 's1',
    source: { tool: 'claude-code', path: '/tmp/a.jsonl', sessionId: 's1' },
    createdAt: 1000,
    cwd: '/tmp/project',
    title: 'Hello world',
    model: 'sonnet',
    turns: [
      {
        number: 1,
        prompt: 'do work',
        timestamp: 1000,
        steps: [
          {
            number: 1,
            timestamp: 1100,
            model: 'sonnet',
            content: [
              { type: 'text', text: 'thinking...' },
              { type: 'tool-call', id: 'call_1', name: 'Bash', arguments: { command: 'ls' } },
            ],
            toolCalls: [{ id: 'call_1', name: 'Bash', arguments: { command: 'ls' } }],
            toolResults: [
              { toolCallId: 'call_1', content: [{ type: 'text', text: 'ok' }], timestamp: 1200 },
            ],
          },
          {
            number: 2,
            timestamp: 1300,
            model: 'sonnet',
            content: [{ type: 'text', text: 'done' }],
            toolCalls: [],
            toolResults: [],
          },
        ],
      },
      {
        number: 2,
        prompt: 'again',
        timestamp: 2000,
        steps: [
          {
            number: 1,
            timestamp: 2100,
            model: 'sonnet',
            content: [{ type: 'tool-call', id: 'call_2', name: 'Read', arguments: { file_path: 'x' } }],
            toolCalls: [{ id: 'call_2', name: 'Read', arguments: { file_path: 'x' } }],
            toolResults: [],
          },
        ],
      },
    ],
  }

  const out = synthesizeDshSession(session)
  assert.equal(out.meta.version, 0)
  assert.equal(out.meta.delegationDepth, 0)
  assert.equal(out.events[0].seq, 0)
  for (let i = 0; i < out.events.length; i++) assert.equal(out.events[i].seq, i)

  const calls = out.events.filter((e) => e.type === 'tool/call')
  const results = out.events.filter((e) => e.type === 'tool/result')
  assert.equal(calls.length, 2)
  assert.equal(results.length, 2)
  assert.equal(out.stats.synthesizedToolResults, 1)

  const call2 = calls.find((e) => (e.data as { callId: string }).callId === 'call_2')
  const result2 = results.find((e) => ((e.data as { message: { content: { toolCallId: string }[] } }).message.content[0].toolCallId === 'call_2'))
  assert.ok(call2)
  assert.ok(result2)
  assert.equal(result2.seq, (call2?.seq ?? -1) + 1)
})

test('truncates titles by UTF-8 bytes and normalizes whitespace', () => {
  const title = 'a'.repeat(90)
  const session: NormalizedSession = {
    id: 's2',
    source: { tool: 'claude-code' },
    createdAt: 0,
    turns: [],
    title,
  }
  const out = synthesizeDshSession(session)
  const titleEvent = out.events.find((e) => e.type === 'session/title')
  assert.ok(titleEvent)
  const data = titleEvent.data as { title: string }
  assert.ok(Buffer.byteLength(data.title, 'utf8') <= 80)
})

test('subagent synthesis prepends a one-shot subagent descriptor', () => {
  const session: Parameters<typeof synthesizeDshSession>[0] = {
    id: 'claude-sub',
    source: { tool: 'claude-code', path: '/tmp/sub.jsonl', sessionId: 'sub' },
    createdAt: 1,
    origin: 'subagent',
    parentSession: 'claude-parent',
    turns: [{ number: 1, prompt: 'subagent work', steps: [] }],
  }
  const synth = synthesizeDshSession(session)
  const descriptor = synth.events.find((event) => event.type === 'subagent/descriptor')
  assert.ok(descriptor !== undefined)
  assert.deepEqual(descriptor.data, { version: 2, mode: 'one-shot', provider: 'claude2dsh', label: 'subagent work' })
  assert.equal(descriptor.seq, 0)
})
