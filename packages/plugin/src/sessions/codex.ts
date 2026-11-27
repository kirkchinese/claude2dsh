/**
 * Codex CLI rollout migration. Codex stores one JSONL rollout per session with
 * `session_meta`, `response_item` messages/tool calls, and event markers. This
 * adapter reduces that vocabulary to the shared NormalizedSession model, then
 * the shared session synthesizer emits DSH v4 events.
 * @module @kirkchinese/harness-forge
 */
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {
  NormalizedContentBlock,
  NormalizedSession,
  NormalizedToolCallBlock,
  NormalizedToolResult,
  NormalizedTurn,
} from '@kirkchinese/harness-forge-core'
import { synthesizeDshSession } from '@kirkchinese/harness-forge-core'
import { decodeZstd, zstdAvailable } from './zstd.js'
import { persistImported, type PersistedSession } from './persist.js'

export interface CodexSessionCandidate {
  readonly path: string
  readonly sourceId: string
  readonly title?: string
  readonly cwd?: string
  readonly createdAt?: number
}
export interface CodexImportReport extends PersistedSession {
  readonly sourcePath: string
  readonly title?: string
  readonly turns: number
  readonly events: number
  readonly stats: Record<string, number>
}
interface CodexRecord {
  timestamp?: string
  type?: string
  payload?: Record<string, unknown>
}
interface PendingCall {
  call: NormalizedToolCallBlock
  step: MutableStep
}
interface MutableStep {
  number: number
  timestamp?: number
  content: NormalizedContentBlock[]
  toolCalls: Array<{ id: string; name: string; arguments: unknown }>
  toolResults: NormalizedToolResult[]
}
interface MutableTurn {
  number: number
  prompt: string
  timestamp?: number
  steps: MutableStep[]
}

/** Default Codex rollout directory. */
export function defaultCodexSessionsRoot(home = homedir()): string {
  return join(home, '.codex', 'sessions')
}

/** Discover `rollout-*.jsonl` and compressed `rollout-*.jsonl.zst` (Codex 0.167+) files, newest first. */
export async function discoverCodexSessions(root = defaultCodexSessionsRoot(), limit = 200): Promise<CodexSessionCandidate[]> {
  const files = await listRollouts(root)
  const out: CodexSessionCandidate[] = []
  for (const path of files) {
    const meta = await readMeta(path)
    if (meta === undefined) continue
    out.push(meta)
    if (out.length >= limit) break
  }
  out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  return out
}

