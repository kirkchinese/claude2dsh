import test from 'node:test'
import assert from 'node:assert/strict'
import { planTurnMerge } from '../src/turn-merge.ts'
import type { SynthesizedSessionEvent } from '../src/dsh-events.ts'

function ev(type: string, seq: number, time: number, data: Record<string, unknown> = {}): SynthesizedSessionEvent {
  return { type, seq, time, data }
}

function turn(seqStart: number, turn: number, time: number, content = 'x', side = 'a'): SynthesizedSessionEvent[] {
  return [
    ev('turn/start', seqStart, time, { turn }),
    ev('step/start', seqStart + 1, time, { turn, step: 1 }),
    ev('user/message', seqStart + 2, time, { turn, step: 1, message: { id: `${side}-${turn}`, role: 'user', content: [{ type: 'text', text: content }] } }),
    ev('step/end', seqStart + 3, time, { turn, step: 1 }),
    ev('turn/end', seqStart + 4, time, { turn, reason: { kind: 'completed' } }),
  ]
}

const base = turn(0, 1, 10).map((e, index) => ({ ...e, seq: index }))

test('orders non-conflicting growth turns by event time', () => {
  const dsh = [base, turn(5, 2, 30, 'dsh')].flat()
  const claudeTail = turn(5, 3, 20, 'claude')
  const plan = planTurnMerge(dsh, 5, claudeTail)
  assert.equal(plan.conflicts.length, 0)
  const starts = plan.events.filter((event) => event.type === 'turn/start').map((event) => event.data.turn)
  // Claude's turn is earlier, so it opens turn 2 and the DSH turn becomes 3.
  assert.deepEqual(starts, [1, 2, 3])
  const texts = plan.events.filter((event) => event.type === 'user/message').map((event) => (event.data as { message?: { content?: { text?: string }[] } }).message?.content?.[0]?.text)
  assert.deepEqual(texts, ['x', 'claude', 'dsh'])
  for (const event of plan.events) {
    if (typeof event.data.turn === 'number' && event.seq >= 5) assert.ok(event.data.turn === 2 || event.data.turn === 3)
  }
  assert.deepEqual(plan.events.map((event) => event.seq), Array.from({ length: plan.events.length }, (_, index) => index))
})

test('same-turn dual edits preserve both complete turns and a conflict marker', () => {
  const dsh = [base, turn(5, 2, 30, 'dsh-version', 'dsh')].flat()
  const claudeTail = turn(5, 2, 20, 'claude-version', 'claude')
  const plan = planTurnMerge(dsh, 5, claudeTail)
  assert.equal(plan.conflicts.length, 1)
  assert.equal(plan.conflicts[0]?.turn, 2)
  const turnStarts = plan.events.filter((event) => event.type === 'turn/start').map((event) => ({ turn: event.data.turn, seq: event.seq }))
  assert.deepEqual(turnStarts.map((item) => item.turn), [1, 2, 3], 'both versions occupy consecutive turns')
  const marker = plan.events.filter((event) => event.type === 'todo/write')
  assert.equal(marker.length, 1)
  assert.match(String((marker[0]?.data as { todos?: { content?: string }[] }).todos?.[0]?.content), /\[conflict\] turn 2/)
  const userMessages = plan.events.filter((event) => event.type === 'user/message')
  assert.ok(userMessages.some((event) => String((event.data as { message?: { content?: { text?: string }[] } }).message?.content?.[0]?.text).includes('dsh-version')))
  assert.ok(userMessages.some((event) => String((event.data as { message?: { content?: { text?: string }[] } }).message?.content?.[0]?.text).includes('claude-version')))
})

