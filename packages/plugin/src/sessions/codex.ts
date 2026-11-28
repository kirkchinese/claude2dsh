/**
 * Codex CLI rollout migration. Codex stores one JSONL rollout per session with
 * `session_meta`, `response_item` messages/tool calls, and event markers. This
 * adapter reduces that vocabulary to the shared NormalizedSession model, then
 * the shared session synthesizer emits DSH v4 events.
 * @module @kirkchinese/harness-forge
 */
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {
  NormalizedContentBlock,
  NormalizedSession,
  NormalizedToolCallBlock,
  NormalizedToolResult,
  NormalizedTurn,
} from '@kirkchinese/harness-forge-core'
import { assertFileImportable, fileLines, limitBytes, MAX_LINE_BYTES, splitLines, type LineObserver, type TranscriptLine } from '@kirkchinese/harness-forge-core'
import { zstdChunks } from './zstd.js'
import { stringField, textOf, timestamp, usablePrompt } from './codex-text.js'
import { codexHomeOf, codexIdentity, codexSessionId, CodexTitle, rolloutCreatedAt, rolloutThread, threadNames, type IndexedThread, type RolloutThread } from './codex-meta.js'
import { importReport, persistImported, targetIdentity, type ImportIdentity, type ImportReport } from './persist.js'
import { replyText, turnReader, turnText, type TurnReader, type TurnText } from './turns.js'
import { codexThreads } from './codex-discover.js'

export type CodexImportReport = ImportReport
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

export { discoverCodexSessions, type CodexSessionCandidate } from './codex-discover.js'
export { codexSessionId } from './codex-meta.js'

/** Default Codex rollout directory. */
export function defaultCodexSessionsRoot(home = homedir()): string {
  return join(home, '.codex', 'sessions')
}

/** One Codex rollout in the shared normalized model, with the thread it holds. */
export interface CodexRollout {
  /** The session, under the id this version gives the thread (or `targetId`). */
  readonly session: NormalizedSession
  readonly title?: string
  readonly thread: RolloutThread
}

/** What a rollout says besides its turns, known once it is read to the end. */
interface RolloutEnd {
  readonly meta: Record<string, unknown> | undefined
  readonly firstTimestamp: unknown
  readonly title: CodexTitle | undefined
}

/** Parse one Codex rollout into the shared normalized model. */
export async function readCodexSession(path: string, targetId?: string): Promise<CodexRollout> {
  const turns: MutableTurn[] = []
  const parts = rolloutTurns(path)
  let next = await parts.next()
  for (; next.done !== true; next = await parts.next()) turns.push(next.value)
  const { meta, firstTimestamp, title } = next.value
  if (meta === undefined) throw new Error(`Codex rollout has no session_meta: ${path}`)
  const thread = rolloutThread(meta)
  if (thread === undefined) throw new Error(`Codex rollout has no session id: ${path}`)
  const id = targetId ?? codexSessionId(thread.id)
  const createdAt = rolloutCreatedAt(meta, firstTimestamp)
  const cwd = stringField(meta['cwd'])
  const named = title?.title
  return {
    session: {
      id,
      source: { tool: 'codex', path, sessionId: id },
      createdAt,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(named !== undefined ? { title: named } : {}),
      turns: turns as unknown as readonly NormalizedTurn[],
    },
    ...(named !== undefined ? { title: named } : {}),
    thread,
  }
}

/**
 * The turns of a rollout, each as soon as the next one starts (what is said in a turn is then complete; a tool
 * result may still reach one of its steps), and then what else the rollout says. Read only as far as it is asked.
 */
