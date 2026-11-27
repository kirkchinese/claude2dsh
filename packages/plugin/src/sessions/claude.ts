/**
 * Claude Code session migration. The adapter normalizes parent-chain JSONL;
 * the shared synthesizer emits DSH v4 events; this module owns discovery and
 * the persistence hand-off so the UI never writes session storage directly.
 * @module @kirkchinese/harness-forge
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { claudeCodeAdapter, synthesizeDshSession, type ClaudeReadOptions, type DiscoveredSession } from '@kirkchinese/harness-forge-core'
import { dshService } from '../dsh/host.js'

interface PersistenceHandle {
  append(events: readonly unknown[]): Promise<void>
  flush(): Promise<void>
  close(): Promise<void>
}

interface SessionPersistence {
  create(header: Record<string, unknown>): Promise<PersistenceHandle>
}

/** One discoverable Claude Code transcript. */
export interface SessionCandidate {
  readonly path: string
  readonly sourceId: string
  readonly source?: 'claude-code' | 'codex' | 'opencode'
  readonly title?: string
  readonly cwd?: string
  readonly createdAt?: number
  readonly origin?: 'subagent'
}

/** Result of one session import. */
export interface SessionImportReport {
  readonly id: string
  readonly sourcePath: string
  readonly title?: string
  readonly turns: number
  readonly events: number
  readonly stats: Record<string, number>
}

/** Default Claude Code projects directory. */
export function defaultClaudeProjectsRoot(home = homedir()): string {
  return join(home, '.claude', 'projects')
}

/** Discover Claude Code main transcripts under a root. */
export async function discoverClaudeSessions(root = defaultClaudeProjectsRoot(), limit = 200): Promise<SessionCandidate[]> {
  const out: SessionCandidate[] = []
  for await (const item of claudeCodeAdapter.discover(root, { recursive: true })) {
    out.push({
      path: item.ref,
      sourceId: item.sourceId ?? item.ref,
      source: 'claude-code',
      ...(item.title !== undefined ? { title: item.title } : {}),
      ...(item.cwd !== undefined ? { cwd: item.cwd } : {}),
      ...(item.createdAt !== undefined ? { createdAt: item.createdAt } : {}),
      ...(item.origin !== undefined ? { origin: item.origin } : {}),
    })
    if (out.length >= limit) break
  }
  out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  return out
}

/** Import one Claude Code transcript into DSH session persistence. */
export async function importClaudeSession(
  ctx: Context,
  sourcePath: string,
  options: { readonly includeSubagents?: boolean; readonly targetId?: string } = {},
): Promise<SessionImportReport> {
  const persistence = dshService(ctx, 'sessionPersistence') as SessionPersistence | undefined
  if (persistence === undefined) throw new Error('sessionPersistence service is not available')
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
    sourcePath,
    ...(parsed.session.title !== undefined ? { title: parsed.session.title } : {}),
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
