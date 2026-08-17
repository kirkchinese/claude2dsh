/**
 * DSH session-log synthesis from the normalized model.
 *
 * The generated objects are plain structural `SessionEvent`s. They are
 * intentionally dependency-free here; the DSH plugin hands them to the host
 * `ctx.sessionPersistence` service, whose `@deepseek-ai/dsh-session` runtime
 * validates and freezes them.
 * @module @claude2dsh/core
 */
import type { NormalizedSession, NormalizedStep, NormalizedTurn } from './types.ts'

/** Minimal on-disk session header accepted by DSH persistence. */
export interface SynthesizedSessionMeta {
  readonly version: 0
  readonly id: string
  readonly createdAt: number
  readonly cwd?: string
  readonly delegationDepth: number
  readonly origin?: 'subagent'
  readonly parentSession?: string
}

/** Structural DSH `SessionEvent`; unknown events are never emitted here. */
export interface SynthesizedSessionEvent {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
  surfaceOp?: 'append'
  sourceEventSeqs?: number[]
}

/** Counters that prove the wire-pairing invariant. */
export interface SynthesizeStats {
  turns: number
  steps: number
  messages: number
  toolCalls: number
  toolResults: number
  synthesizedToolResults: number
}

export interface SynthesizedSession {
  readonly meta: SynthesizedSessionMeta
  readonly events: SynthesizedSessionEvent[]
  readonly stats: SynthesizeStats
}

/** Upper bound mirroring the shipped title service default (`maxTitleBytes: 80`). */
export const MAX_TITLE_BYTES = 80

const SESSION_FORMAT_VERSION = 0 as const

/** Truncate a UTF-8 string to `maxBytes` bytes without splitting a code point. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let out = ''
  let size = 0
  for (const char of text) {
    const next = Buffer.byteLength(char, 'utf8')
    if (size + next > maxBytes) break
    out += char
    size += next
  }
  return out
}

/** Normalize a source title the same way the title service normalizes user titles. */
export function normalizeTitle(title: string | undefined): string | undefined {
  const text = (title ?? '').trim().replace(/\s+/g, ' ')
  if (text.length === 0) return undefined
  return truncateUtf8(text, MAX_TITLE_BYTES)
}

function event(type: string, seq: number, time: number, data: Record<string, unknown>, surface = false): SynthesizedSessionEvent {
  const out: SynthesizedSessionEvent = { type, seq, time, data }
  if (surface) out.surfaceOp = 'append'
  return out
}

/** Stable per-session message id prefix; DSH freezes and preserves ids. */
function mid(prefix: string, kind: string, turn: number, step: number, extra = ''): string {
  const suffix = extra.length > 0 ? `:${extra}` : ''
  return `claude2dsh:${prefix}:${kind}${turn}:${step}${suffix}`
}

/** Render a normalized content block into the DSH block vocabulary. */
function renderBlock(block: NormalizedTurn['steps'][number]['content'][number]): Record<string, unknown> {
  switch (block.type) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text, ...(block.redacted === true ? { redacted: true } : {}) }
    case 'tool-call': return { type: 'tool-call', id: block.id, name: block.name, arguments: JSON.stringify(block.arguments ?? {}) }
    case 'image':
      if (block.attachment !== undefined && block.forcePlaceholder !== true) return { type: 'image', attachment: block.attachment }
      return { type: 'text', text: `[image ${block.mediaType}${block.name !== undefined ? ` ${block.name}` : ''}]` }
  }
}

