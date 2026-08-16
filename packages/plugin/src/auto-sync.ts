/**
 * Optional auto-mirror.
 *
 * Disabled by default. When enabled through plugin config it watches the
 * Claude projects directory and imports grown transcripts, and listens for
 * completed DSH turns to append them to the safe export copy. Writing the
 * original `~/.claude` transcript is never implied by auto-sync; the copy
 * watermark and `allowOriginalClaudeDir` gates stay authoritative.
 * @module @claude2dsh/plugin
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { watch, type FSWatcher } from 'chokidar'
import { importClaudeSessions } from './session-import.ts'
import { syncClaudeSession } from './sync-claude.ts'
import { loadRegistry, resolveDshHome } from './registry.ts'
import { loadAutoSyncState, pauseAutoSync, saveAutoSyncState, type AutoSyncState } from './auto-sync-state.ts'

export interface AutoSyncConfig {
  /** Feature switch. Defaults to false when the config section is absent. */
  readonly enabled?: boolean
  /** Claude projects directory to watch. Defaults to `$CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects`. */
  readonly claudeProjectsRoot?: string
  /** Debounce window in milliseconds for filesystem events. */
  readonly debounceMs?: number
  /** Whether newly detected DSH turns are mirrored to the export copy automatically. */
  readonly dshToClaude?: boolean
}

function resolveClaudeProjectsRoot(config: AutoSyncConfig, env: NodeJS.ProcessEnv): string {
  if (config.claudeProjectsRoot !== undefined && config.claudeProjectsRoot.length > 0) return config.claudeProjectsRoot
  if (env.CLAUDE_CONFIG_DIR !== undefined && env.CLAUDE_CONFIG_DIR.length > 0) return join(env.CLAUDE_CONFIG_DIR, 'projects')
  return join(homedir(), '.claude', 'projects')
}

function isLiveSession(ctx: Context, id: string): boolean {
  const sessions = (ctx as unknown as { sessions?: { get(id: string): unknown } }).sessions
  return sessions?.get(id) !== undefined
}

function logState(state: AutoSyncState): void {
  if (state.paused) console.warn(`[claude2dsh] auto-sync paused: ${state.reason ?? 'unknown reason'}`)
}

/**
 * Activate the mirror. All effects are owned by the calling plugin fiber.
 * @param ctx - plugin context.
 * @param config - validated mirror configuration.
 */
export function activateAutoSync(ctx: Context, config: AutoSyncConfig, env: NodeJS.ProcessEnv = process.env): void {
  const root = resolveClaudeProjectsRoot(config, env)
  const debounceMs = Math.max(50, config.debounceMs ?? 500)
  const dshHome = resolveDshHome(env)
  let watcher: FSWatcher | undefined
  let pending: ReturnType<typeof setTimeout> | undefined
  let state = loadAutoSyncState(dshHome)

  const persistState = async (): Promise<void> => {
    const loaded = await state
    await saveAutoSyncState(loaded, dshHome)
  }

  ctx.effect(() => {
    void state.then(logState)
    void processPendingQueue(ctx, root, debounceMs, dshHome, state)
    watcher = watch(root, {
      ignoreInitial: true,
      depth: 2,
      ignored: (path) => path.includes('node_modules'),
    })
    const schedule = (): void => {
      if (pending !== undefined) clearTimeout(pending)
      pending = setTimeout(() => {
        pending = undefined
        void queueItem(state, 'import', root, dshHome)
          .then(() => runClaudeImport(ctx, root, dshHome, state))
          .finally(() => dequeueItem(state, 'import', root, dshHome))
      }, debounceMs)
    }
    watcher.on('add', schedule)
    watcher.on('change', schedule)
    if (config.dshToClaude !== false) {
      ctx.on('session/event', (session, event) => {
        if (event.type !== 'turn/end') return
        const id = String(session.id)
        if (pendingSync.has(id)) return
        pendingSync.add(id)
        setTimeout(() => {
          pendingSync.delete(id)
          void queueItem(state, 'sync', id, dshHome)
            .then(() => runDshSync(ctx, id, dshHome, state))
            .finally(() => dequeueItem(state, 'sync', id, dshHome))
        }, debounceMs)
      })
    }
    return () => {
      if (pending !== undefined) clearTimeout(pending)
      void watcher?.close()
      watcher = undefined
    }
  }, 'claude2dsh auto-sync watcher')

  void persistState
}

const pendingSync = new Set<string>()

