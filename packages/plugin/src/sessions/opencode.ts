/**
 * OpenCode session migration. OpenCode stores sessions/messages/parts in a
 * SQLite database; this adapter reads a snapshot through `node:sqlite`, reduces
 * the rows to the shared NormalizedSession model, and lets the existing
 * DSH synthesizer emit v4 events. The database is opened read-only.
 * @module @kirkchinese/harness-forge
 */
import { existsSync } from 'node:fs'
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
import { assertSessionSize } from '@kirkchinese/harness-forge-core'
import { SESSION_PAGE_SIZE, type SessionPage, type SessionPageRequest } from '../forge/contract.js'
import { importReport, persistImported, targetIdentity, type ImportIdentity, type ImportReport } from './persist.js'

interface Database {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
    /** Rows one at a time (`StatementSync.iterate`, Node 22.13+): a session's rows are never all held. */
    iterate(...params: unknown[]): IterableIterator<unknown>
  }
  close(): void
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

/** One discoverable OpenCode session in its shared database. */
export interface OpenCodeSessionCandidate {
  readonly path: string
  readonly sourceId: string
  readonly source: 'opencode'
  readonly title?: string
  readonly cwd?: string
  readonly createdAt?: number
  readonly updatedAt?: number
  /** The size of the session's messages and parts, in bytes; absent when the database does not say. */
  readonly bytes?: number
}
export type OpenCodeImportReport = ImportReport

/** Default OpenCode database path (the desktop build uses ~/.local/share). */
export function defaultOpenCodeDatabase(home = homedir()): string {
  const xdg = join(home, '.local', 'share', 'opencode', 'opencode.db')
  if (existsSync(xdg)) return xdg
  const local = process.env.LOCALAPPDATA === undefined ? undefined : join(process.env.LOCALAPPDATA, 'opencode', 'opencode.db')
  return local ?? xdg
}

