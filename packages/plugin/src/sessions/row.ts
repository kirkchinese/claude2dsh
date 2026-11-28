/**
 * The sessions row: Claude Code, Codex and OpenCode sessions imported into
 * DSH on demand, from the workbench. It holds no listener. While
 * dsh-chat-import runs, it yields: session import is that plugin's.
 * @module @kirkchinese/harness-forge/sessions
 */
import type { Context } from '@deepseek-ai/cordis'
import { MAX_SESSION_BYTES } from '@kirkchinese/harness-forge-core'
import { defaultCodexSessionsRoot, discoverCodexSessions, importCodexSession, rolloutIdentity, type KnownRollout } from './codex.js'
import { codexThreads } from './codex-discover.js'
import type { IndexedThread } from './codex-meta.js'
import type { Disposer, SessionPage, SessionSource, SessionsApi } from '../forge/contract.js'
import { FORGE_SERVICE, type HarnessForge } from '../forge/service.js'
import { discoverOpenCodeSessions, importOpenCodeSession, openCodeIdentity } from './opencode.js'
import { matchStored, openStored, storedSessions, type ImportIdentity, type StoredMatch } from './persist.js'
import { claudeIdentity, discoverClaudeSessions, importClaudeSession } from './claude.js'
import { rowEffect } from '../forge/row.js'
import { chatImportRunning, YIELD_MESSAGE } from './chat-import.js'

export const name = 'harness-forge-sessions'
export const inject = [FORGE_SERVICE]

/** What every listed session carries, whatever its harness. */
interface ListedSession {
  readonly path: string
  /** The session in its harness (a Codex thread): with `source`, what tells the rows apart. */
  readonly sourceId: string
  readonly bytes?: number
  readonly createdAt?: number
  /** A forked Codex thread's parent. */
  readonly parentId?: string
}

/** The sessions row. */
export function apply(ctx: Context): void {
  rowEffect(ctx, 'sessions', forge => startSessions(ctx, forge))
}

/** Start the sessions row on the shared service. Returns its teardown. */
export function startSessions(ctx: Context, forge: HarnessForge): Disposer {
  const api: SessionsApi = {
    sessions: async (root, source, page) => {
      if (chatImportRunning(ctx)) throw new Error(YIELD_MESSAGE)
      // The ones DSH already holds: found the way an import finds them, under the id of this version or of earlier ones.
      const stored = await storedSessions(ctx)
      const known = { threads: sharedThreads() }
      // One row at a time: rows that compare turns share the stored session's reader.
      const matched = new Map<string, Promise<StoredMatch>>()
      const matchOf = (session: ListedSession): Promise<StoredMatch> => {
        let match = matched.get(session.sourceId)
        if (match === undefined) {
          match = matchStored(identityOf(source, session, known), stored)
          matched.set(session.sourceId, match)
        }
        return match
      }
      let found: SessionPage<ListedSession>
      const matches: StoredMatch[] = []
      try {
        // A subagent's thread an earlier version imported is listed anyway: that copy has to stay reachable.
        found = source === 'codex'
          ? await discoverCodexSessions(root ?? defaultCodexSessionsRoot(), page, async subagent => (await matchOf(subagent)).kind === 'imported')
          : source === 'opencode'
            ? await discoverOpenCodeSessions(root, page)
            : await discoverClaudeSessions(root, page)
        for (const session of found.sessions) matches.push(await matchOf(session))
      } finally {
        await stored.close()
      }
      const sessions = found.sessions.map((session, index) => {
        const match = matches[index]!
        // Too large to import: said here so the list can show why its button is off. A compressed rollout's decoded size is not known until it is read.
        const tooLarge = session.bytes !== undefined && session.bytes > MAX_SESSION_BYTES
        return {
          ...session,
          source,
          ...(tooLarge ? { tooLarge, limit: MAX_SESSION_BYTES } : {}),
          ...(match.kind === 'imported' ? { importedId: match.id } : {}),
          // Stored under an id it may hold, and nothing tells: the person opens that one, or imports this one as `newId`.
          ...(match.kind === 'maybe' ? { maybeImportedId: match.id, newId: match.newId } : {}),
        }
      })
      return { sessions, ...(found.next !== undefined ? { next: found.next } : {}) }
    },
    importSession: (path, targetId, source, sourceId) => {
      if (chatImportRunning(ctx)) throw new Error(YIELD_MESSAGE)
      const options = targetId === undefined ? {} : { targetId }
      if (source === 'codex') return importCodexSession(ctx, path, options)
      if (source === 'opencode') {
        if (sourceId === undefined) throw new Error('OpenCode import requires a sourceId')
        return importOpenCodeSession(ctx, path, sourceId, options)
      }
      return importClaudeSession(ctx, path, options)
    },
    open: id => openStored(ctx, id),
  }
  return forge.provide('sessions', api)
}

/** How a listed session is found among the stored ones: the identity its import uses. */
function identityOf(source: SessionSource, session: ListedSession, known: KnownRollout): ImportIdentity {
  if (source === 'codex') return rolloutIdentity(session.path, { id: session.sourceId, sessionId: session.parentId ?? session.sourceId }, session.createdAt ?? 0, known)
  if (source === 'opencode') return openCodeIdentity(session.sourceId)
  return claudeIdentity(session.sourceId)
}

/** The threads under a sessions folder, read once for all the rows of one list. */
function sharedThreads(): (root: string) => Promise<readonly IndexedThread[]> {
  const read = new Map<string, Promise<readonly IndexedThread[]>>()
  return (root) => {
    let threads = read.get(root)
    if (threads === undefined) {
      threads = codexThreads(root)
      read.set(root, threads)
    }
    return threads
  }
}
