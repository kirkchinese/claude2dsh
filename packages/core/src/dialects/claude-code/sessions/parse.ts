/** Claude Code JSONL -> normalized session model. */
import { basename } from 'node:path'
import type {
  AdapterOptions,
  DiscoveredSession,
  NormalizeStats,
  NormalizedContentBlock,
  NormalizedSession,
  NormalizedStep,
  NormalizedToolResult,
  NormalizedTurn,
} from '../../../sessions/index.js'
import type { RawJson, RawLine, RawRecord } from './types.js'
import { isAuxiliaryTranscriptPath } from './discover.js'
import { parseTimestamp } from '../../../sessions/time.js'
import { assertFileImportable, fileLines } from '../../../sessions/lines.js'
import { ClaudeTitle } from './title.js'

/** Adapter read options. */
export interface ClaudeReadOptions extends AdapterOptions {
  /** Override the target DSH session id (default: `claude-<sourceId>`). */
  readonly targetId?: string
  /** Permit subagent/workflow transcripts to be read as child sessions. */
  readonly allowAuxiliary?: boolean
}

interface MutableTurn {
  number: number
  prompt: string
  timestamp?: number
  promptBlocks?: NormalizedContentBlock[]
  steps: MutableStep[]
}

function withTimestamp(timestamp: number | undefined): { timestamp?: number } {
  return timestamp !== undefined ? { timestamp } : {}
}

function withModel(model: string | undefined): { model?: string } {
  return model !== undefined ? { model } : {}
}

interface MutableStep {
  number: number
  timestamp?: number
  model?: string
  content: NormalizedContentBlock[]
  toolCalls: { id: string; name: string; arguments: unknown }[]
  toolResults: NormalizedToolResult[]
}

interface CallTarget {
  step: MutableStep
}

/** Stable DSH target id for a Claude Code session. */
export function mintClaudeSessionId(sourceId: string | undefined, fileStem: string): string {
  const value = (sourceId ?? fileStem).trim()
  return `claude-${value.length > 0 ? value : 'unknown'}`
}

function asRecord(value: RawJson): RawRecord {
  return value as RawRecord
}

function imageMediaType(value: unknown): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | undefined {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif' ? value : undefined
}

function mapImageBlock(raw: RawJson): NormalizedContentBlock | undefined {
  const source = raw.source as { type?: unknown; media_type?: unknown; data?: unknown } | undefined
  const mediaType = imageMediaType(source?.media_type)
  // The data is not kept: the synthesizer renders every image as a placeholder, so holding it only costs memory.
  if (mediaType === undefined || typeof source?.data !== 'string') return undefined
  return { type: 'image', mediaType }
}

function extractUserPrompt(content: unknown): { prompt?: string; promptBlocks?: NormalizedContentBlock[] } {
  if (typeof content === 'string') return { prompt: content }
  if (!Array.isArray(content)) return {}
  const parts: string[] = []
  const blocks: NormalizedContentBlock[] = []
  let imageCount = 0
  for (const block of content) {
    if (typeof block === 'string') {
      if (block.length > 0) {
        parts.push(block)
        blocks.push({ type: 'text', text: block })
      }
      continue
    }
    if (typeof block !== 'object' || block === null) continue
    const raw = block as RawJson
    if (raw.type === 'text' && typeof raw.text === 'string' && raw.text.length > 0) {
      parts.push(raw.text)
      blocks.push({ type: 'text', text: raw.text })
    } else if (raw.type === 'image') {
      const mapped = mapImageBlock(raw)
      if (mapped !== undefined) {
        imageCount += 1
        blocks.push(mapped)
      }
    }
  }
  if (parts.length === 0 && imageCount === 0) return {}
  const prompt = parts.length > 0 ? parts.join('\n') : `[image ${imageCount}]`
  return { prompt, ...(blocks.length > 0 ? { promptBlocks: blocks } : {}) }
}

function mapAssistantBlocks(content: unknown, step: MutableStep): void {
  if (typeof content === 'string') {
    step.content.push({ type: 'text', text: content })
    return
  }
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (typeof block === 'string') {
      step.content.push({ type: 'text', text: block })
      continue
    }
    if (typeof block !== 'object' || block === null) continue
    const raw = block as RawJson
    switch (raw.type) {
      case 'text': {
        if (typeof raw.text === 'string') step.content.push({ type: 'text', text: raw.text })
        break
      }
      case 'thinking':
      case 'redacted_thinking': {
        const key = raw.type === 'thinking' ? 'thinking' : 'data'
        const text = typeof raw[key as string] === 'string' ? (raw[key as string] as string) : ''
        step.content.push({ type: 'reasoning', text, ...(raw.type === 'redacted_thinking' ? { redacted: true as const } : {}) })
        break
      }
      case 'tool_use': {
        if (typeof raw.id !== 'string') break
        const name = typeof raw.name === 'string' ? raw.name : ''
        const input = raw.input ?? {}
        step.content.push({ type: 'tool-call', id: raw.id, name, arguments: input })
        step.toolCalls.push({ id: raw.id, name, arguments: input })
        break
      }
      default:
        break
    }
  }
}

