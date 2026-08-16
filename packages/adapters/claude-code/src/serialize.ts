/** DSH session events -> Claude Code JSONL transcript (pure functions). */
import { randomUUID } from 'node:crypto'
import type { ForeignSessionEvent, ForeignSessionView } from '@claude2dsh/core'

/** Claude Code project directory slug: every non-alphanumeric byte becomes `-`. */
export function slugifyClaudeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

export interface ClaudeSerializeOptions {
  /** UUID factory for deterministic tests; defaults to randomUUID. */
  readonly uuid?: () => string
  /** Fixed Claude-side session id; defaults to one uuid() value. */
  readonly sessionUuid?: string
  /** Timestamp fallback when an event has no `time`. */
  readonly now?: number
}

export interface ClaudeSerializeResult {
  readonly jsonl: string
  readonly recordCount: number
  readonly toolCalls: number
  readonly toolResults: number
  readonly droppedToolResults: number
  readonly skippedInjectedMessages: number
  readonly skippedBlocks: number
  readonly title?: string
}

interface ClaudeRecord {
  [key: string]: unknown
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function userTextBlocks(content: unknown): { blocks: unknown[]; skipped: number } {
  if (!Array.isArray(content)) return { blocks: [], skipped: 0 }
  const blocks: unknown[] = []
  let skipped = 0
  for (const block of content) {
    if (typeof block !== 'object' || block === null) {
      skipped += 1
      continue
    }
    const raw = block as { type?: unknown; text?: unknown }
    if (raw.type === 'text' && typeof raw.text === 'string') blocks.push(raw.text)
    else skipped += 1
  }
  return { blocks, skipped }
}

function assistantContentBlocks(content: unknown): { blocks: unknown[]; skipped: number } {
  if (!Array.isArray(content)) return { blocks: [], skipped: 0 }
  const blocks: unknown[] = []
  let skipped = 0
  for (const block of content) {
    if (typeof block !== 'object' || block === null) {
      skipped += 1
      continue
    }
    const raw = block as { type?: unknown }
    if (raw.type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') blocks.push({ type: 'text', text })
      else skipped += 1
    } else if (raw.type === 'reasoning') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') {
        const redacted = (block as { redacted?: unknown }).redacted
        blocks.push(redacted === true
          ? { type: 'redacted_thinking', data: text }
          : { type: 'thinking', thinking: text, signature: '' })
      } else {
        skipped += 1
      }
    } else if (raw.type === 'tool-call') {
      const call = block as { id?: unknown; name?: unknown; arguments?: unknown }
      if (typeof call.id === 'string') {
        blocks.push({ type: 'tool_use', id: call.id, name: typeof call.name === 'string' ? call.name : '', input: parseArguments(call.arguments) })
      } else {
        skipped += 1
      }
    } else {
      skipped += 1
    }
  }
  return { blocks, skipped }
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return {}
  try {
    return JSON.parse(value) as unknown
  } catch {
    return {}
  }
}

function eventData(event: ForeignSessionEvent): Record<string, unknown> {
  return event.data ?? {}
}

function userRecord(uuid: string, parentUuid: string | null, timestamp: number, content: unknown, meta: { sessionId: string; cwd: string }, extra: Record<string, unknown> = {}): ClaudeRecord {
  const { blocks, skipped } = userTextBlocks(content)
  void skipped
  const messageContent: unknown = Array.isArray(content)
    ? blocks
    : (blocks[0] ?? '')
  return {
    type: 'user',
    message: { role: 'user', content: messageContent },
    parentUuid,
    uuid,
    timestamp: iso(timestamp),
    permissionMode: 'default',
    origin: { kind: 'human' },
    promptSource: 'typed',
    userType: 'external',
    entrypoint: 'claude2dsh-export',
    cwd: meta.cwd,
    sessionId: meta.sessionId,
    version: '0.0.0',
    gitBranch: '',
    ...extra,
  }
}

