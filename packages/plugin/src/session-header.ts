/**
 * Host-compatible Session headers for sessions Claude2DSH creates.
 *
 * The adapter-side model describes an imported session in Claude Code terms
 * (creation time, working directory, delegation origin); the host owns the
 * storage header, including its format version and fork-lineage marker. This
 * module is the one place that turns the first into the second, so a format bump
 * touches one file instead of every create path.
 * @module @claude2dsh/plugin
 */
import { SESSION_FORMAT_VERSION, type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session'
import type { SynthesizedSessionMeta } from '@claude2dsh/core'

/**
 * Build the storage header for one imported session.
 *
 * An imported transcript is never a fork: it carries no inherited event prefix,
 * so `isSeeded` is false and no inherited count travels with it. A delegated
 * Claude subagent keeps its delegation depth and `origin` so the recursion
 * budget and child enumeration behave as they do for a natively created child.
 * @param meta - adapter-side session metadata.
 * @param id - the session id actually claimed in DSH storage.
 * @returns a header the persistence provider accepts at `create`.
 */
export function importedSessionHeader(meta: SynthesizedSessionMeta, id: string): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: id as SessionId,
    createdAt: meta.createdAt,
    isSeeded: false,
    ...(meta.cwd !== undefined && meta.cwd.length > 0 ? { cwd: meta.cwd } : {}),
    ...(meta.parentSession !== undefined ? { parentSession: meta.parentSession as SessionId } : {}),
    ...(meta.origin !== undefined ? { origin: meta.origin } : {}),
    ...(meta.origin !== undefined ? { delegationDepth: meta.delegationDepth } : {}),
  }
}