function mapToolResultBlocks(content: unknown, result: { content: NormalizedContentBlock[]; skippedBlocks: number }): void {
  if (typeof content === 'string') {
    if (content.length > 0) result.content.push({ type: 'text', text: content })
    return
  }
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (typeof block === 'string') {
      if (block.length > 0) result.content.push({ type: 'text', text: block })
      continue
    }
    if (typeof block !== 'object' || block === null) continue
    const raw = block as RawJson
    if (raw.type === 'text' && typeof raw.text === 'string') {
      result.content.push({ type: 'text', text: raw.text })
    } else if (raw.type === 'image') {
      const mapped = mapImageBlock(raw)
      if (mapped !== undefined) result.content.push(mapped)
      else result.skippedBlocks += 1
    }
  }
}

/**
 * Parse one Claude Code main transcript into the normalized model.
 *
 * The visible chain is selected by walking `parentUuid` backwards from the
 * last non-sidechain user/assistant record, which follows the branch Claude
 * Code kept current. Records are then processed in physical line order.
 */
export async function readClaudeSession(ref: DiscoveredSession, options: ClaudeReadOptions = {}): Promise<{
  session: NormalizedSession
  stats: NormalizeStats
}> {
  options.signal?.throwIfAborted()
  // Decided before a byte is read; the transcript is then streamed, never held (see the two passes below).
  await assertFileImportable(ref.ref)

  // Pass 1: one line at a time, keep only what choosing the main chain and the session's facts need.
  const index: ChainEntry[] = []
  const malformed: number[] = []
  const oversized: number[] = []
  let records = 0
  let parsed = 0
  let sessionId: string | undefined
  let cwd: string | undefined
  let createdAt: number | undefined
  let model: string | undefined
  const titles = new ClaudeTitle()
  for await (const raw of fileLines(ref.ref, options.signal !== undefined ? { signal: options.signal } : {})) {
    if (raw.oversized) {
      records += 1
      oversized.push(raw.number)
      continue
    }
    if (raw.text.trim() === '') continue
    records += 1
    let rec: RawRecord
    try {
      rec = asRecord(JSON.parse(raw.text) as RawJson)
    } catch {
      malformed.push(raw.number)
      continue
    }
    parsed += 1
    if (sessionId === undefined && typeof rec.sessionId === 'string' && rec.sessionId.length > 0) sessionId = rec.sessionId
    if (cwd === undefined && typeof rec.cwd === 'string' && rec.cwd.length > 0) cwd = rec.cwd
    if (createdAt === undefined) createdAt = parseTimestamp(rec.timestamp, createdAt)
    const recModel = typeof rec.message?.model === 'string' ? rec.message.model : typeof rec.model === 'string' ? rec.model : undefined
    if (model === undefined && recModel !== undefined) model = recModel
    titles.observe(rec)
    if (typeof rec.uuid === 'string' && rec.uuid.length > 0) {
      index.push({
        line: raw.number,
        uuid: rec.uuid,
        parent: typeof rec.parentUuid === 'string' ? rec.parentUuid : undefined,
        chained: rec.type === 'user' || rec.type === 'assistant',
        sidechain: rec.isSidechain === true,
      })
    }
  }
  options.signal?.throwIfAborted()

  const fileStem = basename(ref.ref).replace(/\.jsonl$/i, '')
  const auxiliary = isAuxiliaryTranscriptPath(ref.ref)
  const sourceId = auxiliary ? (ref.sourceId ?? sessionId ?? fileStem) : (sessionId ?? ref.sourceId ?? fileStem)
  const skipReason = isAuxiliaryTranscript(ref.ref, fileStem, sessionId, auxiliary && options.allowAuxiliary === true)
  const unreadable = [...malformed, ...oversized].sort((a, b) => a - b)
  const unreadableReasons = [
    ...malformed.slice(0, 5).map((line) => `malformed line ${line}`),
    ...oversized.slice(0, 5).map((line) => `line ${line} is too long to read and was skipped`),
  ]
  if (skipReason !== undefined) {
    return {
      session: emptySession(ref, sourceId, createdAt, cwd),
      stats: emptyStats(parsed, skipReason, unreadable, unreadableReasons),
    }
  }

  const nodes = new Map<string, ChainEntry>()
  for (const entry of index) nodes.set(entry.uuid, entry)
  const chain = selectMainChain(index, nodes)

  // Pass 2: only the lines on the chain are read again, whole.
  const wanted = new Set([...chain.values()].map((entry) => entry.line))
  let last = 0
  for (const line of wanted) if (line > last) last = line
  const byLine: RawLine[] = []
  if (wanted.size > 0) {
    for await (const raw of fileLines(ref.ref, options.signal !== undefined ? { signal: options.signal } : {})) {
      if (raw.number > last) break
      if (!wanted.has(raw.number) || raw.oversized) continue
      try {
        byLine.push({ line: raw.number, record: asRecord(JSON.parse(raw.text) as RawJson) })
      } catch {
        // The file changed under the first pass; the line is not there to read.
      }
    }
  }

  const turns: MutableTurn[] = []
  const reasons: string[] = []
  const callTargets = new Map<string, CallTarget>()
  let droppedToolResults = 0
  let droppedUserRecords = 0
  let currentTurn: MutableTurn | undefined
  let currentStep: MutableStep | undefined
  let afterToolResults = false

  for (const entry of byLine) {
    const rec = entry.record
    if (rec.type === 'user') {
      const userContent = rec.message?.content
      const { prompt, promptBlocks } = extractUserPrompt(userContent)
      const results = extractToolResults(userContent)
      if (results.length > 0) {
        for (const result of results) {
          const target = callTargets.get(result.toolCallId)
          if (target === undefined) {
            droppedToolResults += 1
            continue
          }
          const mapped: NormalizedToolResult = {
            toolCallId: result.toolCallId,
            content: result.content,
            ...(result.isError === true ? { isError: true } : {}),
            ...(result.timestamp !== undefined ? { timestamp: result.timestamp } : {}),
          }
          target.step.toolResults.push(mapped)
        }
        afterToolResults = true
      }
      if (prompt !== undefined) {
        currentTurn = {
          number: turns.length + 1,
          prompt,
          ...withTimestamp(parseTimestamp(rec.timestamp)),
          ...(promptBlocks !== undefined ? { promptBlocks } : {}),
          steps: [],
        }
        turns.push(currentTurn)
        currentStep = undefined
        afterToolResults = false
      } else if (results.length === 0) {
        droppedUserRecords += 1
      }
      continue
    }

    if (rec.type !== 'assistant') continue

    if (currentTurn === undefined) {
      droppedUserRecords += 1
      continue
    }
    const timestamp = parseTimestamp(rec.timestamp)
    const recModel = typeof rec.message?.model === 'string' ? rec.message.model : model
    if (currentStep === undefined || afterToolResults) {
      currentStep = {
        number: currentTurn.steps.length + 1,
        ...withTimestamp(timestamp),
        ...withModel(recModel),
        content: [],
        toolCalls: [],
        toolResults: [],
      }
      currentTurn.steps.push(currentStep)
      afterToolResults = false
    } else if (currentStep.timestamp === undefined && timestamp !== undefined) {
      currentStep.timestamp = timestamp
    } else if (currentStep.model === undefined && recModel !== undefined) {
      currentStep.model = recModel
    }

    mapAssistantBlocks(rec.message?.content, currentStep)
    for (const call of currentStep.toolCalls) {
      if (!callTargets.has(call.id)) callTargets.set(call.id, { step: currentStep })
    }
  }

  if (turns.length === 0) {
    reasons.push('no user turns on the selected main chain')
  }

  const id = options.targetId ?? mintClaudeSessionId(sourceId, fileStem)
  const parentSession = auxiliary && sessionId !== undefined ? mintClaudeSessionId(sessionId, fileStem) : undefined
  const normalizedTurns = turns.map((turn) => ({
    number: turn.number,
    prompt: turn.prompt,
    ...(turn.timestamp !== undefined ? { timestamp: turn.timestamp } : {}),
    ...(turn.promptBlocks !== undefined ? { promptBlocks: turn.promptBlocks } : {}),
    steps: turn.steps.map((step) => ({
      number: step.number,
      ...(step.timestamp !== undefined ? { timestamp: step.timestamp } : {}),
      ...(step.model !== undefined ? { model: step.model } : {}),
      content: step.content,
      toolCalls: step.toolCalls,
      toolResults: step.toolResults,
    })),
  }))

  const title = titles.title
  const session: NormalizedSession = {
    id,
    source: { tool: 'claude-code', path: ref.ref, sessionId: sourceId },
    createdAt: createdAt ?? Date.now(),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(auxiliary ? { origin: 'subagent' as const } : {}),
    ...(parentSession !== undefined ? { parentSession } : {}),
    turns: normalizedTurns,
  }

  const toolCalls = normalizedTurns.reduce((sum, turn) => sum + turn.steps.reduce((inner, step) => inner + step.toolCalls.length, 0), 0)
  const attachedResults = normalizedTurns.reduce((sum, turn) => sum + turn.steps.reduce((inner, step) => inner + step.toolResults.length, 0), 0)
  const stats: NormalizeStats = {
    records,
    skipped: Math.max(0, parsed - chain.size),
    malformed: unreadable.length,
    droppedToolResults,
    synthesizedToolResults: Math.max(0, toolCalls - attachedResults),
    droppedUserRecords,
    auxiliaryBranches: chain.size > 0 ? nodes.size - chain.size : 0,
    reasons: [...reasons, ...unreadableReasons],
  }
  return { session, stats }
}

