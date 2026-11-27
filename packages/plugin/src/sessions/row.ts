/**
 * The sessions row: Claude Code, Codex and OpenCode sessions imported into
 * DSH on demand, from the workbench. It holds no listener.
 * @module @kirkchinese/harness-forge/sessions
 */
import type { Context } from '@deepseek-ai/cordis'
import { discoverCodexSessions, importCodexSession } from './codex.js'
import type { Disposer, SessionsApi } from '../forge/contract.js'
import { FORGE_SERVICE, type HarnessForge } from '../forge/service.js'
import { discoverOpenCodeSessions, importOpenCodeSession } from './opencode.js'
import { discoverClaudeSessions, importClaudeSession } from './claude.js'
import { rowEffect } from '../forge/row.js'

export const name = 'harness-forge-sessions'
export const inject = [FORGE_SERVICE]

/** The sessions row. */
export function apply(ctx: Context): void {
  rowEffect(ctx, 'sessions', forge => startSessions(ctx, forge))
}

/** Start the sessions row on the shared service. Returns its teardown. */
export function startSessions(ctx: Context, forge: HarnessForge): Disposer {
  const api: SessionsApi = {
    sessions: async (root, source) => {
      if (source === 'codex') return (await discoverCodexSessions(root)).map(session => ({ ...session, source: 'codex' as const }))
      if (source === 'opencode') return (await discoverOpenCodeSessions(root)).map(session => ({ ...session, source: 'opencode' as const }))
      return discoverClaudeSessions(root)
    },
    importSession: (path, targetId, source, sourceId) => {
      const options = targetId === undefined ? {} : { targetId }
      if (source === 'codex') return importCodexSession(ctx, path, options)
      if (source === 'opencode') {
        if (sourceId === undefined) throw new Error('OpenCode import requires a sourceId')
        return importOpenCodeSession(ctx, path, sourceId, options)
      }
      return importClaudeSession(ctx, path, options)
    },
  }
  return forge.provide('sessions', api)
}
