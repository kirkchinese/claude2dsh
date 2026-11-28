/**
 * Claude Code session migration. The adapter normalizes parent-chain JSONL;
 * the shared synthesizer emits DSH v4 events; this module owns discovery and
 * the persistence hand-off so the UI never writes session storage directly.
 * @module @kirkchinese/harness-forge
 */
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { claudeCodeAdapter, discoverClaudeCodeSessions, type ClaudeReadOptions, type DiscoveredSession } from '@kirkchinese/harness-forge-core'
import { SESSION_PAGE_SIZE, type SessionPage, type SessionPageRequest } from '../forge/contract.js'
import { importReport, persistImported, targetIdentity, type ImportIdentity, type ImportReport } from './persist.js'

/** One discoverable Claude Code transcript. */
export interface SessionCandidate {
  readonly path: string
  readonly sourceId: string
  readonly source?: 'claude-code' | 'codex' | 'opencode'
  readonly title?: string
  readonly cwd?: string
  readonly createdAt?: number
  /** When the transcript was last written. */
  readonly updatedAt?: number
  /** The transcript's size in bytes. */
  readonly bytes?: number
  readonly origin?: 'subagent'
}

/** Result of one session import. */
export type SessionImportReport = ImportReport

/** Default Claude Code projects directory. */
export function defaultClaudeProjectsRoot(home = homedir()): string {
  return join(home, '.claude', 'projects')
}

/** The id an import gives a Claude Code session (the core mints it the same way: `claude-<session id>`). */
export function claudeSessionId(sourceId: string): string {
  return `claude-${sourceId.trim()}`
}

/** How an import finds the DSH session holding a Claude Code session: earlier versions used the bare id. */
export function claudeIdentity(sourceId: string): ImportIdentity {
  return { id: claudeSessionId(sourceId), legacyIds: [sourceId.trim()] }
}

/** Directories of a project that hold sidecars, not main transcripts. */
const SIDECAR_DIRS = new Set(['subagents', 'workflows', 'tool-results'])

/**
 * One page of the Claude Code main transcripts under a root, newest first. The files are only listed and dated;
 * the page's transcripts are the ones opened, so a long history costs no more than a short one.
 */
export async function discoverClaudeSessions(root = defaultClaudeProjectsRoot(), page: SessionPageRequest = {}): Promise<SessionPage<SessionCandidate>> {
  const limit = Math.max(1, page.limit ?? SESSION_PAGE_SIZE)
  const files = await listTranscripts(root)
  const sessions: SessionCandidate[] = []
  let at = Math.max(0, page.cursor ?? 0)
  for (; at < files.length && sessions.length < limit; at++) {
    const file = files[at]!
    try {
      for await (const item of discoverClaudeCodeSessions(file.path)) {
        sessions.push({
          path: item.ref,
          sourceId: item.sourceId ?? item.ref,
          source: 'claude-code',
          ...(item.title !== undefined ? { title: item.title } : {}),
          ...(item.cwd !== undefined ? { cwd: item.cwd } : {}),
          ...(item.createdAt !== undefined ? { createdAt: item.createdAt } : {}),
          updatedAt: file.updatedAt,
          bytes: file.bytes,
          ...(item.origin !== undefined ? { origin: item.origin } : {}),
        })
      }
    } catch {
      // A transcript that cannot be read is not offered.
    }
  }
  return { sessions, ...(at < files.length ? { next: at } : {}) }
}

async function listTranscripts(root: string): Promise<Array<{ path: string; updatedAt: number; bytes: number }>> {
  const found: Array<{ path: string; updatedAt: number; bytes: number }> = []
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SIDECAR_DIRS.has(entry.name)) await walk(path)
      } else if (entry.isFile() && /\.jsonl$/iu.test(entry.name) && !/^journal\.jsonl$/iu.test(entry.name)) {
        const info = await stat(path).catch(() => undefined)
        if (info !== undefined) found.push({ path, updatedAt: info.mtimeMs, bytes: info.size })
      }
    }
  }
  const info = await stat(root).catch(() => undefined)
  if (info?.isFile() === true) return [{ path: root, updatedAt: info.mtimeMs, bytes: info.size }]
  await walk(root)
  return found.sort((a, b) => b.updatedAt - a.updatedAt || b.path.localeCompare(a.path))
}

/** Import one Claude Code transcript into DSH session persistence. */
export async function importClaudeSession(
  ctx: Context,
  sourcePath: string,
  options: { readonly includeSubagents?: boolean; readonly targetId?: string } = {},
): Promise<SessionImportReport> {
  const candidate: DiscoveredSession = {
    ref: sourcePath,
    sourceId: sourcePath,
  }
  const parsed = await claudeCodeAdapter.readSession(candidate, {
    ...(options.includeSubagents === true ? { includeAuxiliary: true } : {}),
    ...(options.targetId !== undefined ? { targetId: options.targetId } : {}),
  } as ClaudeReadOptions)
  // A transcript with no conversation on its main chain would become an empty session: say why instead.
  if (parsed.session.turns.length === 0) throw new Error(`nothing to import from ${sourcePath}: ${parsed.stats.reasons.join('; ') || 'no conversation in the transcript'}`)
  const sourceId = parsed.session.source.sessionId
  const identity = options.targetId !== undefined ? targetIdentity(options.targetId) : sourceId !== undefined ? claudeIdentity(sourceId) : targetIdentity(parsed.session.id)
  return importReport(sourcePath, parsed.session.title, await persistImported(ctx, parsed.session, identity))
}