function assistantRecord(uuid: string, parentUuid: string | null, timestamp: number, data: Record<string, unknown>, meta: { sessionId: string; cwd: string }): { record: ClaudeRecord; toolCallIds: string[] } {
  const message = (data.message ?? {}) as { id?: unknown; content?: unknown; source?: { model?: unknown } }
  const { blocks, skipped } = assistantContentBlocks(message.content)
  void skipped
  const toolCallIds: string[] = []
  for (const block of blocks) {
    if (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool_use') {
      const id = (block as { id?: unknown }).id
      if (typeof id === 'string') toolCallIds.push(id)
    }
  }
  const model = typeof message.source?.model === 'string' ? message.source.model : undefined
  const record: ClaudeRecord = {
    type: 'assistant',
    parentUuid,
    uuid,
    timestamp: iso(timestamp),
    message: {
      id: typeof message.id === 'string' ? message.id : 'msg_' + uuid.replace(/-/g, '').slice(0, 24),
      type: 'message',
      role: 'assistant',
      model: model ?? 'claude-code',
      content: blocks,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    sessionId: meta.sessionId,
  }
  return { record, toolCallIds }
}

function toolResultRecord(uuid: string, parentUuid: string | null, assistantUuid: string, timestamp: number, data: Record<string, unknown>, meta: { sessionId: string; cwd: string }): { record: ClaudeRecord; dropped: boolean } {
  const message = (data.message ?? {}) as { content?: unknown }
  const toolResults: unknown[] = []
  let dropped = false
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (typeof block !== 'object' || block === null) continue
      const raw = block as { type?: unknown; toolCallId?: unknown; content?: unknown; isError?: unknown }
      if (raw.type !== 'tool-result' || typeof raw.toolCallId !== 'string') continue
      const { blocks } = userTextBlocks(raw.content)
      toolResults.push({
        type: 'tool_result',
        tool_use_id: raw.toolCallId,
        content: blocks.length === 0 ? [] : blocks,
        ...(raw.isError === true ? { is_error: true } : {}),
      })
    }
  }
  if (toolResults.length === 0) dropped = true
  const record: ClaudeRecord = {
    type: 'user',
    message: { role: 'user', content: toolResults },
    parentUuid,
    uuid,
    timestamp: iso(timestamp),
    sourceToolAssistantUUID: assistantUuid,
    userType: 'external',
    entrypoint: 'claude2dsh-export',
    cwd: meta.cwd,
    sessionId: meta.sessionId,
    version: '0.0.0',
    gitBranch: '',
  }
  return { record, dropped }
}

/**
 * Serialize DSH surface events as a Claude Code JSONL transcript.
 *
 * The returned text starts with `mode`/`permission-mode` records, keeps the
 * `parentUuid` chain contiguous for normal records, and parents every
 * `tool_result` record on the assistant record that declared the call, exactly
 * like Claude Code's own transcripts.
 */
export interface ClaudeSerializeTailResult extends ClaudeSerializeResult {
  readonly lastUuid: string | null
  readonly eventsCount: number
  readonly turnCount: number
  readonly droppedIncompleteTurn: boolean
}

interface RecordSerializeInput {
  readonly session: ForeignSessionView
  readonly sessionUuid: string
  readonly cwd: string
  readonly emitHeader: boolean
  readonly emitTitle: boolean
  readonly fromSeq?: number
  readonly anchorUuid?: string | null
  readonly uuid: () => string
}

function selectTailEvents(events: readonly ForeignSessionEvent[], fromSeq: number): { events: ForeignSessionEvent[]; droppedIncompleteTurn: boolean } {
  const suffix = events.filter((event) => event.seq >= fromSeq)
  let lastTurnStart = -1
  let lastTurnEnd = -1
  for (let index = 0; index < suffix.length; index++) {
    const event = suffix[index]
    if (event?.type === 'turn/start') lastTurnStart = index
    else if (event?.type === 'turn/end') lastTurnEnd = index
  }
  if (lastTurnStart > lastTurnEnd) {
    return { events: suffix.slice(0, lastTurnStart), droppedIncompleteTurn: true }
  }
  return { events: suffix, droppedIncompleteTurn: false }
}

function serializeRecords(input: RecordSerializeInput): {
  records: ClaudeRecord[]
  stats: { toolCalls: number; toolResults: number; droppedToolResults: number; skippedInjectedMessages: number; skippedBlocks: number }
  title?: string
  lastUuid: string | null
  eventsCount: number
  droppedIncompleteTurn?: boolean
} {
  const { session, sessionUuid, cwd, emitHeader, emitTitle, uuid } = input
  const selected = input.fromSeq === undefined ? undefined : selectTailEvents(session.events, input.fromSeq)
  const events = selected === undefined ? [...session.events] : selected.events
  const meta = { sessionId: sessionUuid, cwd }
  const records: ClaudeRecord[] = []
  const stats = {
    toolCalls: 0,
    toolResults: 0,
    droppedToolResults: 0,
    skippedInjectedMessages: 0,
    skippedBlocks: 0,
  }

  if (emitHeader) {
    records.push({ type: 'mode', mode: 'normal', sessionId: sessionUuid })
    records.push({ type: 'permission-mode', permissionMode: 'default', sessionId: sessionUuid })
  }

  let prevUuid: string | null = input.anchorUuid ?? null
  let firstUserEmitted = false
  let title: string | undefined
  const assistantUuidByStep = new Map<string, string>()
  const callToAssistant = new Map<string, string>()
  let currentTurn = 0
  let currentStep = 0

  for (const event of events) {
    const data = eventData(event)
    switch (event.type) {
      case 'turn/start': {
        if (typeof data.turn === 'number') currentTurn = data.turn
        break
      }
      case 'step/start': {
        if (typeof data.step === 'number') currentStep = data.step
        break
      }
      case 'step/end':
      case 'turn/end':
        break
      case 'session/title': {
        if (emitTitle && title === undefined && typeof data.title === 'string' && data.title.trim().length > 0) title = data.title.trim()
        break
      }
      case 'user/message': {
        const source = (data.source ?? {}) as { kind?: unknown }
        if (source.kind !== 'user') {
          stats.skippedInjectedMessages += 1
          break
        }
        const recordUuid = uuid()
        const content = (data as { content?: unknown }).content
        records.push(userRecord(recordUuid, prevUuid, event.time, content, meta))
        prevUuid = recordUuid
        if (emitTitle && !firstUserEmitted) {
          firstUserEmitted = true
          if (title !== undefined) records.push({ type: 'ai-title', aiTitle: title, sessionId: sessionUuid })
        }
        break
      }
      case 'assistant/message': {
        const recordUuid = uuid()
        const result = assistantRecord(recordUuid, prevUuid, event.time, data, meta)
        records.push(result.record)
        prevUuid = recordUuid
        assistantUuidByStep.set(`${currentTurn}:${currentStep}`, recordUuid)
        for (const callId of result.toolCallIds) {
          callToAssistant.set(callId, recordUuid)
          stats.toolCalls += 1
        }
        break
      }
      case 'tool/result': {
        const message = (data.message ?? {}) as { content?: unknown }
        const callIds: string[] = []
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-result') {
              const callId = (block as { toolCallId?: unknown }).toolCallId
              if (typeof callId === 'string') callIds.push(callId)
            }
          }
        }
        for (const callId of callIds) {
          const assistantUuid = callToAssistant.get(callId)
          if (assistantUuid === undefined) {
            stats.droppedToolResults += 1
            continue
          }
          const recordUuid = uuid()
          const result = toolResultRecord(recordUuid, assistantUuid, assistantUuid, event.time, data, meta)
          if (result.dropped) {
            stats.droppedToolResults += 1
            continue
          }
          records.push(result.record)
          prevUuid = recordUuid
          stats.toolResults += 1
        }
        break
      }
      default:
        break
    }
  }

  void assistantUuidByStep
  return { records, stats, ...(title !== undefined ? { title } : {}), lastUuid: prevUuid, eventsCount: selected?.events.length ?? events.length, ...(selected !== undefined ? { droppedIncompleteTurn: selected.droppedIncompleteTurn } : {}) }
}