/** Append events for one step, keeping every tool call followed by exactly one result. */
function synthesizeStep(
  out: SynthesizedSessionEvent[],
  sessionId: string,
  createdAt: number,
  step: NormalizedStep,
  turn: number,
  stats: SynthesizeStats,
): void {
  const stepTime = step.timestamp ?? createdAt
  const model = step.model ?? undefined
  const content = step.content.map((block) => renderBlock(block))

  const assistantSeq = out.length
  out.push(event('assistant/message', assistantSeq, stepTime, {
    turn,
    step: step.number,
    message: {
      id: mid(sessionId, 'a', turn, step.number),
      role: 'assistant',
      content,
      source: {
        kind: 'model',
        provider: 'claude-code',
        model: model ?? 'claude-code',
      },
    },
  }, true))

  const callSeqByCallId = new Map<string, number>()
  for (const call of step.toolCalls) {
    const seq = out.length
    out.push(event('tool/call', seq, stepTime, {
      turn,
      step: step.number,
      callId: call.id,
      name: call.name,
      arguments: JSON.stringify(call.arguments ?? {}),
    }))
    callSeqByCallId.set(call.id, seq)
    stats.toolCalls += 1
  }

  const resultsById = new Map<string, (typeof step.toolResults)[number]>()
  for (const result of step.toolResults) resultsById.set(result.toolCallId, result)
  let resultsPushed = 0
  for (const call of step.toolCalls) {
    const result = resultsById.get(call.id)
    if (result !== undefined) {
      pushToolResult(out, sessionId, result, turn, step.number, callSeqByCallId.get(call.id))
      resultsPushed += 1
    } else {
      // Wire invariant: an assistant with tool_calls must be followed by one
      // result per call. A source transcript that lost the result gets an
      // empty synthetic result (the same recovery shape DSH itself uses).
      const seq = out.length
      out.push({
        type: 'tool/result',
        seq,
        time: stepTime,
        data: {
          turn,
          step: step.number,
          message: {
            id: mid(sessionId, 't', turn, step.number, call.id),
            role: 'user',
            content: [{ type: 'tool-result', toolCallId: call.id, content: [] }],
            source: { kind: 'tool', callId: call.id },
          },
        },
        surfaceOp: 'append',
        sourceEventSeqs: [callSeqByCallId.get(call.id) ?? assistantSeq],
      })
      stats.toolResults += 1
      stats.synthesizedToolResults += 1
      resultsPushed += 1
    }
  }
  stats.steps += 1
  stats.messages += 1
  stats.toolResults += resultsPushed
  void model
}

function pushToolResult(
  out: SynthesizedSessionEvent[],
  sessionId: string,
  result: NormalizedStep['toolResults'][number],
  turn: number,
  step: number,
  callSeq: number | undefined,
): void {
  const content = result.content.map((block) => renderBlock(block))
  const seq = out.length
  const ev: SynthesizedSessionEvent = {
    type: 'tool/result',
    seq,
    time: result.timestamp ?? out.at(-1)?.time ?? Date.now(),
    data: {
      turn,
      step,
      message: {
        id: mid(sessionId, 'r', turn, step, result.toolCallId),
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: result.toolCallId, content, ...(result.isError === true ? { isError: true } : {}) }],
        source: { kind: 'tool', callId: result.toolCallId },
      },
    },
    surfaceOp: 'append',
  }
  if (callSeq !== undefined) ev.sourceEventSeqs = [callSeq]
  out.push(ev)
}

/**
 * Synthesize a DSH event log for one normalized session.
 * @param input - normalized session produced by an adapter.
 * @returns contiguous `seq >= 0` events and a header.
 */
