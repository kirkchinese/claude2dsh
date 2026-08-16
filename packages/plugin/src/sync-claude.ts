/** Incremental DSH -> Claude Code write-back, safe-copy by default. */
import { readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { readClaudeSession, serializeClaudeJsonlTail } from '@claude2dsh/adapter-claude-code'
import type { ForeignSessionView } from '@claude2dsh/core'
import { loadRegistry, resolveDshHome, saveExportMapping, saveRegistryRecord } from './registry.ts'
import { prefixHash } from './session-import.ts'

export interface SyncClaudeArgs {
  readonly sessionId: string
  /** `copy` syncs the last export file; `source` writes the original transcript and requires allowOriginalClaudeDir. */
  readonly target?: 'copy' | 'source'
  readonly allowOriginalClaudeDir?: boolean
  readonly force?: boolean
  readonly dryRun?: boolean
}

export interface SyncClaudeResult {
  readonly status: 'synced' | 'no-new-turns' | 'refused' | 'skipped'
  readonly reason?: string
  readonly sessionId: string
  readonly filePath?: string
  readonly appendedTurns?: number
  readonly appendedEvents?: number
  readonly appendedRecords?: number
  readonly droppedIncompleteTurn?: boolean
  readonly writeback?: { readonly lastWrittenSeq: number; readonly anchorUuid: string | null }
}

function isUnder(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function readTailUuid(content: string): string | null {
  const lines = content.split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    if (line === undefined || line.trim() === '') continue
    try {
      const record = JSON.parse(line) as { uuid?: unknown }
      return typeof record.uuid === 'string' ? record.uuid : null
    } catch {
      return null
    }
  }
  return null
}

function verifyClaudeJsonl(content: string): boolean {
  const lines = content.split('\n')
  const seen = new Set<string>()
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line === undefined || line.trim() === '') {
      if (index === lines.length - 1) continue
      return false
    }
    let record: { uuid?: unknown; parentUuid?: unknown }
    try {
      record = JSON.parse(line) as { uuid?: unknown; parentUuid?: unknown }
    } catch {
      return false
    }
    if (typeof record.uuid === 'string') {
      if (seen.has(record.uuid)) return false
      seen.add(record.uuid)
      if (typeof record.parentUuid === 'string' && !seen.has(record.parentUuid)) return false
    }
  }
  return true
}

/**
 * Append DSH turns that are newer than the last export watermark to the
 * exported Claude Code file. The default target is the safe export copy under
 * `$DSH_HOME/claude2dsh/exports`; the original `~/.claude` transcript is
 * written only with explicit `allowOriginalClaudeDir`.
 */