/** Parse one Codex rollout into the shared normalized model. */
export async function readCodexSession(path: string, targetId?: string): Promise<{ session: NormalizedSession; title?: string; legacyId: string }> {
  const records = await readRecords(path)
  const meta = records.find(record => record.type === 'session_meta')?.payload
  if (meta === undefined) throw new Error(`Codex rollout has no session_meta: ${path}`)
  const sourceId = stringField(meta['session_id']) ?? stringField(meta['id'])
  if (sourceId === undefined) throw new Error(`Codex rollout has no session id: ${path}`)
  const id = targetId ?? codexSessionId(sourceId)
  const createdAt = timestamp(meta['timestamp']) ?? timestamp(records[0]?.timestamp) ?? 0
  const cwd = stringField(meta['cwd'])
  const turns: MutableTurn[] = []
  let turn: MutableTurn | undefined
  let step: MutableStep | undefined
  const pending = new Map<string, PendingCall>()
  let title: string | undefined

  const startTurn = (prompt: string, at?: number): void => {
    turn = { number: turns.length + 1, prompt, ...(at !== undefined ? { timestamp: at } : {}), steps: [] }
    turns.push(turn)
    step = undefined
    if (title === undefined && prompt.trim().length > 0) title = prompt.trim().slice(0, 80)
  }
  const ensureTurn = (): MutableTurn => {
    if (turn === undefined) startTurn('')
    return turn!
  }
  const ensureStep = (at?: number): MutableStep => {
    const owner = ensureTurn()
    if (step === undefined) {
      step = { number: owner.steps.length + 1, ...(at !== undefined ? { timestamp: at } : {}), content: [], toolCalls: [], toolResults: [] }
      owner.steps = [...owner.steps, step]
    }
    return step
  }
  // Text after a tool call opens the next step: in one step it would part the call from its result.
  const bodyStep = (at?: number): MutableStep => {
    if (step !== undefined && step.toolCalls.length > 0) step = undefined
    return ensureStep(at)
  }

  for (const record of records) {
    const payload = record.payload
    if (payload === undefined) continue
    const at = timestamp(record.timestamp) ?? timestamp(payload['timestamp'])
    if (record.type === 'event_msg' && payload['type'] === 'user_message') {
      const prompt = stringField(payload['message'])
      if (prompt !== undefined && turn?.prompt !== prompt) startTurn(prompt, at)
      continue
    }
    if (record.type !== 'response_item') continue
    const kind = payload['type']
    if (kind === 'message') {
      const role = payload['role']
      const text = textOf(payload['content'])
      if (role === 'assistant') {
        const current = text.length > 0 ? bodyStep(at) : ensureStep(at)
        if (text.length > 0) current.content = [...current.content, { type: 'text', text }]
      } else if (role === 'user' && usablePrompt(text) && (turn === undefined || turn.prompt.length === 0 || step !== undefined)) {
        if (turn?.prompt !== text) startTurn(text, at)
      }
      continue
    }
    if (kind === 'reasoning') {
      const text = textOf(payload['summary']) || textOf(payload['content'])
      if (text.length > 0) {
        const current = bodyStep(at)
        current.content = [...current.content, { type: 'reasoning', text }]
      }
      continue
    }
    const callId = stringField(payload['call_id'])
    if (kind === 'function_call' || kind === 'custom_tool_call') {
      if (callId === undefined) continue
      const name = stringField(payload['name']) ?? 'tool'
      const raw = kind === 'function_call' ? parseJson(stringField(payload['arguments'])) : stringField(payload['input'])
      const call: NormalizedToolCallBlock = { type: 'tool-call', id: callId, name, arguments: raw ?? {} }
      const current = ensureStep(at)
      current.content = [...current.content, call]
      current.toolCalls = [...current.toolCalls, { id: callId, name, arguments: raw ?? {} }]
      pending.set(callId, { call, step: current })
      continue
    }
    if (kind === 'function_call_output' || kind === 'custom_tool_call_output') {
      if (callId === undefined) continue
      const owner = pending.get(callId)
      if (owner === undefined) continue
      const result: NormalizedToolResult = {
        toolCallId: callId,
        content: [{ type: 'text', text: outputText(payload['output']) }],
        ...(at !== undefined ? { timestamp: at } : {}),
      }
      owner.step.toolResults = [...owner.step.toolResults, result]
      pending.delete(callId)
    }
  }
  if (turns.length === 0) {
    const fallback = records
      .filter(record => record.type === 'response_item' && record.payload?.['type'] === 'message' && record.payload['role'] === 'user')
      .map(record => textOf(record.payload?.['content']))
      .find(text => text.trim().length > 0 && !text.trimStart().startsWith('<'))
    if (fallback !== undefined) startTurn(fallback)
  }
  return {
    session: {
      id,
      source: { tool: 'codex', path, sessionId: id },
      createdAt,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(title !== undefined ? { title } : {}),
      turns: turns as unknown as readonly NormalizedTurn[],
    },
    ...(title !== undefined ? { title } : {}),
    legacyId: sourceId,
  }
}

/**
 * The DSH id of an imported Codex session. Prefixed, so it never equals the Codex id: a session under the source's
 * own id reads as native to other importers (dsh-chat-import hides those sources). Imports by earlier versions used
 * the bare id; they are still found and reused.
 */
export function codexSessionId(sourceId: string): string {
  return `codex-${sourceId}`
}

