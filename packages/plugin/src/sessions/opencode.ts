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
import { synthesizeDshSession } from '@kirkchinese/harness-forge-core'
import { dshService } from '../dsh/host.js'

interface PersistenceHandle {
  append(events: readonly unknown[]): Promise<void>
  flush(): Promise<void>
  close(): Promise<void>
}
interface SessionPersistence {
  create(header: Record<string, unknown>): Promise<PersistenceHandle>
}
interface Database {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown }
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
}
export interface OpenCodeImportReport {
  readonly id: string
  readonly sourcePath: string
  readonly title?: string
  readonly turns: number
  readonly events: number
  readonly stats: Record<string, number>
}

/** Default OpenCode database path (the desktop build uses ~/.local/share). */
export function defaultOpenCodeDatabase(home = homedir()): string {
  const xdg = join(home, '.local', 'share', 'opencode', 'opencode.db')
  if (existsSync(xdg)) return xdg
  const local = process.env.LOCALAPPDATA === undefined ? undefined : join(process.env.LOCALAPPDATA, 'opencode', 'opencode.db')
  return local ?? xdg
}

/** Discover top-level OpenCode sessions (subagent sessions are excluded). */
export async function discoverOpenCodeSessions(path = defaultOpenCodeDatabase(), limit = 200): Promise<OpenCodeSessionCandidate[]> {
  const db = await openDatabase(path)
  try {
    const schema = schemaKind(db)
    const rows = schema === 'v2'
      ? db.prepare('select id, title, directory, time_created from session_v2 where parent_id is null order by time_updated desc limit ?').all(limit) as Array<Record<string, unknown>>
      : db.prepare('select id, title, directory, time_created from session where parent_id is null order by time_updated desc limit ?').all(limit) as Array<Record<string, unknown>>
    return rows.map((row) => {
      const title = stringField(row['title'])
      const cwd = stringField(row['directory'])
      const createdAt = numberField(row['time_created'])
      return {
        path,
        sourceId: String(row['id']),
        source: 'opencode' as const,
        ...(title !== undefined ? { title } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
        ...(createdAt !== undefined ? { createdAt } : {}),
      }
    })
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
    if (schemaKind(db) === 'v2') return readOpenCodeV2(db, path, sourceId, targetId)
    const row = db.prepare('select id, title, directory, time_created from session where id = ?').get(sourceId) as Record<string, unknown> | undefined
    if (row === undefined) throw new Error(`OpenCode session not found: ${sourceId}`)
    const messages = db.prepare('select id, data from message where session_id = ? order by time_created').all(sourceId) as Array<Record<string, unknown>>
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
    for (const message of messages) {
      const data = parseRecord(message['data'])
      if (data === undefined) continue
      const created = numberField(asRecord(data['time'])?.['created'])
      const role = data['role']
      const parts = db.prepare('select data from part where message_id = ? order by time_created').all(String(message['id'])) as Array<Record<string, unknown>>
      if (role === 'user') {
        const prompt = parts.map(part => parseRecord(part['data'])).filter(isTextPart).map(part => part['text']).join('\n')
        startTurn(prompt, created)
        continue
      }
      if (role !== 'assistant') continue
      for (const partRow of parts) {
        const part = parseRecord(partRow['data'])
        if (part === undefined) continue
        if (part['type'] === 'text') {
          const text = stringField(part['text'])
          if (text !== undefined) ensureStep(created).content.push({ type: 'text', text })
          continue
        }
        if (part['type'] === 'reasoning') {
          const text = stringField(part['text'])
          if (text !== undefined) ensureStep(created).content.push({ type: 'reasoning', text })
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
        id: targetId ?? sourceId,
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

/** Import one OpenCode session into DSH session persistence. */
export async function importOpenCodeSession(
  ctx: Context,
  path: string,
  sourceId: string,
  options: { readonly targetId?: string } = {},
): Promise<OpenCodeImportReport> {
  const persistence = dshService(ctx, 'sessionPersistence') as SessionPersistence | undefined
  if (persistence === undefined) throw new Error('sessionPersistence service is not available')
  const parsed = await readOpenCodeSession(path, sourceId, options.targetId)
  if (parsed.session.turns.length === 0) throw new Error(`nothing to import from OpenCode session ${sourceId}: it has no conversation`)
  const synthesized = synthesizeDshSession(parsed.session)
  const events = synthesized.events
  const handle = await persistence.create({
    version: 4,
    id: synthesized.meta.id,
    createdAt: synthesized.meta.createdAt,
    isSeeded: false,
    ...(synthesized.meta.cwd !== undefined ? { cwd: synthesized.meta.cwd } : {}),
    delegationDepth: synthesized.meta.delegationDepth,
    ...(synthesized.meta.origin !== undefined ? { origin: synthesized.meta.origin } : {}),
    ...(synthesized.meta.parentSession !== undefined ? { parentSession: synthesized.meta.parentSession } : {}),
  })
  try {
    await handle.append(events)
    await handle.flush()
  } finally {
    await handle.close()
  }
  return {
    id: synthesized.meta.id,
    sourcePath: path,
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

async function openDatabase(path: string): Promise<Database> {
  const { DatabaseSync } = await import('node:sqlite')
  return new DatabaseSync(path, { readOnly: true }) as unknown as Database
}

function schemaKind(db: Database): 'v1' | 'v2' {
  const names = new Set((db.prepare("select name from sqlite_master where type='table'").all() as Array<Record<string, unknown>>).map(row => String(row['name'])))
  return names.has('session_v2') ? 'v2' : 'v1'
}

function readOpenCodeV2(db: Database, path: string, sourceId: string, targetId?: string): { session: NormalizedSession; title?: string } {
  const row = db.prepare('select id, title, directory, time_created from session_v2 where id = ?').get(sourceId) as Record<string, unknown> | undefined
  if (row === undefined) throw new Error(`OpenCode session not found: ${sourceId}`)
  const messages = db.prepare('select id, type, data, time_created from session_message where session_id = ? order by seq, time_created').all(sourceId) as Array<Record<string, unknown>>
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
        if (text !== undefined) ensureStep(created).content.push({ type: 'text', text })
        continue
      }
      if (block['type'] === 'reasoning') {
        const text = stringField(block['text'])
        if (text !== undefined) ensureStep(created).content.push({ type: 'reasoning', text })
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
      id: targetId ?? sourceId,
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