export async function syncClaudeSession(ctx: Context, args: SyncClaudeArgs, dshHome = resolveDshHome()): Promise<SyncClaudeResult> {
  const target = args.target ?? 'copy'
  const registry = await loadRegistry(dshHome)
  const exportMapping = registry.exports[args.sessionId]

  let filePath: string
  let sessionUuid: string
  let sourcePathForImport: string | undefined

  if (target === 'copy') {
    if (exportMapping === undefined) throw new Error(`no export mapping for session ${args.sessionId}; run claude2dsh_export first`)
    filePath = exportMapping.filePath
    sessionUuid = exportMapping.sessionUuid
  } else {
    const record = Object.values(registry.imports).find((item) => item.targetId === args.sessionId)
    if (record === undefined) throw new Error(`no Claude source import record for session ${args.sessionId}`)
    if (!args.allowOriginalClaudeDir && isUnder(join(homedir(), '.claude'), record.sourcePath)) {
      return { status: 'refused', reason: 'target "source" writes the original ~/.claude transcript; pass allowOriginalClaudeDir:true only after backing it up', sessionId: args.sessionId }
    }
    filePath = record.sourcePath
    sessionUuid = record.sourcePath.split('/').pop()?.replace(/\.jsonl$/i, '') ?? args.sessionId
    sourcePathForImport = record.sourcePath
  }

  const existing = await readFile(filePath, 'utf8')
  if (!verifyClaudeJsonl(existing)) {
    return { status: 'skipped', reason: 'existing Claude JSONL failed validation; no write performed', sessionId: args.sessionId, filePath }
  }
  const existingTail = readTailUuid(existing)
  let anchor: string | null
  let fromSeq: number
  if (target === 'copy' && exportMapping !== undefined) {
    anchor = exportMapping.anchorUuid
    fromSeq = exportMapping.lastWrittenSeq
    if (existingTail !== anchor && args.force !== true) {
      return { status: 'skipped', reason: 'export file tail moved since the watermark; pass force:true to re-anchor', sessionId: args.sessionId, filePath }
    }
    if (args.force === true) anchor = existingTail
  } else {
    const record = registry.imports[sourcePathForImport ?? '']
    if (record === undefined) throw new Error('missing import record for source target')
    anchor = existingTail
    fromSeq = record.events
  }

  const headers = await ctx.sessionPersistence.list()
  const header = headers.find((item) => String(item.id) === args.sessionId)
  if (header === undefined) throw new Error(`session not found: ${args.sessionId}`)
  const read = await ctx.sessionPersistence.readFrom(args.sessionId as SessionId, fromSeq)
  const view: ForeignSessionView = {
    id: args.sessionId,
    createdAt: header.createdAt,
    ...(header.cwd !== undefined ? { cwd: header.cwd } : {}),
    events: read.events as unknown as ForeignSessionView['events'],
  }
  const tail = serializeClaudeJsonlTail(view, { fromSeq, sessionUuid, anchorUuid: anchor ?? null })

  if (tail.eventsCount === 0) {
    return { status: 'no-new-turns', sessionId: args.sessionId, filePath, ...(tail.droppedIncompleteTurn ? { droppedIncompleteTurn: true } : {}) }
  }
  if (args.dryRun === true) {
    return {
      status: 'synced',
      sessionId: args.sessionId,
      filePath,
      appendedEvents: tail.eventsCount,
      appendedRecords: tail.recordCount,
      appendedTurns: tail.turnCount,
      droppedIncompleteTurn: tail.droppedIncompleteTurn,
      writeback: { lastWrittenSeq: fromSeq + tail.eventsCount, anchorUuid: tail.lastUuid },
    }
  }

  const nextContent = existing.endsWith('\n') ? existing + tail.jsonl : existing + '\n' + tail.jsonl
  if (!verifyClaudeJsonl(nextContent)) {
    return { status: 'skipped', reason: 'append would produce an invalid Claude JSONL; no write performed', sessionId: args.sessionId, filePath }
  }
  await writeFile(filePath, nextContent)

  const fileInfo = await stat(filePath)
  const nextSeq = fromSeq + tail.eventsCount
  if (target === 'copy' && exportMapping !== undefined) {
    await saveExportMapping({
      ...exportMapping,
      anchorUuid: tail.lastUuid,
      lastWrittenSeq: nextSeq,
      lastWrittenTurn: exportMapping.lastWrittenTurn + tail.turnCount,
      recordCount: exportMapping.recordCount + tail.recordCount,
      fileSize: fileInfo.size,
      fileMtimeMs: fileInfo.mtimeMs,
      exportedAt: Date.now(),
    }, dshHome)
  } else if (target === 'source' && sourcePathForImport !== undefined) {
    const record = registry.imports[sourcePathForImport]
    if (record !== undefined) {
      const reparsed = await readClaudeSession({ ref: filePath, sourceId: sessionUuid })
      await saveRegistryRecord({
        ...record,
        turns: reparsed.session.turns.length,
        events: nextSeq,
        sourceSize: fileInfo.size,
        sourceMtimeMs: fileInfo.mtimeMs,
        prefixHash: prefixHash(reparsed.session.turns),
        importedAt: Date.now(),
      }, dshHome)
    }
  }

  return {
    status: 'synced',
    sessionId: args.sessionId,
    filePath,
    appendedEvents: tail.eventsCount,
    appendedRecords: tail.recordCount,
    appendedTurns: tail.turnCount,
    droppedIncompleteTurn: tail.droppedIncompleteTurn,
    writeback: { lastWrittenSeq: nextSeq, anchorUuid: tail.lastUuid },
  }
}

function countTurns(events: readonly { type: string }[]): number {
  return events.filter((event) => event.type === 'turn/start').length
}
