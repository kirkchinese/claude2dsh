/**
 * DSH session-log synthesis from the normalized model.
 *
 * The generated objects are plain structural `SessionEvent`s. They are
 * intentionally dependency-free here; the DSH plugin hands them to the host
 * `ctx.sessionPersistence` service, whose `@deepseek-ai/dsh-session` runtime
 * validates and freezes them.
 * @module @kirkchinese/harness-forge-core
 */
import type { NormalizedSession, NormalizedStep, NormalizedTurn } from './model.js'

/** Session metadata an importer supplies; the host stamps its own format version. */
export interface SynthesizedSessionMeta {
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

/** Host-owned stamps the importer supplies because they are protocol constants. */
export interface SynthesizeOptions {
  /**
   * `subagent/descriptor` format version the target host reads. Omitted, no
   * descriptor is emitted — correct for a session that is not a delegated child,
   * and for a host that has no subagent descriptor vocabulary at all.
   */
  readonly subagentDescriptorVersion?: number
}

/** Upper bound mirroring the shipped title service default (`maxTitleBytes: 80`). */
export const MAX_TITLE_BYTES = 80

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
  // `claude2dsh:` is a wire-format id kept for dedupe with sessions imported earlier; do not rename.
  return `claude2dsh:${prefix}:${kind}${turn}:${step}${suffix}`
}

/**
 * The empty system-prompt head placed as the first surface node of turn 1, step 1.
 *
 * DSH treats the first surface `system/message` as the protected system head: on a resumed
 * session the agent loop replaces that node with the live prompt, and appends one only to an
 * empty surface. A transcript from another harness has no system prompt; without this head the
 * first resumed step appends a `system/message` behind the imported history, and the stored
 * log no longer loads ("system/message requires a protected first surface head"). Empty content
 * renders no model message, so the imported conversation is unchanged.
 * Contributed by HollowMan6.
 */
function systemHead(sessionId: string, seq: number, time: number, turn: number, step: number): SynthesizedSessionEvent {
  return {
    type: 'system/message',
    seq,
    time,
    data: { turn, step, message: { id: mid(sessionId, 's', turn, step), role: 'system', content: [], source: { kind: 'system-prompt' } } },
    surfaceOp: 'append',
  }
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
        model: step.model ?? 'claude-code',
      },
    },
    // A Claude transcript stores only the assembled reply, never its deltas, so
    // the imported settlement records an empty model stream: consumers that fold
    // it (token usage, first-token timing, stats) read "no streamed chunks"
    // instead of a fabricated timing trace.
    stream: [],
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
        data: { turn, step: step.number, message: toolMessage(mid(sessionId, 't', turn, step.number, call.id), call.id, []) },
        surfaceOp: 'append',
        sourceEventSeqs: [callSeqByCallId.get(call.id) ?? assistantSeq],
      })
      stats.synthesizedToolResults += 1
      resultsPushed += 1
    }
  }
  stats.steps += 1
  stats.messages += 1
  stats.toolResults += resultsPushed
}

/** A DSH v4 first-class tool-role message. */
function toolMessage(id: string, callId: string, content: Record<string, unknown>[], isError = false): Record<string, unknown> {
  return { id, role: 'tool', toolCallId: callId, content, source: { kind: 'tool', callId }, ...(isError ? { isError: true } : {}) }
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
    data: { turn, step, message: toolMessage(mid(sessionId, 'r', turn, step, result.toolCallId), result.toolCallId, content, result.isError === true) },
    surfaceOp: 'append',
  }
  if (callSeq !== undefined) ev.sourceEventSeqs = [callSeq]
  out.push(ev)
}

/**
 * Synthesize a DSH event log for one normalized session.
 * @param input - normalized session produced by an adapter.
 * @param options - host-owned protocol stamps; see {@link SynthesizeOptions}.
 * @returns contiguous `seq >= 0` events and a header.
 */
export function synthesizeDshSession(input: NormalizedSession, options: SynthesizeOptions = {}): SynthesizedSession {
  const events: SynthesizedSessionEvent[] = []
  const stats: SynthesizeStats = { turns: 0, steps: 0, messages: 0, toolCalls: 0, toolResults: 0, synthesizedToolResults: 0 }

  if (input.origin === 'subagent' && options.subagentDescriptorVersion !== undefined) {
    const firstPrompt = input.turns[0]?.prompt ?? 'Claude subagent'
    const label = normalizeTitle(input.title) ?? truncateUtf8(firstPrompt, MAX_TITLE_BYTES)
    events.push(event('subagent/descriptor', events.length, input.createdAt, {
      version: options.subagentDescriptorVersion,
      mode: 'one-shot',
      // Wire-format value kept for compatibility with sessions imported earlier; do not rename.
      provider: 'claude2dsh',
      label,
    }))
  }

  for (const turn of input.turns) {
    stats.turns += 1
    const turnTime = turn.timestamp ?? input.createdAt
    events.push(event('turn/start', events.length, turnTime, { turn: turn.number }))
    // The first turn opens with the protected system head (see systemHead).
    const needsHead = stats.turns === 1

    if (turn.steps.length === 0 && needsHead) {
      // The head needs an open step: a first turn that is only a prompt gets one.
      events.push(event('step/start', events.length, turnTime, { turn: turn.number, step: 1 }))
      events.push(systemHead(input.id, events.length, turnTime, turn.number, 1))
      events.push({
        type: 'user/message',
        seq: events.length,
        time: turnTime,
        data: {
          id: mid(input.id, 'u', turn.number, 0),
          role: 'user',
          content: turn.promptBlocks !== undefined ? turn.promptBlocks.map((block) => renderBlock(block)) : [{ type: 'text', text: turn.prompt }],
          source: { kind: 'user' },
        },
        surfaceOp: 'append',
      })
      events.push(event('step/end', events.length, turnTime, { turn: turn.number, step: 1 }))
      stats.messages += 1
    } else if (turn.steps.length === 0) {
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
        if (needsHead && step === turn.steps[0]) events.push(systemHead(input.id, events.length, turnTime, turn.number, step.number))
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
    id: input.id,
    createdAt: input.createdAt,
    delegationDepth: input.origin === 'subagent' ? 1 : 0,
    ...(input.cwd !== undefined && input.cwd.length > 0 ? { cwd: input.cwd } : {}),
    ...(input.origin !== undefined ? { origin: input.origin } : {}),
    ...(input.parentSession !== undefined ? { parentSession: input.parentSession } : {}),
  }

  return { meta, events, stats }
}
