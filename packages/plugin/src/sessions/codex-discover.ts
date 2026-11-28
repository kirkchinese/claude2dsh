/**
 * Listing Codex sessions for import. Codex keeps one rollout file per thread (some a gigabyte), in
 * `sessions/YYYY/MM/DD`, plus the threads it archived in `archived_sessions`; the thread names the person gave
 * are in `session_index.jsonl`. The list is built from file names and modification times alone, newest first; only
 * the files of the page asked for are opened, and only their first bytes.
 * @module @kirkchinese/harness-forge
 */
import { open, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { SESSION_PAGE_SIZE, type SessionPage, type SessionPageRequest } from '../forge/contract.js'
import { stringField } from './codex-text.js'
import { CodexTitle, rolloutCreatedAt, rolloutThread, threadNames, type IndexedThread } from './codex-meta.js'
import { decodeZstdHead, zstdAvailable } from './zstd.js'

export interface CodexSessionCandidate {
  readonly path: string
  /** The thread. */
  readonly sourceId: string
  /** The session a forked thread belongs to (its parent's), when it is not the thread itself. */
  readonly parentId?: string
  readonly title?: string
  readonly cwd?: string
  /** When the thread was created (as an import stores it). */
  readonly createdAt?: number
  /** When the rollout was last written. */
  readonly updatedAt?: number
  /** The rollout file's size in bytes (compressed, for a `.zst`). */
  readonly bytes?: number
  /** Codex archived the thread (it is in `archived_sessions`). */
  readonly archived?: boolean
  /** A subagent's thread: part of the session that spawned it, listed only when an import of it is stored. */
  readonly subagent?: boolean
}

/** Most files opened for one page: skipped ones (subagent threads) still cost a read. */
const PROBE_LIMIT = 400
/** The `session_meta` line is a few tens of KB (it carries the base instructions). */
const META_BYTES = 64 * 1024
const HEAD_BYTES = 256 * 1024
/** How far into a rollout the first thing the person said is looked for, when it is not in the first bytes. */
const DEEP_HEAD_BYTES = 4 * 1024 * 1024
const COMPRESSED_HEAD_BYTES = 4 * 1024 * 1024

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
/** `rollout-<time>-<thread>.jsonl`; a thread Codex continued in a new file is `…-<thread>_<segment>.jsonl`. */
const ROLLOUT_NAME = new RegExp(`^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-(${UUID})(?:_${UUID})?\\.jsonl(?:\\.zst)?$`, 'iu')
const ROLLOUT_FILE = /^rollout-.*\.jsonl(?:\.zst)?$/u

interface RolloutFile {
  readonly path: string
  /** The thread, from the file name; `undefined` for an older file whose name does not carry it. */
  readonly thread?: string
  readonly updatedAt: number
  readonly bytes: number
  readonly archived: boolean
}

/**
 * One page of the Codex sessions under `root` (`~/.codex/sessions`; the archive and the thread names are read from
 * its siblings), newest first: every `rollout-*.jsonl` and `.jsonl.zst`, a thread once. A subagent's thread is part
 * of the session that spawned it and left out, unless `isImported` says an import of it is stored: an earlier
 * version imported those, and the copy has to stay reachable.
 */
export async function discoverCodexSessions(
  root: string,
  page: SessionPageRequest = {},
  isImported: (subagent: CodexSessionCandidate) => Promise<boolean> = async () => false,
): Promise<SessionPage<CodexSessionCandidate>> {
  const limit = Math.max(1, page.limit ?? SESSION_PAGE_SIZE)
  const files = await listRollouts(root)
  const names = await threadNames(basename(root) === 'sessions' ? dirname(root) : undefined)
  const sessions: CodexSessionCandidate[] = []
  let at = Math.max(0, page.cursor ?? 0)
  const stop = Math.min(files.length, at + PROBE_LIMIT)
  for (; at < stop && sessions.length < limit; at++) {
    const candidate = await probe(files[at]!, names).catch(() => undefined)
    if (candidate !== undefined && (candidate.subagent !== true || await isImported(candidate))) sessions.push(candidate)
  }
  return { sessions, ...(at < files.length ? { next: at } : {}) }
}

/** The thread each rollout file held when it was last read, by path: a rollout's `session_meta` never changes. */
const threadCache = new Map<string, { readonly updatedAt: number; readonly bytes: number; readonly thread: IndexedThread | undefined }>()

/**
 * Every thread the rollouts under `root` hold, subagent threads included (an earlier version imported those too):
 * what tells whether an id an earlier version gave a thread was given to others. Each file's `session_meta` is read
 * once, until the file changes.
 */
export async function codexThreads(root: string): Promise<IndexedThread[]> {
  const threads = new Map<string, IndexedThread>()
  for (const file of await listRollouts(root)) {
    let cached = threadCache.get(file.path)
    if (cached === undefined || cached.updatedAt !== file.updatedAt || cached.bytes !== file.bytes) {
      const meta = await readMeta(file.path).catch(() => undefined)
      const thread = meta === undefined ? undefined : rolloutThread(meta.payload)
      cached = { updatedAt: file.updatedAt, bytes: file.bytes, thread: meta === undefined || thread === undefined ? undefined : { thread, createdAt: rolloutCreatedAt(meta.payload, meta.firstTime), path: file.path } }
      threadCache.set(file.path, cached)
    }
    if (cached.thread !== undefined) threads.set(cached.thread.thread.id, cached.thread)
  }
  return [...threads.values()]
}

/**
 * Every rollout file, a thread once (the file written last), newest first. A thread is told by its file name; an
 * older file whose name does not carry it, by the `session_meta` at its start. Done for the whole list before it is
 * cut into pages, so a thread is on one page only.
 */
async function listRollouts(root: string): Promise<RolloutFile[]> {
  const found: RolloutFile[] = []
  const walk = async (dir: string, archived: boolean): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path, archived)
      else if (entry.isFile() && ROLLOUT_FILE.test(entry.name)) {
        const info = await stat(path).catch(() => undefined)
        const thread = ROLLOUT_NAME.exec(entry.name)?.[1]?.toLowerCase()
        if (info !== undefined) found.push({ path, ...(thread !== undefined ? { thread } : {}), updatedAt: info.mtimeMs, bytes: info.size, archived })
      }
    }
  }
  await walk(root, false)
  if (basename(root) === 'sessions') await walk(join(dirname(root), 'archived_sessions'), true)
  // The compressed twin of a rollout still on disk as plain text is the same session.
  const plain = new Set(found.filter(file => !file.path.endsWith('.zst')).map(file => file.path))
  const readable = found.filter(file => !file.path.endsWith('.zst') || (zstdAvailable() && !plain.has(file.path.slice(0, -'.zst'.length))))
  readable.sort((a, b) => b.updatedAt - a.updatedAt || b.path.localeCompare(a.path))
  const kept = new Set<string>()
  const out: RolloutFile[] = []
  for (const file of readable) {
    const key = file.thread ?? await metaThread(file.path) ?? file.path
    if (kept.has(key)) continue
    kept.add(key)
    out.push(file)
  }
  return out
}