/** Import one Codex rollout into DSH session persistence. */
export async function importCodexSession(
  ctx: Context,
  sourcePath: string,
  options: { readonly targetId?: string } = {},
): Promise<CodexImportReport> {
  const parsed = await readCodexSession(sourcePath, options.targetId)
  if (parsed.session.turns.length === 0) throw new Error(`nothing to import from ${sourcePath}: no conversation in the rollout`)
  const synthesized = synthesizeDshSession(parsed.session)
  const events = synthesized.events
  const persisted = await persistImported(ctx, synthesized, options.targetId === undefined ? [parsed.legacyId] : [])
  return {
    ...persisted,
    sourcePath,
    ...(parsed.title !== undefined ? { title: parsed.title } : {}),
    turns: synthesized.stats.turns,
    events: events.length,
    stats: {
      steps: synthesized.stats.steps,
      messages: synthesized.stats.messages,
      toolCalls: synthesized.stats.toolCalls,
      toolResults: synthesized.stats.toolResults,
      synthesizedToolResults: synthesized.stats.synthesizedToolResults,
    },
  }
}

async function listRollouts(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && /^rollout-.*\.jsonl(?:\.zst)?$/u.test(entry.name)) out.push(path)
    }
  }
  await walk(root)
  // A rollout Codex compressed while the plain file is still there is the same session once.
  const plain = new Set(out.filter(path => !path.endsWith('.zst')))
  return out.filter(path => !path.endsWith('.zst') || (zstdAvailable() && !plain.has(path.slice(0, -'.zst'.length))))
}

async function readMeta(path: string): Promise<CodexSessionCandidate | undefined> {
  const records = await readRecords(path).catch(() => [])
  const meta = records.find(record => record.type === 'session_meta')?.payload
  if (meta === undefined) return undefined
  const sourceId = stringField(meta['session_id']) ?? stringField(meta['id'])
  if (sourceId === undefined) return undefined
  const cwd = stringField(meta['cwd'])
  const createdAt = timestamp(meta['timestamp']) ?? timestamp(records[0]?.timestamp)
  const firstPrompt = records
    .find(record => record.type === 'event_msg' && record.payload?.['type'] === 'user_message')
    ?.payload?.['message']
  const title = typeof firstPrompt === 'string' && firstPrompt.trim().length > 0 ? firstPrompt.trim().slice(0, 80) : undefined
  return {
    path,
    sourceId,
    ...(title !== undefined ? { title } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  }
}

async function readRecords(path: string): Promise<CodexRecord[]> {
  const { readFile } = await import('node:fs/promises')
  const text = path.endsWith('.zst') ? decodeZstd(await readFile(path), path) : await readFile(path, 'utf8')
  const records: CodexRecord[] = []
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue
    try {
      const value: unknown = JSON.parse(line)
      if (typeof value === 'object' && value !== null) records.push(value as CodexRecord)
    } catch {
      // A partially written rollout line is ignored; the rest remains readable.
    }
  }
  return records
}

/**
 * A function call's output text. Codex wraps the output of its shell tools as `{"output": …, "metadata": …}`
 * (exit code, duration); the model saw the output, so that is what the result holds.
 */
function outputText(value: unknown): string {
  const text = textOf(value) || stringField(value) || ''
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('{')) return text
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const output = (parsed as Record<string, unknown>)['output']
      if (typeof output === 'string') return output
    }
  } catch {
    // Not the wrapper: the output itself is JSON or starts like it.
  }
  return text
}

function usablePrompt(text: string): boolean {
  const value = text.trim()
  if (value.length === 0) return false
  if (value.startsWith('<') || value.startsWith('# AGENTS.md')) return false
  return !(
    value.includes('<environment_context>')
    || value.includes('<skills_instructions>')
    || value.includes('<permissions instructions>')
    || value.includes('<user_instructions>')
  )
}

function textOf(value: unknown): string {  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((item) => {
      if (typeof item === 'string') return item
      if (typeof item !== 'object' || item === null) return ''
      const record = item as Record<string, unknown>
      return typeof record['text'] === 'string' ? record['text'] : ''
    })
    .filter(Boolean)
    .join('\n')
}

function parseJson(value: string | undefined): unknown {
  if (value === undefined) return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}
