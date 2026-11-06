/**
 * DSH -> Claude Code migration orchestration.
 *
 * Stage mode reads DSH storage, renders Claude transcripts, and writes them
 * (plus skills, global instructions and MCP declarations) below `$DSH_HOME`.
 * It never touches `~/.claude`.
 * @module @dsh2claude/plugin
 */
import { join } from 'node:path'
import { discoverDshSessions, readDshSession, resolveDshHome, type DiscoveredDshSession, type DshReadStats } from '@dsh2claude/adapter-dsh'
import { renderClaudeTranscript, writeClaudeTranscript } from '@dsh2claude/adapter-claude-code'
import { stageDshInstructions, stageDshMcp, stageDshSkills, type AssetStageReport, type McpStageReport } from './assets.ts'
import { hashBytes, itemKey, loadManifest, saveManifest, stagingRoot, upsertItem, type StagedItem } from './staging.ts'

export interface MigrateOptions {
  readonly dshHome?: string
  /** Sessions directory or one session.log file. Defaults to `$DSH_HOME/sessions`. */
  readonly path?: string
  readonly recursive?: boolean
  readonly includeSubagents?: boolean
  /** Restrict to these DSH session ids. */
  readonly only?: readonly string[]
  /** Render a report and write nothing. */
  readonly preview?: boolean
  readonly skills?: boolean
  readonly instructions?: boolean
  readonly mcp?: boolean
}

export interface StageSessionItem {
  readonly ref: string
  readonly dshId: string
  readonly title?: string
  readonly cwd?: string
  readonly createdAt: number
  readonly turns: number
  readonly events: number
  readonly sessionUuid?: string
  readonly stagedPath?: string
  readonly status: 'staged' | 'updated' | 'skipped-identical' | 'skipped' | 'preview' | 'failed'
  readonly reason?: string
  readonly stats?: DshReadStats
}

export interface StageSessionsReport {
  readonly root: string
  readonly total: number
  readonly staged: number
  readonly updated: number
  readonly skippedIdentical: number
  readonly skipped: number
  readonly failed: number
  readonly items: readonly StageSessionItem[]
}

function emptyReport(root: string): { root: string; total: number; staged: number; updated: number; skippedIdentical: number; skipped: number; failed: number; items: StageSessionItem[] } {
  return { root, total: 0, staged: 0, updated: 0, skippedIdentical: 0, skipped: 0, failed: 0, items: [] }
}

function addItem(report: ReturnType<typeof emptyReport>, item: StageSessionItem): void {
  report.total += 1
  if (item.status === 'staged') report.staged += 1
  else if (item.status === 'updated') report.updated += 1
  else if (item.status === 'skipped-identical') report.skippedIdentical += 1
  else if (item.status === 'failed') report.failed += 1
  else if (item.status === 'skipped') report.skipped += 1
  report.items.push(item)
}

function countTurns(session: Awaited<ReturnType<typeof readDshSession>>): number {
  return session.view.events.filter((event) => event.type === 'turn/start').length
}

function matchesOnly(discovered: DiscoveredDshSession, only: readonly string[] | undefined): boolean {
  if (only === undefined || only.length === 0) return true
  const uuid = discovered.dshId.replace(/^session-/, '')
  return only.includes(discovered.dshId) || only.includes(uuid) || only.some((id) => discovered.ref.includes(id))
}