/**
 * Serialize DSH surface events as a Claude Code JSONL transcript.
 *
 * The returned text starts with `mode`/`permission-mode` records, keeps the
 * `parentUuid` chain contiguous for normal records, and parents every
 * `tool_result` record on the assistant record that declared the call, exactly
 * like Claude Code's own transcripts.
 */
export function serializeClaudeJsonl(session: ForeignSessionView, options: ClaudeSerializeOptions = {}): ClaudeSerializeResult {
  const uuid = options.uuid ?? randomUUID
  const sessionUuid = options.sessionUuid ?? uuid()
  const cwd = session.cwd ?? process.cwd()
  const out = serializeRecords({
    session,
    sessionUuid,
    cwd,
    emitHeader: true,
    emitTitle: true,
    uuid,
  })
  return {
    jsonl: out.records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    recordCount: out.records.length,
    toolCalls: out.stats.toolCalls,
    toolResults: out.stats.toolResults,
    droppedToolResults: out.stats.droppedToolResults,
    skippedInjectedMessages: out.stats.skippedInjectedMessages,
    skippedBlocks: out.stats.skippedBlocks,
    ...(out.title !== undefined ? { title: out.title } : {}),
  }
}

/**
 * Serialize the complete-turn suffix of a DSH log as a headless Claude Code
 * append batch. The first emitted record continues `anchorUuid`; `sessionUuid`
 * must be the existing Claude-side session id.
 */
export function serializeClaudeJsonlTail(
  session: ForeignSessionView,
  options: { fromSeq: number; sessionUuid: string; anchorUuid: string | null; uuid?: () => string },
): ClaudeSerializeTailResult {
  const uuid = options.uuid ?? randomUUID
  const cwd = session.cwd ?? process.cwd()
  const out = serializeRecords({
    session,
    sessionUuid: options.sessionUuid,
    cwd,
    emitHeader: false,
    emitTitle: false,
    fromSeq: options.fromSeq,
    anchorUuid: options.anchorUuid,
    uuid,
  })
  if (out.records.length === 0) {
    throw new Error('no appendable Claude records')
  }
  return {
    jsonl: out.records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    recordCount: out.records.length,
    toolCalls: out.stats.toolCalls,
    toolResults: out.stats.toolResults,
    droppedToolResults: out.stats.droppedToolResults,
    skippedInjectedMessages: out.stats.skippedInjectedMessages,
    skippedBlocks: out.stats.skippedBlocks,
    ...(out.title !== undefined ? { title: out.title } : {}),
    lastUuid: out.lastUuid,
    eventsCount: out.eventsCount ?? out.records.length,
    turnCount: selectedTurnCount(session.events, options.fromSeq),
    droppedIncompleteTurn: out.droppedIncompleteTurn ?? false,
  }
}

function selectedTurnCount(events: readonly ForeignSessionEvent[], fromSeq: number): number {
  let count = 0
  let open = false
  for (const event of events) {
    if (event.seq < fromSeq) continue
    if (event.type === 'turn/start') { open = true; continue }
    if (event.type === 'turn/end' && open) { count += 1; open = false }
  }
  return count
}
