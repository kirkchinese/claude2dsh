/** DSH session log -> the normalized view the Claude serializer consumes. */
import type { ForeignSessionEvent, ForeignSessionView } from '@dsh2claude/core'
import type { DiscoveredDshSession, DshReadOptions, DshReadStats, DshSessionHeader, ReadDshSessionResult } from './types.ts'
import { decodeDshLog } from './zstd.ts'

interface RawEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function textContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content.trim().length > 0 ? content.trim() : undefined
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) return block.text.trim()
  }
  return undefined
}

/**
 * v4 stores tool output as `message.content` directly; the Claude serializer
 * expects the v3/Anthropic block shape `{type:"tool-result", ...}`. Normalize
 * both shapes so the serializer stays direction-agnostic.
 */
function normalizeToolResult(data: Record<string, unknown>): Record<string, unknown> {
  const message = asRecord(data.message)
  if (!isRecord(data.message)) return data
  const content = message.content
  if (!Array.isArray(content)) return data
  const alreadyWrapped = content.some((block) => isRecord(block) && block.type === 'tool-result')
  if (alreadyWrapped) return data
  const callId = typeof message.toolCallId === 'string'
    ? message.toolCallId
    : typeof data.toolCallId === 'string'
      ? data.toolCallId
      : undefined
  if (callId === undefined) return data
  return {
    ...data,
    message: {
      ...message,
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
        ...(message.isError === true ? { isError: true } : {}),
      }],
    },
  }
}

function countImages(content: unknown): number {
  if (!Array.isArray(content)) return 0
  let count = 0
  for (const block of content) {
    if (isRecord(block) && block.type === 'image') count += 1
  }
  return count
}

function injectedSource(data: Record<string, unknown>): boolean {
  const source = asRecord(data.source)
  return source.kind !== undefined && source.kind !== 'user'
}

function normalizeEvent(event: RawEvent, stats: { injectedUserMessages: number; toolCalls: number; toolResults: number; droppedImages: number }): ForeignSessionEvent {
  if (event.type === 'user/message' && injectedSource(event.data)) stats.injectedUserMessages += 1
  if (event.type === 'tool/call') stats.toolCalls += 1
  if (event.type === 'tool/result') {
    stats.toolResults += 1
    const normalized = normalizeToolResult(event.data)
    const message = asRecord(normalized.message)
    stats.droppedImages += countImages(message.content)
    return { type: event.type, seq: event.seq, time: event.time, data: normalized }
  }
  if (event.type === 'assistant/message') {
    const message = asRecord(event.data.message)
    stats.droppedImages += countImages(message.content)
  }
  return { type: event.type, seq: event.seq, time: event.time, data: event.data }
}

function findTitle(events: readonly ForeignSessionEvent[]): string | undefined {
  let title: string | undefined
  for (const event of events) {
    if (event.type !== 'session/title') continue
    const value = asRecord(event.data).title
    if (typeof value === 'string' && value.trim().length > 0) title = value.trim()
  }
  return title
}

function firstUserPrompt(events: readonly ForeignSessionEvent[]): string | undefined {
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const source = asRecord(event.data.source)
    if (source.kind !== 'user') continue
    const text = textContent(event.data.content)
    if (text !== undefined) return text
  }
  return undefined
}

