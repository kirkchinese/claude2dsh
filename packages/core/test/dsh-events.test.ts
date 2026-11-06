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
  // The host owns the storage format version; the synthesized metadata carries
  // only adapter-side facts, and every assistant settlement carries the stream
  // field the current log format requires (empty: the source has no deltas).
  assert.equal(out.meta.delegationDepth, 0)
  assert.equal(out.events[0].seq, 0)
  for (let i = 0; i < out.events.length; i++) assert.equal(out.events[i].seq, i)
  for (const event of out.events.filter((e) => e.type === 'assistant/message')) {
    assert.deepEqual((event.data as { stream: unknown }).stream, [])
  }

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
  const synth = synthesizeDshSession(session, { subagentDescriptorVersion: 3 })
  const descriptor = synth.events.find((event) => event.type === 'subagent/descriptor')
  assert.ok(descriptor !== undefined)
  assert.deepEqual(descriptor.data, { version: 3, mode: 'one-shot', provider: 'claude2dsh', label: 'subagent work' })
  assert.equal(descriptor.seq, 0)
})

test('omitting the descriptor version emits no subagent descriptor', () => {
  const session: Parameters<typeof synthesizeDshSession>[0] = {
    id: 'claude-sub',
    source: { tool: 'claude-code', path: '/tmp/sub.jsonl', sessionId: 'sub' },
    createdAt: 1,
    origin: 'subagent',
    parentSession: 'claude-parent',
    turns: [{ number: 1, prompt: 'subagent work', steps: [] }],
  }
  const synth = synthesizeDshSession(session)
  assert.equal(synth.events.find((event) => event.type === 'subagent/descriptor'), undefined)
})

function toolSession(): NormalizedSession {
  return {
    id: 'fmt',
    source: { tool: 'claude-code', path: '/tmp/fmt.jsonl', sessionId: 'fmt' },
    createdAt: 1000,
    turns: [{
      number: 1,
      prompt: 'run',
      timestamp: 1000,
      steps: [{
        number: 1,
        timestamp: 1100,
        content: [
          { type: 'tool-call', id: 'call_ok', name: 'Bash', arguments: {} },
          { type: 'tool-call', id: 'call_lost', name: 'Read', arguments: {} },
        ],
        toolCalls: [{ id: 'call_ok', name: 'Bash', arguments: {} }, { id: 'call_lost', name: 'Read', arguments: {} }],
        toolResults: [{ toolCallId: 'call_ok', content: [{ type: 'text', text: 'boom' }], isError: true, timestamp: 1200 }],
      }],
    }],
  }
}

test('format 3 (default) wraps tool results in a user-role tool-result block', () => {
  const results = synthesizeDshSession(toolSession()).events.filter((event) => event.type === 'tool/result')
  assert.equal(results.length, 2)
  assert.deepEqual(results[0]?.data.message, {
    id: 'claude2dsh:fmt:r1:1:call_ok',
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: 'call_ok', content: [{ type: 'text', text: 'boom' }], isError: true }],
    source: { kind: 'tool', callId: 'call_ok' },
  })
})

test('format 4 writes tool-role results with direct content for real and synthesized results', () => {
  const results = synthesizeDshSession(toolSession(), { sessionFormatVersion: 4 }).events.filter((event) => event.type === 'tool/result')
  assert.equal(results.length, 2)
  assert.deepEqual(results[0]?.data.message, {
    id: 'claude2dsh:fmt:r1:1:call_ok',
    role: 'tool',
    toolCallId: 'call_ok',
    content: [{ type: 'text', text: 'boom' }],
    isError: true,
    source: { kind: 'tool', callId: 'call_ok' },
  })
  assert.deepEqual(results[1]?.data.message, {
    id: 'claude2dsh:fmt:t1:1:call_lost',
    role: 'tool',
    toolCallId: 'call_lost',
    content: [],
    source: { kind: 'tool', callId: 'call_lost' },
  })
  for (const result of results) {
    assert.equal(result.surfaceOp, 'append')
    assert.equal(result.sourceEventSeqs?.length, 1)
  }
})

test('the first step opens with an empty system head in the target format', () => {
  for (const [formatVersion, source] of [[3, { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }], [4, { kind: 'system-prompt' }]] as const) {
    const events = synthesizeDshSession(toolSession(), { sessionFormatVersion: formatVersion }).events
    assert.deepEqual(events.slice(0, 4).map((event) => event.type), ['turn/start', 'step/start', 'system/message', 'user/message'])
    const head = events[2]
    assert.equal(head?.surfaceOp, 'append')
    assert.deepEqual(head?.data, { turn: 1, step: 1, message: { id: 'claude2dsh:fmt:s1:1', role: 'system', content: [], source } })
    assert.equal(events.filter((event) => event.type === 'system/message').length, 1, 'only the first turn carries the head')
  }
})

test('a prompt-only first turn gets a step so the system head has an open step', () => {
  const session: NormalizedSession = {
    id: 'p',
    source: { tool: 'claude-code', path: '/tmp/p.jsonl', sessionId: 'p' },
    createdAt: 1,
    turns: [{ number: 1, prompt: 'hi', timestamp: 1, steps: [] }],
  }
  const events = synthesizeDshSession(session, { sessionFormatVersion: 4 }).events
  assert.deepEqual(events.map((event) => event.type), ['turn/start', 'step/start', 'system/message', 'user/message', 'step/end', 'turn/end'])
})