function extractToolResults(content: unknown): { toolCallId: string; content: NormalizedContentBlock[]; isError?: boolean; timestamp?: number }[] {
  if (!Array.isArray(content)) return []
  const out: { toolCallId: string; content: NormalizedContentBlock[]; isError?: boolean; timestamp?: number }[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const raw = block as RawJson
    if (raw.type !== 'tool_result' || typeof raw.tool_use_id !== 'string') continue
    const mapped = { content: [] as NormalizedContentBlock[], skippedBlocks: 0 }
    mapToolResultBlocks(raw.content, mapped)
    out.push({
      toolCallId: raw.tool_use_id,
      content: mapped.content,
      ...(raw.is_error === true ? { isError: true } : {}),
    })
  }
  return out
}

/** What choosing the main chain needs of a line: the rest of the record is read again only if the line is on the chain. */
interface ChainEntry {
  readonly line: number
  readonly uuid: string
  readonly parent: string | undefined
  /** A `user` or `assistant` record: the kinds a chain ends in. */
  readonly chained: boolean
  readonly sidechain: boolean
}

function selectMainChain(index: ChainEntry[], nodes: Map<string, ChainEntry>): Map<string, ChainEntry> {
  const selected = new Map<string, ChainEntry>()
  const lastOf = (accept: (entry: ChainEntry) => boolean): ChainEntry | undefined => {
    for (let at = index.length - 1; at >= 0; at--) {
      const entry = index[at]
      if (entry !== undefined && entry.chained && accept(entry)) return entry
    }
    return undefined
  }
  const last = lastOf((entry) => !entry.sidechain) ?? lastOf(() => true)
  if (last === undefined) return selected

  const visited = new Set<string>()
  let cursor: ChainEntry | undefined = last
  while (cursor !== undefined) {
    if (visited.has(cursor.uuid)) break
    visited.add(cursor.uuid)
    selected.set(cursor.uuid, cursor)
    if (cursor.parent === undefined || cursor.parent.length === 0) break
    cursor = nodes.get(cursor.parent)
  }
  return selected
}

