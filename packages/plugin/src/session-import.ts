/** Session import orchestration over host DSH persistence. */
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionHeader } from '@deepseek-ai/dsh-session-persistence'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { synthesizeDshSession, tailSessionEvents } from '@claude2dsh/core'
import { discoverClaudeCodeSessions, readClaudeSession } from '@claude2dsh/adapter-claude-code'
import { loadRegistry, saveRegistryRecord } from './registry.ts'
import { applyImagePolicy, type ImageMode } from './image-policy.ts'
import { buildImageMapEntries, saveImageMap } from './image-map.ts'

export interface SessionImportArgs {
  readonly path: string
  readonly recursive?: boolean
  readonly includeSubagents?: boolean
  readonly force?: boolean
  readonly preview?: boolean
  readonly sessionId?: string
  /** Image capability policy: auto probes the target model, native forces attachment blocks, placeholder always degrades. */
  readonly imageMode?: ImageMode
  /** Provider route used by `auto`/`native` capability resolution. */
  readonly imageProvider?: string
  /** Model id used by `auto`/`native` capability resolution. */
  readonly imageModel?: string
}

export interface SessionImportItem {
  readonly path: string
  readonly status: 'imported' | 'already-imported' | 'appended' | 'skipped' | 'source-changed' | 'source-shrunk' | 'conflict' | 'failed' | 'preview'
  readonly sessionId?: string
  readonly turns?: number
  readonly events?: number
  readonly toolCalls?: number
  readonly synthesizedToolResults?: number
  readonly imageMode?: 'native' | 'placeholder'
  readonly imagesSaved?: number
  readonly imagesDegraded?: number
  readonly reason?: string
  readonly error?: string
}

export interface SessionImportReport {
  mode: 'single' | 'directory'
  total: number
  imported: number
  alreadyImported: number
  appended: number
  skipped: number
  failed: number
  items: SessionImportItem[]
}

function expandHome(path: string): string {
  if (path === '~') return resolve(process.env.HOME ?? '/')
  if (path.startsWith('~/')) return resolve(process.env.HOME ?? '/', path.slice(2))
  return resolve(path)
}

function targetSuffix(existing: ReadonlySet<string>, baseId: string): string {
  if (!existing.has(baseId)) return baseId
  for (let index = 2; ; index++) {
    const candidate = `${baseId}-${index}`
    if (!existing.has(candidate)) return candidate
  }
}

function emptyReport(mode: 'single' | 'directory'): SessionImportReport {
  return { mode, total: 0, imported: 0, alreadyImported: 0, appended: 0, skipped: 0, failed: 0, items: [] }
}

function pushItem(report: SessionImportReport, item: SessionImportItem): void {
  report.total += 1
  if (item.status === 'imported') report.imported += 1
  else if (item.status === 'already-imported') report.alreadyImported += 1
  else if (item.status === 'appended') report.appended += 1
  else if (item.status === 'failed') report.failed += 1
  else report.skipped += 1
  report.items.push(item)
}

export function prefixHash(turns: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(turns)).digest('hex')
}

async function storedEventCount(ctx: Context, targetId: string): Promise<number | undefined> {
  try {
    const read = await ctx.sessionPersistence.readFrom(targetId as SessionId, 0)
    return read.events.length
  } catch {
    return undefined
  }
}

async function statOrUndefined(path: string): Promise<{ size: number; mtimeMs: number } | undefined> {
  try {
    const info = await stat(path)
    return { size: info.size, mtimeMs: info.mtimeMs }
  } catch {
    return undefined
  }
}

/**
 * Import Claude Code sessions into DSH native persistence.
 *
 * Reads source files with Node's filesystem (the original directory stays
 * read-only) and writes only through `ctx.sessionPersistence` plus the
 * sidecar registry below `$DSH_HOME`.
 */
