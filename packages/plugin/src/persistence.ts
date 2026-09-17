/**
 * One home for every host session-persistence call Claude2DSH makes.
 *
 * DSH 0.1.5 replaced the service-level `create`/`append`/`readFrom`/`inspect`
 * API with per-session handles: a stored session is addressed by
 * `create(header)` or `open(id, access)`, every read and write happens on that
 * handle, and `close()` is the one teardown. Import, export, sync, merge and the
 * settings routes all go through this module so the open/operate/close sequence
 * exists once instead of once per caller.
 *
 * Reads never take ownership, so they work while an agent has the session open.
 * A write open is exclusive: when a live agent already owns the session, the
 * caller gets an explicit "retry when the agent is idle" error rather than a
 * backend ownership error leaking through the tool result.
 * @module @claude2dsh/plugin
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import {
  SessionAlreadyOwnedError,
  SessionPersistenceNotFoundError,
  type SessionHandle,
} from '@deepseek-ai/dsh-session-persistence'

/** One stored session's header and its complete validated event log. */
export interface StoredSession {
  /** Immutable header as stored. */
  readonly header: SessionHeader
  /** Contiguous events from seq 0. */
  readonly events: readonly SessionEvent[]
}

/** Describe why an open failed in terms the caller can act on. */
function openFailure(sessionId: string, access: 'read' | 'write', error: unknown): Error {
  if (error instanceof SessionPersistenceNotFoundError) {
    return new Error(`session not found: ${sessionId}`, { cause: error })
  }
  if (error instanceof SessionAlreadyOwnedError) {
    return new Error(
      `session ${sessionId} is open for writing by a live agent; retry after that agent is idle or closed`,
      { cause: error },
    )
  }
  const detail = error instanceof Error ? error.message : String(error)
  return new Error(`cannot open session ${sessionId} for ${access}: ${detail}`, { cause: error })
}

/** Open a handle, run one operation, and always close the handle. */
async function withHandle<T>(
  ctx: Context,
  sessionId: string,
  access: 'read' | 'write',
  run: (handle: SessionHandle) => Promise<T>,
): Promise<T> {
  let handle: SessionHandle
  try {
    handle = await ctx.sessionPersistence.open(sessionId as SessionId, access)
  } catch (error) {
    throw openFailure(sessionId, access, error)
  }
  try {
    return await run(handle)
  } finally {
    await handle.close()
  }
}

/**
 * List every stored session's header.
 * @param ctx - host context carrying `sessionPersistence`.
 * @returns one header per stored session, in the host's own order.
 */
export async function listSessionHeaders(ctx: Context): Promise<readonly SessionHeader[]> {
  const snapshots = await ctx.sessionPersistence.list()
  return snapshots.map((snapshot) => snapshot.header)
}

/**
 * Read one stored session's header without loading its event log.
 * @param ctx - host context carrying `sessionPersistence`.
 * @param sessionId - stored session to observe.
 * @returns the header, or undefined when the session does not exist.
 */
export async function findSessionHeader(ctx: Context, sessionId: string): Promise<SessionHeader | undefined> {
  const snapshot = await ctx.sessionPersistence.stat(sessionId as SessionId)
  return snapshot?.header
}

/**
 * Read a stored session's event log.
 * @param ctx - host context carrying `sessionPersistence`.
 * @param sessionId - stored session to read.
 * @param fromSeq - first event sequence to include; defaults to the log start.
 * @returns the contiguous events from `fromSeq`.
 */
export async function readSessionEvents(ctx: Context, sessionId: string, fromSeq = 0): Promise<readonly SessionEvent[]> {
  return await withHandle(ctx, sessionId, 'read', async (handle) => (await handle.read(fromSeq)).events)
}

/**
 * Read a stored session's header and complete event log in one open.
 * @param ctx - host context carrying `sessionPersistence`.
 * @param sessionId - stored session to read.
 * @returns the stored header and its events.
 */
export async function inspectStoredSession(ctx: Context, sessionId: string): Promise<StoredSession> {
  return await withHandle(ctx, sessionId, 'read', async (handle) => ({
    header: handle.header,
    events: (await handle.read(0)).events,
  }))
}

/**
 * Count a stored session's committed events without materializing them when the
 * backend can answer from metadata.
 * @param ctx - host context carrying `sessionPersistence`.
 * @param sessionId - stored session to measure.
 * @returns the event count, or undefined when the session does not exist.
 */
export async function storedEventCount(ctx: Context, sessionId: string): Promise<number | undefined> {
  const snapshot = await ctx.sessionPersistence.stat(sessionId as SessionId)
  if (snapshot === undefined) return undefined
  if (snapshot.eventCount !== undefined) return snapshot.eventCount
  return await withHandle(ctx, sessionId, 'read', async (handle) => (await handle.read(0)).events.length)
}

/**
 * Create a stored session and commit its first event batch.
 *
 * The id is claimed, the batch appended, and durability requested before the
 * write handle is released, so a caller that observes resolution can immediately
 * list and open the session.
 * @param ctx - host context carrying `sessionPersistence`.
 * @param header - header to store; the provider validates and stamps it.
 * @param events - first contiguous batch, starting at seq 0.
 * @throws when the id already exists or the batch is not a legal seq sequence.
 */
export async function createStoredSession(
  ctx: Context,
  header: SessionHeader,
  events: readonly SessionEvent[],
): Promise<void> {
  const handle = await ctx.sessionPersistence.create(header)
  try {
    await handle.append(events)
    await handle.flush()
  } finally {
    await handle.close()
  }
}

/**
 * Append a contiguous batch to an existing stored session.
 * @param ctx - host context carrying `sessionPersistence`.
 * @param sessionId - stored session to extend.
 * @param events - batch whose first `seq` equals the stored next sequence.
 * @throws when another owner holds the session or the batch breaks contiguity.
 */
export async function appendStoredEvents(ctx: Context, sessionId: string, events: readonly SessionEvent[]): Promise<void> {
  if (events.length === 0) return
  await withHandle(ctx, sessionId, 'write', async (handle) => {
    await handle.append(events)
    await handle.flush()
  })
}