export function synthesizeDshSession(input: NormalizedSession): SynthesizedSession {
  const events: SynthesizedSessionEvent[] = []
  const stats: SynthesizeStats = { turns: 0, steps: 0, messages: 0, toolCalls: 0, toolResults: 0, synthesizedToolResults: 0 }

  if (input.origin === 'subagent') {
    const firstPrompt = input.turns[0]?.prompt ?? 'Claude subagent'
    const label = normalizeTitle(input.title) ?? truncateUtf8(firstPrompt, MAX_TITLE_BYTES)
    events.push(event('subagent/descriptor', events.length, input.createdAt, {
      version: 2,
      mode: 'one-shot',
      provider: 'claude2dsh',
      label,
    }))
  }

  for (const turn of input.turns) {
    stats.turns += 1
    const turnTime = turn.timestamp ?? input.createdAt
    events.push(event('turn/start', events.length, turnTime, { turn: turn.number }))

    if (turn.steps.length === 0) {
      const seq = events.length
      events.push({
        type: 'user/message',
        seq,
        time: turnTime,
        data: {
          id: mid(input.id, 'u', turn.number, 0),
          role: 'user',
          content: turn.promptBlocks !== undefined ? turn.promptBlocks.map((block) => renderBlock(block)) : [{ type: 'text', text: turn.prompt }],
          source: { kind: 'user' },
        },
        surfaceOp: 'append',
      })
      stats.messages += 1
    } else {
      for (const step of turn.steps) {
        events.push(event('step/start', events.length, step.timestamp ?? turnTime, { turn: turn.number, step: step.number }))
        if (step.number === 1) {
          const seq = events.length
          events.push({
            type: 'user/message',
            seq,
            time: turnTime,
            data: {
              id: mid(input.id, 'u', turn.number, 1),
              role: 'user',
              content: turn.promptBlocks !== undefined ? turn.promptBlocks.map((block) => renderBlock(block)) : [{ type: 'text', text: turn.prompt }],
              source: { kind: 'user' },
            },
            surfaceOp: 'append',
          })
          stats.messages += 1
        }
        synthesizeStep(events, input.id, input.createdAt, step, turn.number, stats)
        events.push(event('step/end', events.length, step.timestamp ?? turnTime, { turn: turn.number, step: step.number }))
      }
    }

    events.push(event('turn/end', events.length, turnTime, { turn: turn.number, reason: { kind: 'completed' } }))
  }

  const title = normalizeTitle(input.title)
  if (title !== undefined) {
    events.push(event('session/title', events.length, input.createdAt, {
      title,
      messageSeqs: [],
      source: { kind: 'user' },
    }))
  }

  const meta: SynthesizedSessionMeta = {
    version: SESSION_FORMAT_VERSION,
    id: input.id,
    createdAt: input.createdAt,
    delegationDepth: input.origin === 'subagent' ? 1 : 0,
    ...(input.cwd !== undefined && input.cwd.length > 0 ? { cwd: input.cwd } : {}),
    ...(input.origin !== undefined ? { origin: input.origin } : {}),
    ...(input.parentSession !== undefined ? { parentSession: input.parentSession } : {}),
  }

  return { meta, events, stats }
}

export interface SessionTailResult {
  readonly events: SynthesizedSessionEvent[]
  readonly firstTurn: number | undefined
  readonly droppedIncompleteTurn: boolean
}

/**
 * Cut the suffix of a synthesized session log that starts at `fromTurn`.
 *
 * Events are renumbered to continue from `fromSeq`, which must equal the
 * stored event count of the target DSH log. `sourceEventSeqs` pointing into
 * the appended suffix are remapped; references to the already-stored prefix
 * keep their original seq values because those events remain addressable.
 */
export function tailSessionEvents(
  events: readonly SynthesizedSessionEvent[],
  options: { readonly fromTurn: number; readonly fromSeq: number },
): SessionTailResult {
  const fromSeq = options.fromSeq
  const fromTurn = options.fromTurn
  const startIndex = events.findIndex((event) => event.type === 'turn/start' && typeof event.data.turn === 'number' && event.data.turn >= fromTurn)
  if (startIndex < 0) return { events: [], firstTurn: undefined, droppedIncompleteTurn: false }
  const kept = events.slice(startIndex).filter((event) => event.type !== 'session/title')
  if (kept.length === 0) return { events: [], firstTurn: undefined, droppedIncompleteTurn: false }

  let lastTurnStart = -1
  let lastTurnEnd = -1
  for (let index = 0; index < kept.length; index++) {
    if (kept[index]?.type === 'turn/start') lastTurnStart = index
    else if (kept[index]?.type === 'turn/end') lastTurnEnd = index
  }
  let end = kept.length
  let droppedIncompleteTurn = false
  if (lastTurnStart > lastTurnEnd) {
    end = lastTurnStart
    droppedIncompleteTurn = true
  }
  const suffix = kept.slice(0, end)
  let firstTurn: number | undefined
  for (const event of suffix) {
    if (event.type === 'turn/start' && typeof event.data.turn === 'number') {
      firstTurn = event.data.turn
      break
    }
  }

  const oldToNew = new Map<number, number>()
  suffix.forEach((event, index) => oldToNew.set(event.seq, fromSeq + index))
  const renumbered = suffix.map((event, index) => {
    const next: SynthesizedSessionEvent = { ...event, seq: fromSeq + index }
    if (next.sourceEventSeqs !== undefined) {
      next.sourceEventSeqs = next.sourceEventSeqs.map((seq) => oldToNew.get(seq) ?? seq)
    }
    return next
  })
  return { events: renumbered, firstTurn, droppedIncompleteTurn }
}
