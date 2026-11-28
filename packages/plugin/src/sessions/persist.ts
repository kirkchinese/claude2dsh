/**
 * The hand-off of a synthesized session to DSH, shared by every importer: write it through
 * `sessionPersistence`, place it in the workspace of its directory, and make it live, so the sidebar lists it
 * with its title under its project and "Open" works at once. Writing the log alone leaves it unknown to the
 * running DSH (`sessions.retain: unknown session`, "Untitled" under "Ungrouped") until a restart.
 * @module @kirkchinese/harness-forge
 */
import { realpathSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { synthesizeDshSession, type NormalizedSession, type SynthesizedSession } from '@kirkchinese/harness-forge-core'
import { dshService } from '../dsh/host.js'
import { compareTurns, replyText, turnReader, turnText, type TurnComparison, type TurnReader, type TurnText } from './turns.js'

interface PersistenceHandle {
  append(events: readonly unknown[]): Promise<void>
  flush(): Promise<void>
  close(): Promise<void>
}

interface ReadHandle {
  /** `length` events from `offset`: fewer at the end of the log. */
  read(offset?: number, length?: number): Promise<{ readonly events: readonly unknown[] }>
  close(): Promise<void>
}

interface SessionPersistence {
  create(header: Record<string, unknown>): Promise<PersistenceHandle>
  list?(): Promise<readonly unknown[]>
  open?(id: string, access: 'read'): Promise<ReadHandle>
}

interface Workspace {
  readonly path: string
  readonly sessionIds?: readonly string[]
  attachSession(sessionId: string): Promise<void>
}

interface WorkspaceRegistry {
  create(path: string): Promise<Workspace>
  /** DSH's archive set: sessions the person archived, hidden from every grouping. */
  readonly archivedSessionIds?: readonly string[]
  unarchiveSession?(sessionId: string): Promise<void>
}

interface SessionController {
  resolveAgent(sessionId: string): Promise<{ agent?: unknown; error?: unknown }>
}

interface Agents {
  get?(sessionId: string): unknown
  resume?(options: { resumeSessionId: string; agentOptions?: unknown }): Promise<unknown>
}

interface DefaultModel {
  currentSelection(): { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
}

/** Where an imported session ended up. */
export interface PersistedSession {
  readonly id: string
  /** The session was already in DSH (imported before): it was opened, not written again. */
  readonly reused: boolean
  /** The session is live in this DSH, so the browser can open it now. */
  readonly live: boolean
  /** The workspace the session is grouped under, when its directory is one. */
  readonly workspace?: string
}

/** What DSH stores of a session that says which source session it holds. */
export interface StoredSession {
  readonly id: string
  /** The header's creation time; importers write the source session's own. */
  readonly createdAt?: number
  /** The directory the session was in: its workspace. */
  readonly cwd?: string
}

/**
 * What tells which source session a stored one holds, when an id may have been given to several: Harness Forge
 * 0.4.0 gave a Codex thread and its forks one id, the bare `session_id` they share.
 */
export interface Provenance {
  /** When the source session was created; every version stored it as the DSH session's `createdAt`. */
  readonly createdAt: number
  /** Written under when `id` holds another session. */
  readonly alternateId: string
  /**
   * The other source sessions created at the same time that an earlier version may have stored under `legacyId`
   * (forks can be created in one millisecond): a reader of each one's turns, opened when called.
   */
  rivals(legacyId: string): Promise<ReadonlyArray<() => TurnReader>>
  /** A reader of this source session's turns. */
  turns(): TurnReader
}

/** How an import finds the DSH session that already holds its source session, and the id it writes under. */
export interface ImportIdentity {
  /** The id this version gives the session. */
  readonly id: string
  /** Ids earlier versions gave it; one stored is reused. */
  readonly legacyIds: readonly string[]
  /**
   * Set when an earlier version's id may have been given to another source session too: see {@link matchStored}.
   * Without it, a session stored under any of the ids holds this one.
   */
  readonly provenance?: Provenance
}

/** Whether DSH already holds a source session. */
export type StoredMatch =
  /** It does, as `id`. */
  | { readonly kind: 'imported'; readonly id: string }
  /** `id` may hold it, and nothing says whether it does; importing it as new writes `newId`. */
  | { readonly kind: 'maybe'; readonly id: string; readonly newId: string }
  /** It does not; an import writes `id`. */
  | { readonly kind: 'new'; readonly id: string }

/**
 * The same for listing and import: find the stored session that holds the source session, by id and provenance.
 *
 * With provenance, a session under this version's own ids holds the source unless its creation time says otherwise.
 * One under an earlier version's id holds it when it was created when the source was, and no other source session
 * created then may be stored under that id; else only when, of all those source sessions, this is the one whose
 * every turn (prompt and answer) is the stored session's ({@link uniqueFullMatch}). A session whose time is unknown,
 * or that more than one or none of them match in full, is left to the person.
 */
export async function matchStored(identity: ImportIdentity, stored: StoredSessions): Promise<StoredMatch> {
  const provenance = identity.provenance
  const own = provenance === undefined ? [identity.id] : [identity.id, provenance.alternateId]
  let maybe: string | undefined
  for (const id of new Set([...own, ...identity.legacyIds])) {
    const header = stored.get(id)
    if (header === undefined) continue
    if (provenance === undefined) return { kind: 'imported', id }
    const same = sameOrigin(header.createdAt, provenance.createdAt)
    // Without times to compare, this version's own ids are taken at their word: it gives them to this session only.
    if (own.includes(id) && same !== false) return { kind: 'imported', id }
    if (same === undefined) maybe ??= id
    if (same !== true) continue
    const rivals = await provenance.rivals(id)
    if (rivals.length === 0) return { kind: 'imported', id }
    const verdict = await uniqueFullMatch(stored.turns(id), provenance, rivals)
    if (verdict === 'this') return { kind: 'imported', id }
    if (verdict === 'unknown') maybe ??= id
  }
  const free = own.find(id => !stored.has(id))
  if (free === undefined) throw new Error(`cannot import as ${own.join(' or ')}: DSH holds other sessions under those ids`)
  return maybe !== undefined ? { kind: 'maybe', id: maybe, newId: free } : { kind: 'new', id: free }
}

/** Whether two creation times are one session's; `undefined` when one is not known (a source without timestamps). */
function sameOrigin(stored: number | undefined, source: number): boolean | undefined {
  if (stored === undefined || !Number.isFinite(stored) || stored <= 0 || !Number.isFinite(source) || source <= 0) return undefined
  return stored === source
}

/**
 * Which of the source sessions that may be stored under one id it holds: `this` one, when its every turn is the
 * stored session's and no rival's is; `other` when its turns part ways with the stored session's, or a rival alone
 * matches in full; else `unknown` (several match, or none does in full: one only begins like the other).
 */
async function uniqueFullMatch(stored: TurnReader, provenance: Provenance, rivals: ReadonlyArray<() => TurnReader>): Promise<'this' | 'other' | 'unknown'> {
  const compare = async (open: () => TurnReader): Promise<TurnComparison> => {
    const source = open()
    try {
      return await compareTurns(stored, source)
    } finally {
      await source.close()
    }
  }
  const mine = await compare(() => provenance.turns())
  if (mine === 'different') return 'other'
  let others = 0
  for (const rival of rivals) {
    if (await compare(rival) === 'same') others += 1
    // A second full match settles it: no one of them is told apart.
    if (others + (mine === 'same' ? 1 : 0) > 1) return 'unknown'
  }
  if (mine === 'same') return others === 0 ? 'this' : 'unknown'
  return others === 1 ? 'other' : 'unknown'
}

/** A session stored under an id that may or may not hold the one being imported; the person decides. */
export class SessionMaybeImportedError extends Error {
  readonly code = 'session-maybe-imported'
  constructor(readonly existingId: string) {
    super(`DSH session ${existingId} may already hold this session; open it, or import this one as a new session.`)
    this.name = 'SessionMaybeImportedError'
  }
}

/** The identity of an import into a named session: that one, reused when it is stored. */
export function targetIdentity(targetId: string): ImportIdentity {
  return { id: targetId, legacyIds: [] }
}

/**
 * Persist a normalized session, or reuse the one an earlier import wrote, and make it live. The session is written
 * under the id `identity` resolves to, whatever id it carries.
 */
export async function persistImported(ctx: Context, session: NormalizedSession, identity: ImportIdentity): Promise<{ readonly persisted: PersistedSession; readonly synthesized: SynthesizedSession }> {
  const persistence = dshService(ctx, 'sessionPersistence') as SessionPersistence | undefined
  if (persistence === undefined) throw new Error('sessionPersistence service is not available')
  const stored = await StoredSessions.of(persistence)
  let match: StoredMatch
  try {
    match = await matchStored(identity, stored)
  } finally {
    await stored.close()
  }
  if (match.kind === 'maybe') throw new SessionMaybeImportedError(match.id)
  const id = match.id
  const workspace = await workspaceFor(ctx, session.cwd)
  const synthesized = synthesizeDshSession({ ...session, id, source: { ...session.source, sessionId: id } })
  if (match.kind === 'new') {
    const cwd = workspace?.path ?? synthesized.meta.cwd
    const handle = await persistence.create({
      version: 4,
      id,
      createdAt: synthesized.meta.createdAt,
      isSeeded: false,
      ...(cwd !== undefined ? { cwd } : {}),
      delegationDepth: synthesized.meta.delegationDepth,
      ...(synthesized.meta.origin !== undefined ? { origin: synthesized.meta.origin } : {}),
      ...(synthesized.meta.parentSession !== undefined ? { parentSession: synthesized.meta.parentSession } : {}),
    })
    try {
      await handle.append(synthesized.events)
      await handle.flush()
    } finally {
      await handle.close()
    }
  }
  const grouped = workspace !== undefined && await attach(workspace, id)
  const persisted: PersistedSession = {
    id,
    reused: match.kind === 'imported',
    live: await makeLive(ctx, id),
    ...(grouped ? { workspace: workspace.path } : {}),
  }
  return { persisted, synthesized }
}

/** What opening a stored session did. */
export interface OpenedSession {
  readonly id: string
  /** The session is live in this DSH, so the browser can open it now. */
  readonly live: boolean
  /** The person had archived it in DSH, and opening took it out of the archive. */
  readonly unarchived: boolean
  /** It is archived in DSH and stays so (DSH offers no way to unarchive): it is under the archive, not in the list. */
  readonly archived: boolean
}

/**
 * Make a session an import stored known to DSH again, so opening it shows it: placed in the workspace of its
 * directory and live, as a new import does, and out of the archive when the person archived it (an archived
 * session is hidden from every grouping, and opening it lands on an empty new-session page).
 */
export async function openStored(ctx: Context, id: string): Promise<OpenedSession> {
  const stored = await storedSessions(ctx)
  const header = stored.get(id)
  await stored.close()
  if (header === undefined) throw new Error(`DSH does not hold a session ${id}`)
  const workspace = await workspaceFor(ctx, header.cwd)
  if (workspace !== undefined) await attach(workspace, id)
  const registry = dshService(ctx, 'workspaceRegistry') as WorkspaceRegistry | undefined
  let unarchived = false
  if (registry?.archivedSessionIds?.includes(id) === true && typeof registry.unarchiveSession === 'function') {
    await registry.unarchiveSession(id)
    unarchived = true
  }
  return { id, live: await makeLive(ctx, id), unarchived, archived: registry?.archivedSessionIds?.includes(id) === true }
}

/** What one import did, as every importer reports it. */
export interface ImportReport extends PersistedSession {
  readonly sourcePath: string
  readonly title?: string
  readonly turns: number
  readonly events: number
  readonly stats: Record<string, number>
}

/** The report of an import that {@link persistImported} carried out. */
export function importReport(sourcePath: string, title: string | undefined, result: Awaited<ReturnType<typeof persistImported>>): ImportReport {
  const { persisted, synthesized } = result
  return {
    ...persisted,
    sourcePath,
    ...(title !== undefined ? { title } : {}),
    turns: synthesized.stats.turns,
    events: synthesized.events.length,
    stats: {
      steps: synthesized.stats.steps,
      messages: synthesized.stats.messages,
      toolCalls: synthesized.stats.toolCalls,
      toolResults: synthesized.stats.toolResults,
      synthesizedToolResults: synthesized.stats.synthesizedToolResults,
    },
  }
}

/** How many events of a stored session's log are read at once: a page holds a few turns, and reading stops at the turn that tells. */
const STORED_EVENTS_PAGE = 256

/** The sessions DSH stores, by id; none when it cannot list them. */
export async function storedSessions(ctx: Context): Promise<StoredSessions> {
  return StoredSessions.of(dshService(ctx, 'sessionPersistence') as SessionPersistence | undefined)
}

/** The sessions DSH stores: their headers, listed once, and what was said in them, read when asked. */
export class StoredSessions {
  private readonly readers = new Map<string, TurnReader>()

  private constructor(private readonly persistence: SessionPersistence | undefined, private readonly headers: ReadonlyMap<string, StoredSession>) {}

  static async of(persistence: SessionPersistence | undefined): Promise<StoredSessions> {
    const headers = new Map<string, StoredSession>()
    if (typeof persistence?.list === 'function') {
      try {
        for (const entry of await persistence.list()) {
          // Current hosts list `{ header, revision, sizeBytes }`; older ones listed the headers.
          const record = entry as { header?: { id?: unknown; createdAt?: unknown; cwd?: unknown }; id?: unknown; createdAt?: unknown; cwd?: unknown } | null
          const header = record?.header ?? record
          const id = header?.id
          const createdAt = header?.createdAt
          const cwd = header?.cwd
          if (typeof id === 'string') headers.set(id, { id, ...(typeof createdAt === 'number' ? { createdAt } : {}), ...(typeof cwd === 'string' ? { cwd } : {}) })
        }
      } catch {
        // An unreadable listing only means the import cannot tell it ran before.
      }
    }
    return new StoredSessions(persistence, headers)
  }

  get(id: string): StoredSession | undefined {
    return this.headers.get(id)
  }

  has(id: string): boolean {
    return this.headers.has(id)
  }

  /** A reader of a stored session's turns, shared by every comparison until {@link close}; its log is read in pages. */
  turns(id: string): TurnReader {
    let reader = this.readers.get(id)
    if (reader === undefined) {
      reader = turnReader(this.storedTurns(id))
      this.readers.set(id, reader)
    }
    return reader
  }

  /** Let go of the stored sessions read. */
  async close(): Promise<void> {
    const readers = [...this.readers.values()]
    this.readers.clear()
    await Promise.all(readers.map(reader => reader.close()))
  }

  /** The turns of a stored session's log (`turn/start`, its first user message, the assistant's messages), as they are read. */
  private async *storedTurns(id: string): AsyncGenerator<TurnText> {
    if (!this.headers.has(id) || typeof this.persistence?.open !== 'function') throw new Error(`cannot read DSH session ${id}`)
    const handle = await this.persistence.open(id, 'read')
    try {
      let turn: { prompt: string | undefined; replies: string[] } | undefined
      for (let offset = 0; ; ) {
        const { events } = await handle.read(offset, STORED_EVENTS_PAGE)
        offset += events.length
        for (const entry of events) {
          const event = entry as { type?: unknown; data?: { role?: unknown; content?: unknown; message?: { content?: unknown } } } | null
          if (event?.type === 'turn/start') {
            if (turn !== undefined) yield turnText(turn.prompt ?? '', turn.replies)
            turn = { prompt: undefined, replies: [] }
          } else if (turn !== undefined && turn.prompt === undefined && event?.type === 'user/message' && event.data?.role === 'user') {
            turn.prompt = replyText(Array.isArray(event.data.content) ? event.data.content : []).join('\n')
          } else if (turn !== undefined && event?.type === 'assistant/message') {
            const content = event.data?.message?.content
            turn.replies.push(...replyText(Array.isArray(content) ? content : []))
          }
        }
        if (events.length < STORED_EVENTS_PAGE) break
      }
      if (turn !== undefined) yield turnText(turn.prompt ?? '', turn.replies)
    } finally {
      await handle.close()
    }
  }
}

/** The workspace of a session's directory: DSH groups a session only under the workspace whose path is its cwd. */
async function workspaceFor(ctx: Context, cwd: string | undefined): Promise<Workspace | undefined> {
  const registry = dshService(ctx, 'workspaceRegistry') as WorkspaceRegistry | undefined
  if (registry === undefined || cwd === undefined || !isDirectory(cwd) || isSharedFolder(cwd)) return undefined
  try {
    return await registry.create(cwd)
  } catch {
    return undefined
  }
}

/**
 * The home folder and the system's temporary folders (`os.tmpdir()`, `/tmp`, `/var/tmp`, macOS's per-user
 * `/var/folders/…/T`), which hold everyone's odds and ends and are no project: a session there gets no workspace.
 * A folder inside one is a project of its own.
 */
export function isSharedFolder(path: string): boolean {
  const target = resolve(path)
  const shared = [homedir(), tmpdir()].map(folder => resolve(folder))
  for (const folder of [...shared]) {
    try {
      shared.push(realpathSync(folder))
    } catch {
      // A temp folder that cannot be resolved is compared as named.
    }
  }
  if (shared.includes(target)) return true
  if (process.platform === 'win32') return false
  return /^(?:\/private)?\/(?:var\/)?tmp$/u.test(target) || /^(?:\/private)?\/var\/folders\/[^/]+\/[^/]+\/T$/u.test(target)
}

async function attach(workspace: Workspace, id: string): Promise<boolean> {
  if (workspace.sessionIds?.includes(id) === true) return true
  try {
    await workspace.attachSession(id)
    return true
  } catch {
    return false
  }
}

/**
 * Resume the session the way opening it in the browser does (`sessionController.resolveAgent`), which also
 * announces it to the session list; without the controller (a headless profile), through `agents.resume`.
 */
async function makeLive(ctx: Context, id: string): Promise<boolean> {
  const agents = dshService(ctx, 'agents') as Agents | undefined
  const live = (): boolean => agents?.get?.(id) !== undefined
  if (live()) return true
  const controller = dshService(ctx, 'sessionController') as SessionController | undefined
  try {
    if (typeof controller?.resolveAgent === 'function') {
      const result = await controller.resolveAgent(id)
      if (result.error === undefined) return true
    } else if (typeof agents?.resume === 'function') {
      const defaults = dshService(ctx, 'agentDefaultModel') as DefaultModel | undefined
      await agents.resume({
        resumeSessionId: id,
        ...(defaults !== undefined
          ? {
              agentOptions: {
                get provider() { return defaults.currentSelection().provider },
                get model() { return defaults.currentSelection().model },
                get reasoningEffort() { return defaults.currentSelection().reasoningEffort },
              },
            }
          : {}),
      })
    }
  } catch {
    // The session is stored either way; it becomes live when it is opened after a restart.
  }
  return live()
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