function isAuxiliaryTranscript(filePath: string, fileStem: string, sessionId: string | undefined, allowAuxiliary: boolean): string | undefined {
  const parts = filePath.split(/[\\/]/)
  if (parts.includes('subagents') || parts.includes('workflows')) {
    return allowAuxiliary ? undefined : 'auxiliary transcript under subagents/workflows is not imported unless includeSubagents is set'
  }
  if (sessionId !== undefined && fileStem !== sessionId) {
    return `file name ${fileStem} does not match source sessionId ${sessionId}`
  }
  return undefined
}

function emptySession(ref: DiscoveredSession, sourceId: string, createdAt: number | undefined, cwd: string | undefined): NormalizedSession {
  return {
    id: mintClaudeSessionId(sourceId, basename(ref.ref)),
    source: { tool: 'claude-code', path: ref.ref, sessionId: sourceId },
    createdAt: createdAt ?? Date.now(),
    ...(cwd !== undefined ? { cwd } : {}),
    turns: [],
  }
}

function emptyStats(records: number, reason: string, unreadable: number[], unreadableReasons: string[]): NormalizeStats {
  return {
    records,
    skipped: 1,
    malformed: unreadable.length,
    droppedToolResults: 0,
    synthesizedToolResults: 0,
    droppedUserRecords: 0,
    auxiliaryBranches: 0,
    reasons: [reason, ...unreadableReasons],
  }
}