export async function importClaudeSessions(ctx: Context, args: SessionImportArgs, dshHome?: string): Promise<SessionImportReport> {
  const sourceRoot = expandHome(args.path)
  const report = emptyReport(args.sessionId !== undefined ? 'single' : 'directory')
  const registry = await loadRegistry(dshHome)
  const persisted = new Set<string>((await ctx.sessionPersistence.list()).map((header) => String(header.id)))

  for await (const discovered of discoverClaudeCodeSessions(sourceRoot, { ...(args.recursive !== undefined ? { recursive: args.recursive } : {}), ...(args.includeSubagents === true ? { includeAuxiliary: true } : {}) })) {
    const sourcePath = discovered.ref
    try {
      const parsed = await readClaudeSession(discovered, { ...(args.sessionId !== undefined ? { targetId: args.sessionId } : {}), ...(args.includeSubagents === true ? { allowAuxiliary: true } : {}) })
      const imagePolicy = await applyImagePolicy(ctx, parsed.session, {
        ...(args.preview === true || args.imageMode !== undefined ? { imageMode: args.preview === true ? 'placeholder' as const : args.imageMode } : {}),
        ...(args.imageProvider !== undefined ? { imageProvider: args.imageProvider } : {}),
        ...(args.imageModel !== undefined ? { imageModel: args.imageModel } : {}),
      })
      const imageFields = {
        ...(imagePolicy.mode !== undefined ? { imageMode: imagePolicy.mode } : {}),
        ...(imagePolicy.saved > 0 ? { imagesSaved: imagePolicy.saved } : {}),
        ...(imagePolicy.degraded > 0 ? { imagesDegraded: imagePolicy.degraded } : {}),
      }
      if (parsed.session.turns.length === 0) {
        pushItem(report, {
          path: sourcePath,
          status: 'skipped',
          reason: parsed.stats.reasons[0] ?? 'no importable turns',
        })
        continue
      }

      const synthesized = synthesizeDshSession(parsed.session)
      const imageEntries = buildImageMapEntries(parsed.session, synthesized.events)
      if (args.preview === true) {
        pushItem(report, {
          path: sourcePath,
          status: 'preview',
          sessionId: parsed.session.id,
          turns: parsed.session.turns.length,
          events: synthesized.events.length,
          toolCalls: synthesized.stats.toolCalls,
          synthesizedToolResults: synthesized.stats.synthesizedToolResults,
          ...imageFields,
        })
        continue
      }

      const fingerprint = await statOrUndefined(sourcePath)
      const known = registry.imports[sourcePath]
      const unchanged = known !== undefined && fingerprint !== undefined
        && known.sourceSize === fingerprint.size
        && known.sourceMtimeMs === fingerprint.mtimeMs

      if (known !== undefined && unchanged && persisted.has(known.targetId)) {
        pushItem(report, {
          path: sourcePath,
          status: 'already-imported',
          sessionId: known.targetId,
          turns: parsed.session.turns.length,
          events: synthesized.events.length,
          ...imageFields,
        })
        continue
      }

      if (known !== undefined && !unchanged && args.force !== true) {
        if (parsed.session.turns.length < known.turns) {
          pushItem(report, {
            path: sourcePath,
            status: 'source-shrunk',
            sessionId: known.targetId,
            turns: parsed.session.turns.length,
            reason: `source has ${parsed.session.turns.length} turns, previously ${known.turns}; pass force:true for a fresh copy`,
          })
          continue
        }
        if (parsed.session.turns.length === known.turns) {
          pushItem(report, {
            path: sourcePath,
            status: 'source-changed',
            sessionId: known.targetId,
            turns: parsed.session.turns.length,
            reason: 'same turn count but changed content; append-only storage refuses in-place rewrite, pass force:true for a fresh copy',
          })
          continue
        }
        if (prefixHash(parsed.session.turns.slice(0, known.turns)) !== known.prefixHash) {
          pushItem(report, {
            path: sourcePath,
            status: 'source-changed',
            sessionId: known.targetId,
            turns: parsed.session.turns.length,
            reason: 'already-imported prefix was rewritten; pass force:true for a fresh copy',
          })
          continue
        }
        const storedLength = await storedEventCount(ctx, known.targetId)
        if (storedLength === undefined) {
          pushItem(report, {
            path: sourcePath,
            status: 'source-changed',
            sessionId: known.targetId,
            turns: parsed.session.turns.length,
            reason: 'could not read stored DSH event count; append skipped',
          })
          continue
        }
        if (storedLength > known.events) {
          pushItem(report, {
            path: sourcePath,
            status: 'conflict',
            sessionId: known.targetId,
            turns: parsed.session.turns.length,
            reason: `both sides grew after the last sync point (source turns now ${parsed.session.turns.length}, DSH events ${storedLength} > recorded ${known.events}); auto-append paused, no data changed`,
          })
          continue
        }
        const tail = tailSessionEvents(synthesized.events, { fromTurn: known.turns + 1, fromSeq: storedLength })
        if (tail.events.length === 0) {
          pushItem(report, {
            path: sourcePath,
            status: 'already-imported',
            sessionId: known.targetId,
            turns: parsed.session.turns.length,
            reason: tail.droppedIncompleteTurn ? 'new final turn is incomplete; retry after Claude Code closes it' : 'no appendable events',
          })
          continue
        }
        await ctx.sessionPersistence.append(known.targetId as SessionId, tail.events as unknown as SessionEvent[])
        if (imageEntries.length > 0) await saveImageMap(known.targetId, imageEntries, dshHome)
        persisted.add(known.targetId)
        await saveRegistryRecord({
          adapter: 'claude-code',
          targetId: known.targetId,
          sourcePath,
          turns: parsed.session.turns.length,
          events: storedLength + tail.events.length,
          sourceSize: fingerprint?.size ?? -1,
          sourceMtimeMs: fingerprint?.mtimeMs ?? -1,
          prefixHash: prefixHash(parsed.session.turns),
          importedAt: Date.now(),
        }, dshHome)
        pushItem(report, {
          path: sourcePath,
          status: 'appended',
          sessionId: known.targetId,
          turns: parsed.session.turns.length,
          events: storedLength + tail.events.length,
          toolCalls: synthesized.stats.toolCalls,
          synthesizedToolResults: synthesized.stats.synthesizedToolResults,
          ...imageFields,
        })
        continue
      }

      const targetId = args.force === true ? targetSuffix(persisted, parsed.session.id) : targetSuffix(persisted, known?.targetId ?? parsed.session.id)
      const meta = { ...synthesized.meta, id: targetId } as SessionHeader
      const brandedTargetId = targetId as SessionId
      await ctx.sessionPersistence.create({ ...meta, id: brandedTargetId })
      await ctx.sessionPersistence.append(brandedTargetId, synthesized.events as unknown as SessionEvent[])
      if (imageEntries.length > 0) await saveImageMap(targetId, imageEntries, dshHome)
      persisted.add(targetId)
      await saveRegistryRecord({
        adapter: 'claude-code',
        targetId,
        sourcePath,
        turns: parsed.session.turns.length,
        events: synthesized.events.length,
        sourceSize: fingerprint?.size ?? -1,
        sourceMtimeMs: fingerprint?.mtimeMs ?? -1,
        prefixHash: prefixHash(parsed.session.turns),
        importedAt: Date.now(),
      }, dshHome)

      pushItem(report, {
        path: sourcePath,
        status: 'imported',
        sessionId: targetId,
        turns: parsed.session.turns.length,
        events: synthesized.events.length,
        toolCalls: synthesized.stats.toolCalls,
        synthesizedToolResults: synthesized.stats.synthesizedToolResults,
        ...imageFields,
      })
    } catch (error) {
      pushItem(report, {
        path: sourcePath,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return report
}

/** Directories the adapter discovered, for diagnostics. */
export function describeSourceRoot(path: string): string {
  return basename(path) === 'projects' ? 'Claude Code projects directory' : `Claude transcript path ${dirname(path)}`
}

void join