/** Discover top-level OpenCode sessions (subagent sessions are excluded). */
export async function discoverOpenCodeSessions(path = defaultOpenCodeDatabase(), page: SessionPageRequest = {}): Promise<SessionPage<OpenCodeSessionCandidate>> {
  const limit = Math.max(1, page.limit ?? SESSION_PAGE_SIZE)
  const offset = Math.max(0, page.cursor ?? 0)
  const db = await openDatabase(path)
  try {
    const table = schemaKind(db) === 'v2' ? 'session_v2' : 'session'
    // One more than a page, to know whether another page follows.
    const rows = db.prepare(`select id, title, directory, time_created, time_updated from ${table} where parent_id is null order by time_updated desc limit ? offset ?`).all(limit + 1, offset) as Array<Record<string, unknown>>
    const sessions = rows.slice(0, limit).map((row) => {
      const title = stringField(row['title'])
      const cwd = stringField(row['directory'])
      const createdAt = numberField(row['time_created'])
      const updatedAt = numberField(row['time_updated'])
      const bytes = sessionBytes(db, String(row['id']))
      return {
        path,
        sourceId: String(row['id']),
        source: 'opencode' as const,
        ...(title !== undefined ? { title } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
        ...(createdAt !== undefined ? { createdAt } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {}),
        ...(bytes !== undefined ? { bytes } : {}),
      }
    })
    return { sessions, ...(rows.length > limit ? { next: offset + limit } : {}) }
  } finally {
    db.close()
  }
}

/** Read one OpenCode session into the shared normalized model. */
export async function readOpenCodeSession(
  path: string,
  sourceId: string,
  targetId?: string,
): Promise<{ session: NormalizedSession; title?: string }> {
  const db = await openDatabase(path)
  try {
    // Before any message is read: a session is rows, not a file, and its size is what they add up to.
    const bytes = sessionBytes(db, sourceId)
    if (bytes !== undefined) assertSessionSize(bytes)
    if (schemaKind(db) === 'v2') return readOpenCodeV2(db, path, sourceId, targetId)
    const row = db.prepare('select id, title, directory, time_created from session where id = ?').get(sourceId) as Record<string, unknown> | undefined
    if (row === undefined) throw new Error(`OpenCode session not found: ${sourceId}`)
    const messages = db.prepare('select id, data from message where session_id = ? order by time_created').iterate(sourceId) as Iterable<Record<string, unknown>>
    const parts = db.prepare('select data from part where message_id = ? order by time_created')
    const turns: MutableTurn[] = []
    let current: MutableTurn | undefined
    let step: MutableStep | undefined
    const startTurn = (prompt: string, at?: number): void => {
      current = { number: turns.length + 1, prompt, ...(at !== undefined ? { timestamp: at } : {}), steps: [] }
      turns.push(current)
      step = undefined
    }
    const ensureStep = (at?: number): MutableStep => {
      if (current === undefined) startTurn('', at)
      if (step === undefined) {
        step = { number: current!.steps.length + 1, ...(at !== undefined ? { timestamp: at } : {}), content: [], toolCalls: [], toolResults: [] }
        current!.steps.push(step)
      }
      return step
    }
    // Text after a tool call opens the next step: in one step it would part the call from its result.
    const bodyStep = (at?: number): MutableStep => {
      if (step !== undefined && step.toolCalls.length > 0) step = undefined
      return ensureStep(at)
    }
    for (const message of messages) {
      const data = parseRecord(message['data'])
      if (data === undefined) continue
      const created = numberField(asRecord(data['time'])?.['created'])
      const role = data['role']
      if (role !== 'user' && role !== 'assistant') continue
      const rows = parts.iterate(String(message['id'])) as Iterable<Record<string, unknown>>
      if (role === 'user') {
        const texts: string[] = []
        for (const part of rows) {
          const data = parseRecord(part['data'])
          if (isTextPart(data)) texts.push(data['text'])
        }
        startTurn(texts.join('\n'), created)
        continue
      }
      for (const partRow of rows) {
        const part = parseRecord(partRow['data'])
        if (part === undefined) continue
        if (part['type'] === 'text') {
          const text = stringField(part['text'])
          if (text !== undefined) bodyStep(created).content.push({ type: 'text', text })
          continue
        }
        if (part['type'] === 'reasoning') {
          const text = stringField(part['text'])
          if (text !== undefined) bodyStep(created).content.push({ type: 'reasoning', text })
          continue
        }
        if (part['type'] !== 'tool') continue
        const callId = stringField(part['callID']) ?? stringField(part['id'])
        const name = stringField(part['tool']) ?? 'tool'
        if (callId === undefined) continue
        const state = asRecord(part['state'])
        const args = state?.['input'] ?? {}
        const call: NormalizedToolCallBlock = { type: 'tool-call', id: callId, name, arguments: args }
        const target = ensureStep(created)
        target.content.push(call)
        target.toolCalls.push({ id: callId, name, arguments: args })
        const output = state?.['output']
        if (output !== undefined || state?.['status'] === 'completed') {
          target.toolResults.push({
            toolCallId: callId,
            content: [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output ?? '') }],
            ...(created !== undefined ? { timestamp: created } : {}),
            ...(state?.['status'] === 'error' ? { isError: true } : {}),
          })
        }
      }
    }
    const title = stringField(row['title'])
    const cwd = stringField(row['directory'])
    const createdAt = numberField(row['time_created']) ?? 0
    return {
      session: {
        id: targetId ?? openCodeSessionId(sourceId),
        source: { tool: 'opencode', path, sessionId: sourceId },
        createdAt,
        ...(cwd !== undefined ? { cwd } : {}),
        ...(title !== undefined ? { title } : {}),
        turns: turns as unknown as readonly NormalizedTurn[],
      },
      ...(title !== undefined ? { title } : {}),
    }
  } finally {
    db.close()
  }
}

/**
 * The DSH id of an imported OpenCode session. Prefixed, so it never equals the OpenCode id: a session under the
 * source's own id reads as native to other importers (dsh-chat-import hides those sources). Imports by earlier
 * versions used the bare id; they are still found and reused.
 */
export function openCodeSessionId(sourceId: string): string {
  return `opencode-${sourceId}`
}

/** How an import finds the DSH session holding an OpenCode session: earlier versions used the bare id. */
export function openCodeIdentity(sourceId: string): ImportIdentity {
  return { id: openCodeSessionId(sourceId), legacyIds: [sourceId] }
}

/** Import one OpenCode session into DSH session persistence. */
export async function importOpenCodeSession(
  ctx: Context,
  path: string,
  sourceId: string,
  options: { readonly targetId?: string } = {},
): Promise<OpenCodeImportReport> {
  const parsed = await readOpenCodeSession(path, sourceId, options.targetId)
  if (parsed.session.turns.length === 0) throw new Error(`nothing to import from OpenCode session ${sourceId}: it has no conversation`)
  const identity = options.targetId !== undefined ? targetIdentity(options.targetId) : openCodeIdentity(sourceId)
  return importReport(path, parsed.title, await persistImported(ctx, parsed.session, identity))
}

async function openDatabase(path: string): Promise<Database> {
  const { DatabaseSync } = await import('node:sqlite')
  return new DatabaseSync(path, { readOnly: true }) as unknown as Database
}

/** What one session's message and part rows add up to, in bytes; `undefined` when the schema is not one this knows. */
function sessionBytes(db: Database, sourceId: string): number | undefined {
  const sum = (sql: string): number => Number((db.prepare(sql).get(sourceId) as Record<string, unknown> | undefined)?.['bytes'] ?? 0)
  try {
    if (schemaKind(db) === 'v2') return sum('select coalesce(sum(length(cast(data as blob))), 0) as bytes from session_message where session_id = ?')
    return sum('select coalesce(sum(length(cast(data as blob))), 0) as bytes from message where session_id = ?')
      + sum('select coalesce(sum(length(cast(p.data as blob))), 0) as bytes from part p join message m on m.id = p.message_id where m.session_id = ?')
  } catch {
    return undefined
  }
}

