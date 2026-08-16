import test from 'node:test'
import assert from 'node:assert/strict'
import { synthesizeDshSession, tailSessionEvents } from '../src/dsh-events.ts'
import type { NormalizedSession } from '../src/types.ts'

function makeSession(): NormalizedSession {
  return {
    id: 'tail-test',
    source: { tool: 'claude-code' },
    createdAt: 1000,
    turns: [
      {
        number: 1,
        prompt: 'one',
        timestamp: 1000,
        steps: [{ number: 1, timestamp: 1100, content: [{ type: 'text', text: 'a' }], toolCalls: [], toolResults: [] }],
      },
      {
        number: 2,
        prompt: 'two',
        timestamp: 2000,
        steps: [{ number: 1, timestamp: 2100, content: [{ type: 'tool-call', id: 'call_2', name: 'Bash', arguments: {} }], toolCalls: [{ id: 'call_2', name: 'Bash', arguments: {} }], toolResults: [] }],
      },
      {
        number: 3,
        prompt: 'three-open',
        timestamp: 3000,
        steps: [{ number: 1, timestamp: 3100, content: [{ type: 'text', text: 'c' }], toolCalls: [], toolResults: [] }],
      },
    ],
  }
}

test('tail renumbers from stored seq and remaps internal source refs', () => {
  const synth = synthesizeDshSession(makeSession())
  const tail = tailSessionEvents(synth.events, { fromTurn: 2, fromSeq: 17 })
  assert.equal(tail.firstTurn, 2)
  assert.equal(tail.events[0].seq, 17)
  for (let i = 0; i < tail.events.length; i++) assert.equal(tail.events[i].seq, 17 + i)
  const result = tail.events.find((event) => event.type === 'tool/result')
  const call = tail.events.find((event) => event.type === 'tool/call')
  assert.ok(result)
  assert.ok(call)
  assert.equal(result.sourceEventSeqs?.[0], call.seq)
})

test('tail drops an incomplete final turn', () => {
  const synth = synthesizeDshSession(makeSession())
  const incomplete = synth.events.filter((event) => !(event.type === 'turn/end' && event.data.turn === 3))
  const tail = tailSessionEvents(incomplete, { fromTurn: 3, fromSeq: 30 })
  assert.equal(tail.droppedIncompleteTurn, true)
  assert.equal(tail.events.length, 0)
})
