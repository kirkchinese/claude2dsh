/** Durable state for the auto-mirror. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveDshHome } from './registry.ts'

export interface AutoSyncConflict {
  readonly at: number
  readonly kind: 'claude-to-dsh' | 'dsh-to-claude'
  readonly sessionId: string
  readonly detail: string
}

export interface AutoSyncState {
  readonly version: 1
  paused: boolean
  reason: string | undefined
  conflicts: AutoSyncConflict[]
  pending: Array<{ kind: 'import' | 'sync'; id: string; queuedAt: number }>
}

export function autoSyncStatePath(dshHome = resolveDshHome()): string {
  return join(dshHome, 'claude2dsh', 'auto-sync-state.json')
}

export async function loadAutoSyncState(dshHome = resolveDshHome()): Promise<AutoSyncState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(autoSyncStatePath(dshHome), 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && (parsed as { version?: unknown }).version === 1) {
      return parsed as AutoSyncState
    }
  } catch {
    // Missing/corrupt state starts fresh; corruption is logged by the caller.
  }
  return { version: 1, paused: false, reason: undefined, conflicts: [], pending: [] }
}

export async function saveAutoSyncState(state: AutoSyncState, dshHome = resolveDshHome()): Promise<void> {
  const filePath = autoSyncStatePath(dshHome)
  await mkdir(dirname(filePath), { recursive: true })
  const temp = join(dirname(filePath), `.auto-sync-state-${randomUUID()}.tmp`)
  await writeFile(temp, JSON.stringify(state, null, 2) + '\n')
  await rename(temp, filePath)
}

export async function pauseAutoSync(state: AutoSyncState, reason: string, conflict: AutoSyncConflict, dshHome = resolveDshHome()): Promise<AutoSyncState> {
  state.paused = true
  state.reason = reason
  state.conflicts = [...state.conflicts.slice(-19), conflict]
  await saveAutoSyncState(state, dshHome)
  return state
}

export async function resumeAutoSync(state: AutoSyncState, dshHome = resolveDshHome()): Promise<AutoSyncState> {
  state.paused = false
  state.reason = undefined
  await saveAutoSyncState(state, dshHome)
  return state
}
