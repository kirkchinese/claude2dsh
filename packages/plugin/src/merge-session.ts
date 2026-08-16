/** Explicit three-way merge for sessions that grew on both sides. */
import { basename, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionHeader } from '@deepseek-ai/dsh-session-persistence'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { synthesizeDshSession, tailSessionEvents, planTurnMerge } from '@claude2dsh/core'
import { readClaudeSession } from '@claude2dsh/adapter-claude-code'
import { loadRegistry, resolveDshHome } from './registry.ts'
import { loadImageMap, saveImageMap } from './image-map.ts'
import { loadSidecarMap, writeSidecarMap } from './sidecar.ts'
import { saveMergeRecord } from './merge-state.ts'
import { saveSessionSource } from './session-sources.ts'

export interface MergeSessionArgs {
  /** DSH session id that the import record owns. */
  readonly sessionId: string
  /** Optional explicit Claude source path; defaults to the import record. */
  readonly path?: string
  /** Compute and report the merged copy without writing it. */
  readonly dryRun?: boolean
}

export interface MergeSessionResult {
  readonly status: 'merged' | 'dry-run' | 'no-new-turns' | 'no-claude-growth' | 'no-dsh-growth'
  readonly reason?: string
  readonly sessionId: string
  readonly mergedSessionId?: string
  readonly baseEvents?: number
  readonly totalEvents?: number
  readonly claudeTurns?: number[]
  readonly dshTurns?: number[]
  readonly conflicts?: number
}

function targetSuffix(existing: ReadonlySet<string>, baseId: string): string {
  if (!existing.has(baseId)) return baseId
  for (let index = 2; ; index++) {
    const candidate = `${baseId}-${index}`
    if (!existing.has(candidate)) return candidate
  }
}

function findImportRecord(registry: Awaited<ReturnType<typeof loadRegistry>>, sessionId: string, explicitPath?: string) {
  if (explicitPath !== undefined && explicitPath.length > 0) {
    const path = resolve(explicitPath)
    const record = registry.imports[path]
    if (record !== undefined && record.targetId === sessionId) return { record, sourcePath: path }
  }
  for (const [sourcePath, record] of Object.entries(registry.imports)) {
    if (record.targetId === sessionId) return { record, sourcePath }
  }
  return undefined
}

async function sessionEvents(ctx: Context, sessionId: string): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
  const headers = await ctx.sessionPersistence.list()
  const header = headers.find((item) => String(item.id) === sessionId)
  if (header === undefined) throw new Error(`session not found: ${sessionId}`)
  const read = await ctx.sessionPersistence.readFrom(sessionId as SessionId, 0)
  return { meta: header, events: read.events as SessionEvent[] }
}

function summarizePlan(plan: ReturnType<typeof planTurnMerge>): Pick<MergeSessionResult, 'baseEvents' | 'totalEvents' | 'claudeTurns' | 'dshTurns' | 'conflicts'> {
  return {
    baseEvents: plan.baseEvents,
    totalEvents: plan.events.length,
    claudeTurns: plan.claudeTurns,
    dshTurns: plan.dshTurns,
    conflicts: plan.conflicts.length,
  }
}

/**
 * Merge Claude-side and DSH-side growth after the import watermark. The
 * original DSH session and the original Claude JSONL are never mutated: the
 * result is a new DSH session id (`<sessionId>-merged`).
 */
export async function mergeClaudeSession(ctx: Context, args: MergeSessionArgs, dshHome = resolveDshHome()): Promise<MergeSessionResult> {
  const registry = await loadRegistry(dshHome)
  const found = findImportRecord(registry, args.sessionId, args.path)
  if (found === undefined) throw new Error(`no import record for session ${args.sessionId}`)
  const { record, sourcePath } = found

  const [parsed, stored] = await Promise.all([
    readClaudeSession({ ref: sourcePath, sourceId: basename(sourcePath).replace(/\.jsonl$/i, '') }),
    sessionEvents(ctx, args.sessionId),
  ])
  const synthesized = synthesizeDshSession(parsed.session)
  const claudeTail = tailSessionEvents(synthesized.events, { fromTurn: record.turns + 1, fromSeq: record.events })
  if (claudeTail.events.length === 0) {
    return { status: 'no-claude-growth', reason: claudeTail.droppedIncompleteTurn ? 'new final turn is incomplete' : 'no complete Claude turns after the watermark', sessionId: args.sessionId }
  }
  if (stored.events.length <= record.events) {
    return { status: 'no-dsh-growth', reason: 'DSH log has no events after the import watermark', sessionId: args.sessionId }
  }

  const plan = planTurnMerge(stored.events as never[], record.events, claudeTail.events as never[])
  const base = summarizePlan(plan)
  if (args.dryRun === true) {
    return { status: 'dry-run', reason: 'merged copy computed; no write performed', sessionId: args.sessionId, ...base }
  }

  const headers = await ctx.sessionPersistence.list()
  const persisted = new Set(headers.map((header) => String(header.id)))
  const mergedId = targetSuffix(persisted, `${args.sessionId}-merged`)
  const meta = { ...stored.meta, id: mergedId, seedLength: stored.meta.seedLength } as SessionHeader
  await ctx.sessionPersistence.create({ ...meta, id: mergedId as SessionId })
  await ctx.sessionPersistence.append(mergedId as SessionId, plan.events as unknown as SessionEvent[])
  await saveSessionSource({ sessionId: mergedId, kind: 'claude-merged', sourcePath, recordedAt: Date.now() }, dshHome)

  // Keep both migration sidecars reachable from the merged copy.
  try {
    const imageMap = await loadImageMap(args.sessionId, dshHome)
    if (imageMap !== undefined && imageMap.entries.length > 0) await saveImageMap(mergedId, imageMap.entries, dshHome)
  } catch {
    // The merged session remains valid without image-map sidecars.
  }
  try {
    const sidecars = await loadSidecarMap(dshHome)
    if (sidecars.sessions[args.sessionId] !== undefined) {
      sidecars.sessions[mergedId] = sidecars.sessions[args.sessionId] ?? []
      await writeSidecarMap(sidecars, dshHome)
    }
  } catch {
    // The merged session remains valid without sidecar-map entries.
  }

  await saveMergeRecord({
    direction: 'claude-to-dsh',
    originalSessionId: args.sessionId,
    resultSessionId: mergedId,
    filePath: sourcePath,
    mergedAt: Date.now(),
    baseEvents: plan.baseEvents,
    claudeTurns: plan.claudeTurns,
    dshTurns: plan.dshTurns,
    conflicts: plan.conflicts.map((conflict) => ({ turn: conflict.turn, claudeEvents: conflict.claude.events.length, dshEvents: conflict.dsh.events.length })),
  }, dshHome)

  return { status: 'merged', sessionId: args.sessionId, mergedSessionId: mergedId, ...base }
}