async function queueItem(state: Promise<AutoSyncState>, kind: 'import' | 'sync', id: string, dshHome: string): Promise<AutoSyncState> {
  const loaded = await state
  if (!loaded.pending.some((item) => item.kind === kind && item.id === id)) {
    loaded.pending = [...loaded.pending, { kind, id, queuedAt: Date.now() }]
    await saveAutoSyncState(loaded, dshHome)
  }
  return loaded
}

async function dequeueItem(state: Promise<AutoSyncState>, kind: 'import' | 'sync', id: string, dshHome: string): Promise<AutoSyncState> {
  const loaded = await state
  loaded.pending = loaded.pending.filter((item) => !(item.kind === kind && item.id === id))
  await saveAutoSyncState(loaded, dshHome)
  return loaded
}

async function processPendingQueue(ctx: Context, root: string, debounceMs: number, dshHome: string, state: Promise<AutoSyncState>): Promise<void> {
  const loaded = await state
  if (loaded.pending.length === 0) return
  for (const item of [...loaded.pending]) {
    if (item.kind === 'import') {
      await runClaudeImport(ctx, root, dshHome, state)
      await dequeueItem(state, 'import', item.id, dshHome)
    } else {
      await runDshSync(ctx, item.id, dshHome, state)
      await dequeueItem(state, 'sync', item.id, dshHome)
    }
  }
}

async function runClaudeImport(ctx: Context, root: string, dshHome: string, state: Promise<AutoSyncState>): Promise<void> {
  const loaded = await state
  if (loaded.paused) {
    console.warn(`[claude2dsh] auto-import skipped: paused (${loaded.reason ?? 'conflict'})`)
    return
  }
  try {
    const report = await importClaudeSessions(ctx, { path: root, includeSubagents: false }, dshHome)
    const conflicts = report.items.filter((item) => item.status === 'conflict')
    if (conflicts.length > 0) {
      const first = conflicts[0]
      if (first !== undefined) {
        await pauseAutoSync(loaded, 'bidirectional conflict detected; resolve with explicit tools', {
          at: Date.now(),
          kind: 'claude-to-dsh',
          sessionId: first.sessionId ?? 'unknown',
          detail: first.reason ?? 'both sides grew after the sync point',
        }, dshHome)
      }
      console.error(`[claude2dsh] auto-import paused: ${conflicts.length} conflict(s); no data changed`)
      return
    }
    const changed = report.items.filter((item) => item.status === 'imported' || item.status === 'appended')
    if (changed.length > 0) console.info(`[claude2dsh] auto-import: ${changed.length} session(s) updated`)
    if (report.failed > 0) console.warn(`[claude2dsh] auto-import failed for ${report.failed} file(s)`)
  } catch (error) {
    console.warn('[claude2dsh] auto-import skipped:', error instanceof Error ? error.message : String(error))
  }
}

async function runDshSync(ctx: Context, sessionId: string, dshHome: string, state: Promise<AutoSyncState>): Promise<void> {
  const loaded = await state
  if (loaded.paused) {
    console.warn(`[claude2dsh] auto-sync skipped for ${sessionId}: paused (${loaded.reason ?? 'conflict'})`)
    return
  }
  if (isLiveSession(ctx, sessionId)) {
    console.info(`[claude2dsh] auto-sync skipped for ${sessionId}: live session`)
    return
  }
  try {
    const registry = await loadRegistry(dshHome)
    if (registry.exports[sessionId] === undefined) return
    const result = await syncClaudeSession(ctx, { sessionId, target: 'copy' }, dshHome)
    if (result.status === 'synced') {
      console.info(`[claude2dsh] auto-sync: ${sessionId} appended ${result.appendedRecords ?? 0} record(s)`)
    } else if (result.status === 'skipped' || result.status === 'refused') {
      console.warn(`[claude2dsh] auto-sync ${result.status} for ${sessionId}: ${result.reason ?? 'no reason'}`)
    }
  } catch (error) {
    console.warn('[claude2dsh] auto-sync skipped:', error instanceof Error ? error.message : String(error))
  }
}

/** Exported for tests and future explicit status/resume tools. */
export async function getAutoSyncState(dshHome = resolveDshHome()): Promise<AutoSyncState> {
  return loadAutoSyncState(dshHome)
}

export async function resumeAutoSync(dshHome = resolveDshHome()): Promise<AutoSyncState> {
  const state = await loadAutoSyncState(dshHome)
  return import('./auto-sync-state.ts').then(({ resumeAutoSync }) => resumeAutoSync(state, dshHome))
}