async function* rolloutTurns(path: string): AsyncGenerator<MutableTurn, RolloutEnd> {
  /** Turns the record just read completed, to hand out before the next one is read. */
  const closed: MutableTurn[] = []
  let count = 0
  let meta: Record<string, unknown> | undefined
  let firstTimestamp: unknown
  let seen = false
  /** The first thing the person said, when no `user_message` event carries it (used only if no turn starts). */
  let fallback: string | undefined
  let turn: MutableTurn | undefined
  let step: MutableStep | undefined
  const pending = new Map<string, PendingCall>()
  let title: CodexTitle | undefined
  const names = threadNames(codexHomeOf(path))

  const startTurn = (prompt: string, at?: number): void => {
    if (turn !== undefined) closed.push(turn)
    count += 1
    turn = { number: count, prompt, ...(at !== undefined ? { timestamp: at } : {}), steps: [] }
    step = undefined
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

  // One record at a time: a rollout is not held, and what a continued session cannot use (reasoning blobs, image
  // data, token counts) is read past and gone as soon as its line is.
  for await (const record of readRecords(path)) {
    yield* closed.splice(0)
    if (!seen) {
      seen = true
      firstTimestamp = record.timestamp
    }
    const payload = record.payload
    if (payload === undefined) continue
    if (record.type === 'session_meta' && meta === undefined) {
      meta = payload
      const thread = rolloutThread(payload)
      title = new CodexTitle(thread === undefined ? undefined : (await names).get(thread.id))
    }
    title?.observe(record as Record<string, unknown>)
    if (fallback === undefined && record.type === 'response_item' && payload['type'] === 'message' && payload['role'] === 'user') {
      const text = textOf(payload['content'])
      if (text.trim().length > 0 && !text.trimStart().startsWith('<')) fallback = text
    }
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
  if (count === 0 && fallback !== undefined) startTurn(fallback)
  yield* closed.splice(0)
  if (turn !== undefined) yield turn
  return { meta, firstTimestamp, title }
}

/**
 * Import one Codex rollout into DSH session persistence: into the session that already holds its thread, else a new
 * one. A stored session that may or may not hold it (nothing tells) is not guessed at: the import is refused, and
 * the list offers both. `targetId` imports into that session, the way "Import as new" does.
 */
export async function importCodexSession(
  ctx: Context,
  sourcePath: string,
  options: { readonly targetId?: string } = {},
): Promise<CodexImportReport> {
  const parsed = await readCodexSession(sourcePath, options.targetId)
  if (parsed.session.turns.length === 0) throw new Error(`nothing to import from ${sourcePath}: no conversation in the rollout`)
  const identity = options.targetId !== undefined
    ? targetIdentity(options.targetId)
    : rolloutIdentity(sourcePath, parsed.thread, parsed.session.createdAt, { session: parsed.session })
  return importReport(sourcePath, parsed.title, await persistImported(ctx, parsed.session, identity))
}

/** What the list and the import know already, so neither reads it again. */
export interface KnownRollout {
  /** The threads under a sessions folder ({@link codexThreads}), shared by the rows of one list. */
  readonly threads?: (root: string) => Promise<readonly IndexedThread[]>
  /** The rollout, read. */
  readonly session?: NormalizedSession
}

/** The identity of the thread a rollout holds: the one the list shows and the import uses. */
export function rolloutIdentity(path: string, thread: RolloutThread, createdAt: number, known: KnownRollout = {}): ImportIdentity {
  const home = codexHomeOf(path)
  const root = home !== undefined ? join(home, 'sessions') : dirname(path)
  const session = known.session
  return codexIdentity(thread, createdAt, {
    threads: () => (known.threads ?? codexThreads)(root),
    turns: () => session !== undefined ? turnReader(sessionTurns(session.turns as unknown as readonly MutableTurn[])) : rolloutTurnReader(path),
    turnsOf: rolloutTurnReader,
  })
}

/** A reader of a rollout's turns: the rollout is read as far as the turns asked for. */
function rolloutTurnReader(path: string): TurnReader {
  return turnReader(sessionTurns(rolloutTurns(path)))
}

/** Turns as compared ({@link turnText}): the same for a rollout being read and one already read. */
async function* sessionTurns(turns: AsyncIterable<MutableTurn> | Iterable<MutableTurn>): AsyncGenerator<TurnText> {
  for await (const turn of turns) yield turnText(turn.prompt, turn.steps.flatMap(step => replyText(step.content)))
}

/**
 * The lines of a rollout, plain or compressed, streamed: what the import reads. The size is checked before the file
 * is read (a compressed one, as its decoded bytes stream by), so a rollout that is too large costs nothing.
 * `observer` sees how much the line splitter holds at once.
 */
export async function* rolloutLines(path: string, observer?: LineObserver): AsyncGenerator<TranscriptLine> {
  await assertFileImportable(path)
  yield* path.endsWith('.zst')
    ? splitLines(limitBytes(zstdChunks(path)), MAX_LINE_BYTES, observer)
    : fileLines(path, observer !== undefined ? { observer } : {})
}

/** The records of a rollout, one at a time. */
async function* readRecords(path: string): AsyncGenerator<CodexRecord> {
  for await (const line of rolloutLines(path)) {
    if (line.oversized || line.text.trim().length === 0) continue
    try {
      const value: unknown = JSON.parse(line.text)
      if (typeof value === 'object' && value !== null) yield value as CodexRecord
    } catch {
      // A partially written rollout line is ignored; the rest remains readable.
    }
  }
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



function parseJson(value: string | undefined): unknown {
  if (value === undefined) return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}


