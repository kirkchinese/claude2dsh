/**
 * In-memory stand-in for the host session-persistence service.
 *
 * It implements the handle contract the plugin is written against — exclusive
 * write ownership, contiguous append, monotonic reads, header validation — so a
 * test that imports, exports, syncs or merges exercises the same
 * open/append/flush/close sequence production does, rather than a mock whose
 * shape has to be kept in step by hand.
 * @module test/support/fake-persistence
 */
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'

/** Minimal context carrying only the persistence service the plugin reads. */
export interface FakeContext {
  sessionPersistence: FakePersistence
}

/** One stored session held by {@link FakePersistence}. */
interface StoredEntry {
  header: SessionHeader
  events: SessionEvent[]
  writerOwned: boolean
}

/** Error raised for a session id that was never created. */
export class FakeNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`session not found: ${sessionId}`)
    this.name = 'SessionPersistenceNotFoundError'
  }
}

/** Error raised when a second writer opens the same session. */
export class FakeAlreadyOwnedError extends Error {
  constructor(sessionId: string) {
    super(`session ${sessionId} already has a writer`)
    this.name = 'SessionAlreadyOwnedError'
  }
}

/** The subset of the host service the plugin calls. */
export class FakePersistence {
  private readonly entries = new Map<string, StoredEntry>()
  /** Number of successful append calls, for assertions about what was written. */
  appendCalls = 0
  /** Number of `create` calls, for assertions that nothing was created. */
  createCalls = 0

  /** Seed one stored session without going through `create`. */
  seed(header: SessionHeader, events: readonly SessionEvent[] = []): void {
    this.entries.set(String(header.id), { header, events: [...events], writerOwned: false })
  }

  /** All stored events for one session, or an empty list when it is absent. */
  eventsOf(sessionId: string): readonly SessionEvent[] {
    return this.entries.get(sessionId)?.events ?? []
  }

  /** Whether a session id exists. */
  has(sessionId: string): boolean {
    return this.entries.has(sessionId)
  }

  async create(header: SessionHeader, options?: { inheritedEventCount?: number }): Promise<FakeHandle> {
    const id = String(header.id)
    if (this.entries.has(id)) throw new Error(`session ${id} already exists`)
    if (!Number.isSafeInteger(header.createdAt) || header.createdAt < 0) {
      throw new TypeError('session metadata createdAt must be a non-negative safe integer')
    }
    void options
    const entry: StoredEntry = { header, events: [], writerOwned: true }
    this.entries.set(id, entry)
    this.createCalls += 1
    return new FakeHandle(this, id, entry, 'write')
  }

  async open(sessionId: SessionId, access: 'read' | 'write'): Promise<FakeHandle> {
    const id = String(sessionId)
    const entry = this.entries.get(id)
    if (entry === undefined) throw new FakeNotFoundError(id)
    if (access === 'write') {
      if (entry.writerOwned) throw new FakeAlreadyOwnedError(id)
      entry.writerOwned = true
    }
    return new FakeHandle(this, id, entry, access)
  }

  async stat(sessionId: SessionId): Promise<SessionPersistenceSnapshot | undefined> {
    const entry = this.entries.get(String(sessionId))
    if (entry === undefined) return undefined
    return {
      header: entry.header,
      revision: 0 as SessionPersistenceSnapshot['revision'],
      eventCount: entry.events.length,
    }
  }

  async list(): Promise<readonly SessionPersistenceSnapshot[]> {
    return await Promise.all([...this.entries.keys()].map(async (id) => await this.stat(id as SessionId) as SessionPersistenceSnapshot))
  }

  async flush(): Promise<void> {}

  /** Append on behalf of a handle, enforcing the host's contiguity rule. */
  commit(id: string, events: readonly SessionEvent[], access: 'read' | 'write'): void {
    if (access !== 'write') throw new Error(`session ${id} handle is read-only`)
    const entry = this.entries.get(id)
    if (entry === undefined) throw new FakeNotFoundError(id)
    for (const [index, event] of events.entries()) {
      const expected = entry.events.length + index
      if (event.seq !== expected) throw new Error(`append seq mismatch for "${id}": expected ${expected}, got ${event.seq}`)
    }
    entry.events.push(...events)
    this.appendCalls += 1
  }

  /** Release write ownership held by a closing handle. */
  release(id: string): void {
    const entry = this.entries.get(id)
    if (entry !== undefined) entry.writerOwned = false
  }
}

/** One open channel onto a {@link FakePersistence} entry. */
export class FakeHandle {
  private readonly store: FakePersistence
  private readonly sessionId: string
  private readonly entry: StoredEntry
  readonly access: 'read' | 'write'

  constructor(store: FakePersistence, sessionId: string, entry: StoredEntry, access: 'read' | 'write') {
    this.store = store
    this.sessionId = sessionId
    this.entry = entry
    this.access = access
  }

  get id(): SessionId {
    return this.sessionId as SessionId
  }

  get header(): SessionHeader {
    return this.entry.header
  }

  get inheritedEventCount(): number {
    return 0
  }

  async read(offset = 0): Promise<{ eventState: 'detached'; events: readonly SessionEvent[] }> {
    return { eventState: 'detached', events: this.entry.events.slice(offset) }
  }

  async append(events: readonly SessionEvent[]): Promise<void> {
    this.store.commit(this.sessionId, events, this.access)
  }

  async flush(): Promise<void> {}

  async close(): Promise<void> {
    if (this.access === 'write') this.store.release(this.sessionId)
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }
}

/**
 * Build a valid stored header for a seeded test session.
 * @param id - session id.
 * @param overrides - header fields to replace.
 * @returns a header the fake accepts at `create` and `seed`.
 */
export function fakeHeader(id: string, overrides: Partial<SessionHeader> = {}): SessionHeader {
  return {
    version: 3,
    id: id as SessionId,
    createdAt: 0,
    isSeeded: false,
    ...overrides,
  } as SessionHeader
}

/** A context whose persistence service starts empty. */
export function liveContext(): FakeContext & { sessionPersistence: FakePersistence } {
  return { sessionPersistence: new FakePersistence() }
}

/**
 * A context whose persistence service already holds the listed sessions.
 * @param headers - headers to seed, each with an optional event log.
 * @returns the context and its backing fake for later assertions.
 */
export function contextWith(
  entries: readonly { header: SessionHeader; events?: readonly SessionEvent[] }[],
): FakeContext & { sessionPersistence: FakePersistence } {
  const persistence = new FakePersistence()
  for (const entry of entries) persistence.seed(entry.header, entry.events ?? [])
  return { sessionPersistence: persistence }
}