function schemaKind(db: Database): 'v1' | 'v2' {
  const names = new Set((db.prepare("select name from sqlite_master where type='table'").all() as Array<Record<string, unknown>>).map(row => String(row['name'])))
  return names.has('session_v2') ? 'v2' : 'v1'
}

function readOpenCodeV2(db: Database, path: string, sourceId: string, targetId?: string): { session: NormalizedSession; title?: string } {
  const row = db.prepare('select id, title, directory, time_created from session_v2 where id = ?').get(sourceId) as Record<string, unknown> | undefined
  if (row === undefined) throw new Error(`OpenCode session not found: ${sourceId}`)
  const messages = db.prepare('select id, type, data, time_created from session_message where session_id = ? order by seq, time_created').iterate(sourceId) as Iterable<Record<string, unknown>>
  const turns: MutableTurn[] = []
  let current: MutableTurn | undefined
  let step: MutableStep | undefined
  const startTurn = (prompt: string, at?: number): void => {
    current = { number: turns.length + 1, prompt, ...(at !== undefined ? { timestamp: at } : {}), steps: [] }
    turns.push(current)
    step = undefined
  }
  const ensureStep = (at?: number): MutableStep => {
    if (current === undefined) startTurn('', at)
    if (step === undefined) {
      step = { number: current!.steps.length + 1, ...(at !== undefined ? { timestamp: at } : {}), content: [], toolCalls: [], toolResults: [] }
      current!.steps.push(step)
    }
    return step
  }
  const bodyStep = (at?: number): MutableStep => {
    if (step !== undefined && step.toolCalls.length > 0) step = undefined
    return ensureStep(at)
  }
  for (const message of messages) {
    const data = parseRecord(message['data'])
    if (data === undefined) continue
    const messageTime = numberField(message['time_created'])
    const created = numberField(asRecord(data['time'])?.['created']) ?? messageTime
    if (message['type'] === 'user') {
      const prompt = stringField(data['text']) ?? contentText(data['content'])
      startTurn(prompt, created)
      continue
    }
    if (message['type'] !== 'assistant') continue
    const blocks = Array.isArray(data['content']) ? data['content'] : []
    for (const value of blocks) {
      const block = asRecord(value)
      if (block === undefined) continue
      if (block['type'] === 'text') {
        const text = stringField(block['text'])
        if (text !== undefined) bodyStep(created).content.push({ type: 'text', text })
        continue
      }
      if (block['type'] === 'reasoning') {
        const text = stringField(block['text'])
        if (text !== undefined) bodyStep(created).content.push({ type: 'reasoning', text })
        continue
      }
      if (block['type'] !== 'tool') continue
      const callId = stringField(block['callID']) ?? stringField(block['id'])
      const name = stringField(block['tool']) ?? stringField(block['name']) ?? 'tool'
      if (callId === undefined) continue
      const state = asRecord(block['state'])
      const args = state?.['input'] ?? {}
      const target = ensureStep(created)
      target.content.push({ type: 'tool-call', id: callId, name, arguments: args })
      target.toolCalls.push({ id: callId, name, arguments: args })
      const output = state?.['output'] ?? contentText(state?.['content'])
      if (output !== undefined || state?.['status'] === 'completed') {
        target.toolResults.push({
          toolCallId: callId,
          content: [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output ?? '') }],
          ...(created !== undefined ? { timestamp: created } : {}),
          ...(state?.['status'] === 'error' ? { isError: true } : {}),
        })
      }
    }
  }
  const title = stringField(row['title'])
  const cwd = stringField(row['directory'])
  const createdAt = numberField(row['time_created']) ?? 0
  return {
    session: {
      id: targetId ?? openCodeSessionId(sourceId),
      source: { tool: 'opencode', path, sessionId: sourceId },
      createdAt,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(title !== undefined ? { title } : {}),
      turns: turns as unknown as readonly NormalizedTurn[],
    },
    ...(title !== undefined ? { title } : {}),
  }
}

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return typeof value === 'string' ? value : ''
  return value
    .map((item) => {
      const block = asRecord(item)
      return block?.['type'] === 'text' && typeof block['text'] === 'string' ? block['text'] : ''
    })
    .filter(Boolean)
    .join('\n')
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function isTextPart(part: Record<string, unknown> | undefined): part is Record<string, unknown> & { text: string } {
  return part !== undefined && part['type'] === 'text' && typeof part['text'] === 'string'
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