function shortTitle(text: string): string {
  const normalized = text.trim().replace(/\s+/g, ' ')
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 79)}…`
}

interface SurfaceEntry {
  readonly event: ForeignSessionEvent
  readonly surfaceOp?: unknown
}

function surfaceRange(op: Record<string, unknown>): [number, number] | undefined {
  const start = typeof op.start === 'number' ? op.start : typeof op.startSeq === 'number' ? op.startSeq : undefined
  const end = typeof op.end === 'number' ? op.end : typeof op.endSeq === 'number' ? op.endSeq : undefined
  if (start === undefined || end === undefined) return undefined
  return start <= end ? [start, end] : [end, start]
}

/**
 * Apply DSH surface replacements to the logged event stream.
 *
 * A `surfaceOp` replace records a later event that supersedes a seq range;
 * without folding, an imported transcript would contain both the original and
 * its replacement. Non-surface events pass through unchanged.
 */
function foldSurface(entries: readonly SurfaceEntry[]): { events: ForeignSessionEvent[]; replacements: number } {
  let output: SurfaceEntry[] = []
  const suppressed: Array<[number, number]> = []
  let replacements = 0
  for (const entry of entries) {
    const op = entry.surfaceOp
    if (isRecord(op) && (op.op === 'replace' || op.op === 'remove')) {
      const range = surfaceRange(op)
      if (range !== undefined) {
        suppressed.push(range)
        output = output.filter((candidate) => candidate.event.seq < range[0] || candidate.event.seq > range[1])
        replacements += 1
        if (op.op === 'replace') output.push(entry)
        continue
      }
    }
    if (suppressed.some(([start, end]) => entry.event.seq >= start && entry.event.seq <= end)) continue
    output.push(entry)
  }
  return { events: output.map((entry) => entry.event), replacements }
}

/**
 * Read one DSH session log into the shared foreign-session view.
 *
 * The header record is read from the log itself (v3/v4) or the discovered
 * metadata. Injected user messages stay in the log so the serializer can count
 * them, but only `source.kind === "user"` records become Claude prompts.
 */
export async function readDshSession(discovered: DiscoveredDshSession, options: DshReadOptions = {}): Promise<ReadDshSessionResult> {
  options.signal?.throwIfAborted()
  const decoded = await decodeDshLog(discovered.ref)
  const records = decoded.text.split('\n')
  const entries: SurfaceEntry[] = []
  let malformed = 0
  let ignored = 0
  let header: DshSessionHeader | undefined
  const stats = { injectedUserMessages: 0, toolCalls: 0, toolResults: 0, droppedImages: 0 }

  for (const line of records) {
    if (line.trim().length === 0) continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      malformed += 1
      continue
    }
    if (!isRecord(raw)) {
      ignored += 1
      continue
    }
    if (raw.type === 'session') {
      header ??= {
        id: typeof raw.id === 'string' ? raw.id : discovered.dshId,
        version: typeof raw.version === 'number' ? raw.version : discovered.version,
        createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : discovered.createdAt,
        ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}),
        ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
        ...(raw.isSeeded === true ? { isSeeded: true } : {}),
        ...(typeof raw.delegationDepth === 'number' ? { delegationDepth: raw.delegationDepth } : {}),
        ...(raw.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
        ...(typeof raw.parentSession === 'string' ? { parentSession: raw.parentSession } : {}),
        ...(typeof raw.agentPreset === 'string' ? { agentPreset: raw.agentPreset } : {}),
      }
      continue
    }
    if (typeof raw.type !== 'string' || typeof raw.seq !== 'number') {
      ignored += 1
      continue
    }
    const time = typeof raw.time === 'number' ? raw.time : discovered.createdAt
    const data = asRecord(raw.data)
    const event = normalizeEvent({ type: raw.type, seq: raw.seq, time, data }, stats)
    entries.push({ event, ...(raw.surfaceOp !== undefined ? { surfaceOp: raw.surfaceOp } : {}) })
  }

  options.signal?.throwIfAborted()
  entries.sort((left, right) => left.event.seq - right.event.seq)
  const folded = foldSurface(entries)
  const events = folded.events
  const resolvedHeader: DshSessionHeader = header ?? {
    id: discovered.dshId,
    version: discovered.version,
    createdAt: discovered.createdAt,
    ...(discovered.cwd !== undefined ? { cwd: discovered.cwd } : {}),
    ...(discovered.title !== undefined ? { title: discovered.title } : {}),
    ...(discovered.isAuxiliary ? { delegationDepth: 1, origin: 'subagent' as const } : {}),
    ...(discovered.parentDshId !== undefined ? { parentSession: discovered.parentDshId } : {}),
  }
  const fallbackTitle = firstUserPrompt(events)
  const title = findTitle(events) ?? resolvedHeader.title ?? (fallbackTitle !== undefined ? shortTitle(fallbackTitle) : undefined)
  const view: ForeignSessionView = {
    id: resolvedHeader.id,
    createdAt: resolvedHeader.createdAt,
    ...(resolvedHeader.cwd !== undefined ? { cwd: resolvedHeader.cwd } : {}),
    ...(title !== undefined ? { title: shortTitle(title) } : {}),
    events,
  }
  const resultStats: DshReadStats = {
    records: records.length,
    malformed,
    ignored,
    injectedUserMessages: stats.injectedUserMessages,
    toolCalls: stats.toolCalls,
    toolResults: stats.toolResults,
    droppedImages: stats.droppedImages,
    surfaceReplacements: folded.replacements,
    tornBytes: decoded.tornBytes,
    frames: decoded.frames,
  }
  return { ref: discovered.ref, header: resolvedHeader, view, stats: resultStats }
}