/** Stage DSH sessions as Claude Code transcripts. */
export async function stageDshSessions(options: MigrateOptions): Promise<StageSessionsReport> {
  const dshHome = options.dshHome ?? resolveDshHome()
  const root = options.path ?? join(dshHome, 'sessions')
  const report = emptyReport(root)
  const staging = stagingRoot(dshHome)
  const manifest = await loadManifest(dshHome)

  for await (const discovered of discoverDshSessions(root, {
    ...(options.recursive !== undefined ? { recursive: options.recursive } : {}),
    ...(options.includeSubagents !== undefined ? { includeAuxiliary: options.includeSubagents } : {}),
  })) {
    if (!matchesOnly(discovered, options.only)) continue
    try {
      const session = await readDshSession(discovered)
      if (session.view.events.length === 0) {
        addItem(report, {
          ref: discovered.ref,
          dshId: discovered.dshId,
          ...(discovered.title !== undefined ? { title: discovered.title } : {}),
          ...(discovered.cwd !== undefined ? { cwd: discovered.cwd } : {}),
          createdAt: discovered.createdAt,
          turns: 0,
          events: 0,
          status: 'skipped',
          reason: 'session has no events yet',
        })
        continue
      }
      const rendered = renderClaudeTranscript(session.view, discovered.dshId)
      const base = {
        ref: discovered.ref,
        dshId: discovered.dshId,
        ...(session.view.title !== undefined ? { title: session.view.title } : {}),
        ...(session.view.cwd !== undefined ? { cwd: session.view.cwd } : {}),
        createdAt: session.view.createdAt,
        turns: countTurns(session),
        events: session.view.events.length,
        sessionUuid: rendered.sessionUuid,
        stagedPath: rendered.relativePath,
      }
      if (options.preview === true) {
        addItem(report, { ...base, status: 'preview', stats: session.stats })
        continue
      }

      const bytes = Buffer.byteLength(rendered.jsonl, 'utf8')
      const digest = hashBytes(Buffer.from(rendered.jsonl, 'utf8'))
      const existing = manifest.items.find((item) => itemKey(item.kind, item.id) === itemKey('session', discovered.dshId))
      await writeClaudeTranscript(staging, rendered, { overwrite: true })
      const item: StagedItem = {
        kind: 'session',
        id: discovered.dshId,
        label: session.view.title ?? discovered.dshId,
        source: discovered.ref,
        stagedPath: rendered.relativePath,
        targetPath: rendered.relativePath,
        sha256: digest,
        bytes,
        stagedAt: Date.now(),
        status: 'staged',
      }
      upsertItem(manifest, item)
      const status: StageSessionItem['status'] = existing === undefined
        ? 'staged'
        : existing.sha256 === digest
          ? 'skipped-identical'
          : 'updated'
      addItem(report, { ...base, status, stats: session.stats })
    } catch (error) {
      addItem(report, {
        ref: discovered.ref,
        dshId: discovered.dshId,
        ...(discovered.title !== undefined ? { title: discovered.title } : {}),
        ...(discovered.cwd !== undefined ? { cwd: discovered.cwd } : {}),
        createdAt: discovered.createdAt,
        turns: 0,
        events: 0,
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (options.preview !== true) await saveManifest(manifest, dshHome)
  return report
}

export interface MigrateReport {
  readonly sessions: StageSessionsReport
  readonly skills?: AssetStageReport
  readonly instructions?: AssetStageReport
  readonly mcp?: McpStageReport
  readonly stagingRoot: string
  readonly preview: boolean
}

/**
 * Stage sessions and any requested core assets in one pass.
 *
 * Preview mode renders session conversions without writing; asset staging is
 * skipped in preview because those files are large and already read-only.
 */
export async function migrateDsh(options: MigrateOptions = {}): Promise<MigrateReport> {
  const dshHome = options.dshHome ?? resolveDshHome()
  const staging = stagingRoot(dshHome)
  const sessions = await stageDshSessions(options)
  if (options.preview === true) {
    return { sessions, stagingRoot: staging, preview: true }
  }

  const manifest = await loadManifest(dshHome)
  const skills = options.skills === true ? await stageDshSkills(dshHome, staging, manifest) : undefined
  const instructions = options.instructions === true ? await stageDshInstructions(dshHome, staging, manifest) : undefined
  const mcp = options.mcp === true ? await stageDshMcp(dshHome, staging, manifest) : undefined
  await saveManifest(manifest, dshHome)
  return {
    sessions,
    ...(skills !== undefined ? { skills } : {}),
    ...(instructions !== undefined ? { instructions } : {}),
    ...(mcp !== undefined ? { mcp } : {}),
    stagingRoot: staging,
    preview: false,
  }
}

/** Convenience for tools that need the staging path without a full run. */
export function defaultStagingRoot(dshHome = resolveDshHome()): string {
  return stagingRoot(dshHome)
}

export interface DshSessionInventoryItem {
  readonly dshId: string
  readonly ref: string
  readonly title?: string
  readonly cwd?: string
  readonly createdAt: number
  readonly version: number
  readonly auxiliary: boolean
  readonly staged: boolean
  readonly installed: boolean
}

/** List DSH sessions without reading their event logs. */
export async function listDshSessionInventory(options: { dshHome?: string; path?: string; includeSubagents?: boolean } = {}): Promise<{ root: string; sessions: DshSessionInventoryItem[] }> {
  const dshHome = options.dshHome ?? resolveDshHome()
  const root = options.path ?? join(dshHome, 'sessions')
  const manifest = await loadManifest(dshHome)
  const sessions: DshSessionInventoryItem[] = []
  for await (const discovered of discoverDshSessions(root, options.includeSubagents === true ? { includeAuxiliary: true } : { includeAuxiliary: false })) {
    const item = manifest.items.find((candidate) => candidate.kind === 'session' && candidate.id === discovered.dshId)
    sessions.push({
      dshId: discovered.dshId,
      ref: discovered.ref,
      ...(discovered.title !== undefined ? { title: discovered.title } : {}),
      ...(discovered.cwd !== undefined ? { cwd: discovered.cwd } : {}),
      createdAt: discovered.createdAt,
      version: discovered.version,
      auxiliary: discovered.isAuxiliary,
      staged: item !== undefined,
      installed: item?.installedAt !== undefined,
    })
  }
  return { root, sessions }
}