/** The thread an older rollout holds, from its `session_meta`; `undefined` when its first bytes do not say. */
async function metaThread(path: string): Promise<string | undefined> {
  try {
    const meta = await readMeta(path)
    return meta === undefined ? undefined : rolloutThread(meta.payload)?.id.toLowerCase()
  } catch {
    return undefined
  }
}

/** A rollout's `session_meta` record (its payload, and the time of the first record), from its first bytes. */
async function readMeta(path: string): Promise<{ payload: Record<string, unknown>; firstTime: unknown } | undefined> {
  for (const bytes of [META_BYTES, HEAD_BYTES]) {
    const head = records(await readHead(path, bytes))
    const payload = head.find(record => record['type'] === 'session_meta')?.['payload']
    if (typeof payload === 'object' && payload !== null) return { payload: payload as Record<string, unknown>, firstTime: head[0]?.['timestamp'] }
  }
  return undefined
}

async function probe(file: RolloutFile, names: ReadonlyMap<string, string>): Promise<CodexSessionCandidate | undefined> {
  const meta = await readMeta(file.path)
  if (meta === undefined) return undefined
  const thread = rolloutThread(meta.payload)
  if (thread === undefined) return undefined
  const source = meta.payload['source']
  const subagent = typeof source === 'object' && source !== null && 'subagent' in source
  const title = await titleOf(file.path, new CodexTitle(names.get(thread.id)))
  const cwd = stringField(meta.payload['cwd'])
  const createdAt = rolloutCreatedAt(meta.payload, meta.firstTime)
  return {
    path: file.path,
    sourceId: thread.id,
    ...(thread.sessionId !== thread.id ? { parentId: thread.sessionId } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(createdAt > 0 ? { createdAt } : {}),
    updatedAt: file.updatedAt,
    bytes: file.bytes,
    ...(file.archived ? { archived: true } : {}),
    ...(subagent ? { subagent: true } : {}),
  }
}

/** The thread's title: its name, else what the person first said, from the start of the rollout. */
async function titleOf(path: string, title: CodexTitle): Promise<string | undefined> {
  if (title.title !== undefined) return title.title
  for (const bytes of [HEAD_BYTES, DEEP_HEAD_BYTES]) {
    const text = await readHead(path, bytes)
    for (const record of records(text)) {
      title.observe(record)
      if (title.title !== undefined) return title.title
    }
    // The whole file was read, or the whole of what can be decoded: nothing more to find.
    if (Buffer.byteLength(text) < bytes * 0.9) break
  }
  return undefined
}

/** The complete lines among the first `bytes` of a rollout's text (a line cut at the end is dropped). */
function records(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    try {
      const value: unknown = JSON.parse(line)
      if (typeof value === 'object' && value !== null) out.push(value as Record<string, unknown>)
    } catch {
      // The line the read stopped in, or a damaged one.
    }
  }
  return out
}

/** The first `bytes` of a rollout (decoded, when compressed). */
async function readHead(path: string, bytes: number): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const compressed = path.endsWith('.zst')
    const length = compressed ? COMPRESSED_HEAD_BYTES : bytes
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return compressed ? await decodeZstdHead(buffer.subarray(0, bytesRead), bytes) : buffer.toString('utf8', 0, bytesRead)
  } finally {
    await handle.close()
  }
}
