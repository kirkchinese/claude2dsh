/**
 * What listing and importing a Codex rollout must agree on: which thread it is, when it was created, what it is
 * called, and which DSH session holds it. One definition each, so the row a person picks is the session they get.
 * @module @kirkchinese/harness-forge
 */
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { ImportIdentity } from './persist.js'
import type { TurnReader } from './turns.js'
import { stringField, textOf, timestamp, usablePrompt } from './codex-text.js'

/** Longest title, in characters: a long first message is no title past a line or so. */
const TITLE_CHARS = 120
/** The thread names file stays small (one line per rename); a larger one is not Codex's and is not read. */
const INDEX_MAX_BYTES = 16 * 1024 * 1024

/** Which thread a rollout holds, from its `session_meta` payload. */
export interface RolloutThread {
  /** The thread (`id`). */
  readonly id: string
  /** The session the thread belongs to (`session_id`): a forked thread's parent, else the thread itself. */
  readonly sessionId: string
}

/** The thread of a `session_meta` payload. `id` is the thread; `session_id` of a forked thread is its parent's. */
export function rolloutThread(meta: Readonly<Record<string, unknown>>): RolloutThread | undefined {
  const id = stringField(meta['id']) ?? stringField(meta['session_id'])
  if (id === undefined) return undefined
  return { id, sessionId: stringField(meta['session_id']) ?? id }
}

/**
 * When a rollout's thread was created: its `session_meta` time, else the time of its first record; 0 when it has
 * none. Every Harness Forge version stored this as the DSH session's `createdAt`, which is what tells which thread a
 * stored session holds.
 */
export function rolloutCreatedAt(meta: Readonly<Record<string, unknown>>, firstRecordTime: unknown): number {
  return timestamp(meta['timestamp']) ?? timestamp(firstRecordTime) ?? 0
}

/**
 * The DSH id of an imported Codex session. Prefixed, so it never equals the Codex id: a session under the source's
 * own id reads as native to other importers (dsh-chat-import hides those sources).
 */
export function codexSessionId(sourceId: string): string {
  return `codex-${sourceId}`
}

/**
 * The ids earlier versions gave a thread. Harness Forge 0.4.0 used the bare `session_meta.session_id ?? id`, and
 * builds after it, before this one, the same prefixed (`codex-<session_id>`); a fork carries its parent's
 * `session_id`, so the parent and its forks got one id. Older ones used the bare thread id.
 */
function codexLegacyIds(thread: RolloutThread): string[] {
  const id = codexSessionId(thread.id)
  return [...new Set([codexSessionId(thread.sessionId), thread.sessionId, thread.id])].filter(legacy => legacy !== id)
}

/** A thread a rollout holds, when it was created, and the rollout. */
export interface IndexedThread {
  readonly thread: RolloutThread
  readonly createdAt: number
  readonly path: string
}

/** What tells which thread a stored session holds, beyond its creation time; each read only when it is needed. */
export interface CodexEvidence {
  /** Every thread the rollouts beside this one hold (this one may be among them). */
  threads(): Promise<readonly IndexedThread[]>
  /** A reader of this thread's turns, as the import reads them. */
  turns(): TurnReader
  /** A reader of another rollout's turns. */
  turnsOf(path: string): TurnReader
}

/**
 * How an import finds the DSH session holding a thread: under its own id, or an id an earlier version gave it if
 * the stored session's creation time is the thread's, and, when that id was given to other threads too, its turns
 * are this thread's ({@link matchStored}).
 */
export function codexIdentity(thread: RolloutThread, createdAt: number, evidence: CodexEvidence): ImportIdentity {
  const id = codexSessionId(thread.id)
  return {
    id,
    legacyIds: codexLegacyIds(thread),
    provenance: {
      createdAt,
      alternateId: `${id}-${createdAt}`,
      // The other threads created at this one's time that may be stored under the id, as their own (this
      // version's) or as an earlier version's: a thread created at another time is not the one stored there.
      rivals: async (legacyId) => (await evidence.threads())
        .filter(other => other.thread.id !== thread.id && other.createdAt === createdAt
          && (codexSessionId(other.thread.id) === legacyId || codexLegacyIds(other.thread).includes(legacyId)))
        .map(other => () => evidence.turnsOf(other.path)),
      turns: () => evidence.turns(),
    },
  }
}

/** Text on one line, whitespace collapsed and cut at {@link TITLE_CHARS}; `undefined` when nothing is left. */
export function oneLine(text: string): string | undefined {
  const line = text.trim().replace(/\s+/gu, ' ')
  if (line.length === 0) return undefined
  return line.length <= TITLE_CHARS ? line : `${line.slice(0, TITLE_CHARS - 1).trimEnd()}…`
}

/** The text a person typed in one record: a message, whichever of Codex's ways of writing it. */
export function typedPrompt(record: Readonly<Record<string, unknown>>): string | undefined {
  const payload = record['payload'] as Record<string, unknown> | undefined
  if (payload === undefined) return undefined
  let text: string | undefined
  if (record['type'] === 'event_msg' && payload['type'] === 'user_message') text = stringField(payload['message'])
  else if (record['type'] === 'event_msg' && payload['type'] === 'item_completed') {
    const item = payload['item'] as Record<string, unknown> | undefined
    if (item?.['type'] === 'UserMessage') text = textOf(item['content'])
  } else if (record['type'] === 'response_item' && payload['type'] === 'message' && payload['role'] === 'user') text = textOf(payload['content'])
  return text !== undefined && usablePrompt(text) ? text : undefined
}

/**
 * A Codex thread's title, chosen the way Codex shows it: the name the person gave the thread (in
 * `session_index.jsonl`), else what they first said. The list and the import both take it from here.
 */
export class CodexTitle {
  private prompt: string | undefined

  constructor(private readonly name?: string) {}

  /** Look at one record of the rollout, in file order. */
  observe(record: Readonly<Record<string, unknown>>): void {
    if (this.name !== undefined || this.prompt !== undefined) return
    const typed = typedPrompt(record)
    if (typed !== undefined) this.prompt = oneLine(typed)
  }

  get title(): string | undefined {
    return this.name ?? this.prompt
  }
}

/** The Codex home a rollout is in (`~/.codex` for `~/.codex/sessions/…` or `~/.codex/archived_sessions/…`). */
export function codexHomeOf(rolloutPath: string): string | undefined {
  for (let dir = dirname(rolloutPath); dirname(dir) !== dir; dir = dirname(dir)) {
    if (basename(dir) === 'sessions' || basename(dir) === 'archived_sessions') return dirname(dir)
  }
  return undefined
}

/** Thread names from `session_index.jsonl` in a Codex home, by thread id; a later line for a thread (a rename) wins. */
export async function threadNames(codexHome: string | undefined): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  if (codexHome === undefined) return names
  const path = join(codexHome, 'session_index.jsonl')
  try {
    if ((await stat(path)).size > INDEX_MAX_BYTES) return names
    for (const line of (await readFile(path, 'utf8')).split(/\r?\n/u)) {
      if (line.trim().length === 0) continue
      try {
        const entry = JSON.parse(line) as { id?: unknown; thread_name?: unknown }
        const name = typeof entry.thread_name === 'string' ? oneLine(entry.thread_name) : undefined
        if (typeof entry.id === 'string' && name !== undefined) names.set(entry.id, name)
      } catch {
        // A line cut by a crash; the rest of the index is intact.
      }
    }
  } catch {
    // No index: titles come from the first message.
  }
  return names
}