test('interleaved tool call and result stay inside one turn block', () => {
  const dshGrowth = [
    ev('turn/start', 5, 30, { turn: 2 }),
    ev('step/start', 6, 30, { turn: 2, step: 1 }),
    ev('user/message', 7, 30, { turn: 2, step: 1, message: { id: 'u2', role: 'user', content: [{ type: 'text', text: 'go' }] } }),
    ev('assistant/message', 8, 30, { turn: 2, step: 1, message: { id: 'a2', role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'Bash', arguments: '{}' }] } }),
    ev('tool/call', 9, 30, { turn: 2, step: 1, callId: 'c1', name: 'Bash', arguments: '{}' }),
    ev('tool/result', 10, 30, { turn: 2, step: 1, message: { id: 'r2', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [] }] } }, undefined, undefined) as SynthesizedSessionEvent,
    ev('step/end', 11, 30, { turn: 2, step: 1 }),
    ev('turn/end', 12, 30, { turn: 2, reason: { kind: 'completed' } }),
  ]
  const dsh = [...base, ...dshGrowth]
  const claudeTail = turn(5, 3, 20, 'claude-turn')
  const plan = planTurnMerge(dsh, 5, claudeTail)
  assert.equal(plan.conflicts.length, 0)
  const indexes = new Map(plan.events.map((event, index) => [event.seq, index]))
  const claudeStart = plan.events.findIndex((event) => event.type === 'turn/start' && event.data.turn === 2)
  const dshStart = plan.events.findIndex((event) => event.type === 'turn/start' && event.data.turn === 3)
  assert.ok(claudeStart >= 0 && claudeStart < dshStart)
  const dshTurnEvents = plan.events.slice(dshStart, plan.events.findIndex((event, index) => index > dshStart && event.type === 'turn/end') + 1)
  assert.ok(dshTurnEvents.every((event) => event.data.turn === undefined || event.data.turn === 3))
  const toolResult = plan.events.find((event) => event.type === 'tool/result')
  assert.ok(toolResult !== undefined)
  assert.ok((toolResult?.sourceEventSeqs ?? []).every((seq) => indexes.has(seq)))
})

test('an incomplete final DSH turn never enters the merged plan', () => {
  const dsh = [...base, ev('turn/start', 5, 30, { turn: 2 }), ev('user/message', 6, 30, { turn: 2, step: 1, message: {} })]
  const claudeTail = turn(5, 2, 20, 'claude')
  const plan = planTurnMerge(dsh, 5, claudeTail)
  assert.equal(plan.droppedIncompleteDshTurns, 1)
  assert.equal(plan.conflicts.length, 0)
  assert.equal(plan.events.filter((event) => event.type === 'turn/start').length, 2)
})

test('source references resolve against the side that produced the citing event', () => {
  const callResult = (seqStart: number, turnNo: number, time: number, callId: string): SynthesizedSessionEvent[] => [
    ev('turn/start', seqStart, time, { turn: turnNo }),
    ev('step/start', seqStart + 1, time, { turn: turnNo, step: 1 }),
    ev('tool/call', seqStart + 2, time, { turn: turnNo, step: 1, callId, name: 'Bash', arguments: '{}' }),
    { ...ev('tool/result', seqStart + 3, time, { turn: turnNo, step: 1, message: { id: `r-${callId}`, role: 'tool', toolCallId: callId, content: [] } }), sourceEventSeqs: [seqStart + 2] },
    ev('step/end', seqStart + 4, time, { turn: turnNo, step: 1 }),
    ev('turn/end', seqStart + 5, time, { turn: turnNo, reason: { kind: 'completed' } }),
  ]
  const dsh = [...base, ...callResult(5, 2, 20, 'dsh-call')]
  const claudeTail = callResult(5, 2, 30, 'claude-call')
  const plan = planTurnMerge(dsh, 5, claudeTail)
  for (const result of plan.events.filter((event) => event.type === 'tool/result')) {
    const callId = (result.data.message as { toolCallId: string }).toolCallId
    const cited = plan.events[result.sourceEventSeqs?.[0] ?? -1]
    assert.equal(cited?.type, 'tool/call')
    assert.equal(cited?.data.callId, callId)
    assert.equal(cited?.data.turn, result.data.turn)
  }
})
