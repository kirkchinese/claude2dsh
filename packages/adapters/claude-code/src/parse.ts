/** Claude Code JSONL -> normalized session model. */
import { readFile } from 'node:fs/promises'
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
} from '@claude2dsh/core'
import type { RawJson, RawLine, RawRecord } from './types.ts'
import { isAuxiliaryTranscriptPath } from './discover.ts'
import { parseTimestamp } from './time.ts'

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
  const base64 = typeof source?.data === 'string' ? source.data : undefined
  if (mediaType === undefined || base64 === undefined) return undefined
  return { type: 'image', mediaType, base64 }
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
  const text = await readFile(ref.ref, 'utf8')
  const lines = text.split('\n')
  const rawLines: RawLine[] = []
  const malformed: number[] = []
  let records = 0
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]
    if (raw === undefined || raw.trim() === '') continue
    records += 1
    try {
      rawLines.push({ line: index + 1, record: asRecord(JSON.parse(raw) as RawJson) })
    } catch {
      malformed.push(index + 1)
    }
  }
  options.signal?.throwIfAborted()

  let sessionId: string | undefined
  let cwd: string | undefined
  let createdAt: number | undefined
  let model: string | undefined
  let explicitTitle: string | undefined

  for (const entry of rawLines) {
    const rec = entry.record
    if (sessionId === undefined && typeof rec.sessionId === 'string' && rec.sessionId.length > 0) sessionId = rec.sessionId
    if (cwd === undefined && typeof rec.cwd === 'string' && rec.cwd.length > 0) cwd = rec.cwd
    if (createdAt === undefined) createdAt = parseTimestamp(rec.timestamp, createdAt)
    const recModel = typeof rec.message?.model === 'string' ? rec.message.model : typeof rec.model === 'string' ? rec.model : undefined
    if (model === undefined && recModel !== undefined) model = recModel
    if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string' && rec.aiTitle.trim().length > 0) {
      explicitTitle = rec.aiTitle.trim()
    }
    if (rec.type === 'summary') {
      const candidate = typeof rec.summary === 'string' && rec.summary.trim().length > 0
        ? rec.summary
        : typeof rec.title === 'string' && rec.title.trim().length > 0
          ? rec.title
          : undefined
      if (candidate !== undefined) explicitTitle = candidate
    }
  }

  const fileStem = basename(ref.ref).replace(/\.jsonl$/i, '')
  const auxiliary = isAuxiliaryTranscriptPath(ref.ref)
  const sourceId = auxiliary ? (ref.sourceId ?? sessionId ?? fileStem) : (sessionId ?? ref.sourceId ?? fileStem)
  const skipReason = isAuxiliaryTranscript(ref.ref, fileStem, sessionId, auxiliary && options.allowAuxiliary === true)
  if (skipReason !== undefined) {
    return {
      session: emptySession(ref, sourceId, createdAt, cwd),
      stats: emptyStats(rawLines.length, skipReason, malformed),
    }
  }

  const nodes = new Map<string, RawLine>()
  for (const entry of rawLines) {
    const uuid = entry.record.uuid
    if (typeof uuid === 'string' && uuid.length > 0) nodes.set(uuid, entry)
  }

  const selected = selectMainChain(rawLines, nodes)
  const byLine = [...selected.values()].sort((a, b) => a.line - b.line)

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

  const title = explicitTitle ?? (normalizedTurns[0] !== undefined ? firstTitle(normalizedTurns[0].prompt) : undefined)
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
    skipped: Math.max(0, rawLines.length - selected.size),
    malformed: malformed.length,
    droppedToolResults,
    synthesizedToolResults: Math.max(0, toolCalls - attachedResults),
    droppedUserRecords,
    auxiliaryBranches: selected.size > 0 ? nodes.size - selected.size : 0,
    reasons: [...reasons, ...malformed.slice(0, 5).map((line) => `malformed line ${line}`)],
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

function selectMainChain(rawLines: RawLine[], nodes: Map<string, RawLine>): Map<string, RawLine> {
  const selected = new Map<string, RawLine>()
  let last: RawLine | undefined
  for (let index = rawLines.length - 1; index >= 0; index--) {
    const entry = rawLines[index]
    if (entry === undefined) continue
    const rec = entry.record
    if ((rec.type !== 'user' && rec.type !== 'assistant') || typeof rec.uuid !== 'string') continue
    if (rec.isSidechain === true) continue
    last = entry
    break
  }
  if (last === undefined) {
    for (let index = rawLines.length - 1; index >= 0; index--) {
      const entry = rawLines[index]
      if (entry === undefined) continue
      const rec = entry.record
      if ((rec.type === 'user' || rec.type === 'assistant') && typeof rec.uuid === 'string') {
        last = entry
        break
      }
    }
  }
  if (last === undefined) return selected

  const visited = new Set<string>()
  let cursor: RawLine | undefined = last
  while (cursor !== undefined) {
    const uuid = cursor.record.uuid
    if (typeof uuid !== 'string' || visited.has(uuid)) break
    visited.add(uuid)
    selected.set(uuid, cursor)
    const parent = cursor.record.parentUuid
    if (typeof parent !== 'string' || parent.length === 0) break
    cursor = nodes.get(parent)
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

function firstTitle(prompt: string): string | undefined {
  const text = prompt.trim().replace(/\s+/g, ' ')
  return text.length > 0 ? text : undefined
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

function emptyStats(records: number, reason: string, malformed: number[]): NormalizeStats {
  return {
    records,
    skipped: 1,
    malformed: malformed.length,
    droppedToolResults: 0,
    synthesizedToolResults: 0,
    droppedUserRecords: 0,
    auxiliaryBranches: 0,
    reasons: [reason, ...malformed.slice(0, 5).map((line) => `malformed line ${line}`)],
  }
}
