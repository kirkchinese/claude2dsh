/**
 * Optional beta auto-mirror.
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

export interface AutoSyncConfig {
  /** Beta switch. Defaults to false when the config section is absent. */
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

/**
 * Activate the beta mirror. All effects are owned by the calling plugin fiber.
 * @param ctx - plugin context.
 * @param config - validated beta configuration.
 */
export function activateAutoSync(ctx: Context, config: AutoSyncConfig, env: NodeJS.ProcessEnv = process.env): void {
  const root = resolveClaudeProjectsRoot(config, env)
  const debounceMs = Math.max(50, config.debounceMs ?? 500)
  let watcher: FSWatcher | undefined
  let pending: ReturnType<typeof setTimeout> | undefined

  ctx.effect(() => {
    watcher = watch(root, {
      ignoreInitial: true,
      depth: 2,
      ignored: (path) => path.includes('node_modules'),
    })
    const schedule = (): void => {
      if (pending !== undefined) clearTimeout(pending)
      pending = setTimeout(() => {
        pending = undefined
        void runClaudeImport(ctx, root)
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
          void runDshSync(ctx, id)
        }, debounceMs)
      })
    }
    return () => {
      if (pending !== undefined) clearTimeout(pending)
      void watcher?.close()
      watcher = undefined
    }
  }, 'claude2dsh auto-sync watcher')
}

const pendingSync = new Set<string>()

async function runClaudeImport(ctx: Context, root: string): Promise<void> {
  try {
    const registry = await loadRegistry(resolveDshHome())
    const report = await importClaudeSessions(ctx, { path: root, includeSubagents: false }, resolveDshHome())
    const changed = report.items.filter((item) => item.status === 'imported' || item.status === 'appended')
    if (changed.length > 0) {
      console.info(`[claude2dsh] auto-import: ${changed.length} session(s) updated`)
    }
    if (report.failed > 0) console.warn(`[claude2dsh] auto-import failed for ${report.failed} file(s)`)
  } catch (error) {
    console.warn('[claude2dsh] auto-import skipped:', error instanceof Error ? error.message : String(error))
  }
}

async function runDshSync(ctx: Context, sessionId: string): Promise<void> {
  try {
    const registry = await loadRegistry(resolveDshHome())
    if (registry.exports[sessionId] === undefined) return
    const result = await syncClaudeSession(ctx, { sessionId, target: 'copy' }, resolveDshHome())
    if (result.status === 'synced') {
      console.info(`[claude2dsh] auto-sync: ${sessionId} appended ${result.appendedRecords ?? 0} record(s)`)
    } else if (result.status === 'skipped' || result.status === 'refused') {
      console.warn(`[claude2dsh] auto-sync ${result.status} for ${sessionId}: ${result.reason ?? 'no reason'}`)
    }
  } catch (error) {
    console.warn('[claude2dsh] auto-sync skipped:', error instanceof Error ? error.message : String(error))
  }
}
