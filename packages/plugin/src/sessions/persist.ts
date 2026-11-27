/**
 * The hand-off of a synthesized session to DSH, shared by every importer: write it through
 * `sessionPersistence`, place it in the workspace of its directory, and make it live, so the sidebar lists it
 * with its title under its project and "Open" works at once. Writing the log alone leaves it unknown to the
 * running DSH (`sessions.retain: unknown session`, "Untitled" under "Ungrouped") until a restart.
 * @module @kirkchinese/harness-forge
 */
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SynthesizedSession } from '@kirkchinese/harness-forge-core'
import { dshService } from '../dsh/host.js'

interface PersistenceHandle {
  append(events: readonly unknown[]): Promise<void>
  flush(): Promise<void>
  close(): Promise<void>
}

interface SessionPersistence {
  create(header: Record<string, unknown>): Promise<PersistenceHandle>
  list?(): Promise<readonly unknown[]>
}

interface Workspace {
  readonly path: string
  readonly sessionIds?: readonly string[]
  attachSession(sessionId: string): Promise<void>
}

interface WorkspaceRegistry {
  create(path: string): Promise<Workspace>
}

interface SessionController {
  resolveAgent(sessionId: string): Promise<{ agent?: unknown; error?: unknown }>
}

interface Agents {
  get?(sessionId: string): unknown
  resume?(options: { resumeSessionId: string; agentOptions?: unknown }): Promise<unknown>
}

interface DefaultModel {
  currentSelection(): { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
}

/** Where an imported session ended up. */
export interface PersistedSession {
  readonly id: string
  /** The session was already in DSH (imported before): it was opened, not written again. */
  readonly reused: boolean
  /** The session is live in this DSH, so the browser can open it now. */
  readonly live: boolean
  /** The workspace the session is grouped under, when its directory is one. */
  readonly workspace?: string
}

/**
 * Persist a synthesized session, or reuse the one an earlier import wrote, and make it live.
 * @param legacyIds - ids earlier versions gave the same source session; one already stored is reused.
 */
export async function persistImported(ctx: Context, synthesized: SynthesizedSession, legacyIds: readonly string[] = []): Promise<PersistedSession> {
  const persistence = dshService(ctx, 'sessionPersistence') as SessionPersistence | undefined
  if (persistence === undefined) throw new Error('sessionPersistence service is not available')
  const stored = await storedIds(persistence)
  const existing = [synthesized.meta.id, ...legacyIds].find(id => stored.has(id))
  const workspace = await workspaceFor(ctx, synthesized.meta.cwd)
  const id = existing ?? synthesized.meta.id
  if (existing === undefined) {
    const cwd = workspace?.path ?? synthesized.meta.cwd
    const handle = await persistence.create({
      version: 4,
      id,
      createdAt: synthesized.meta.createdAt,
      isSeeded: false,
      ...(cwd !== undefined ? { cwd } : {}),
      delegationDepth: synthesized.meta.delegationDepth,
      ...(synthesized.meta.origin !== undefined ? { origin: synthesized.meta.origin } : {}),
      ...(synthesized.meta.parentSession !== undefined ? { parentSession: synthesized.meta.parentSession } : {}),
    })
    try {
      await handle.append(synthesized.events)
      await handle.flush()
    } finally {
      await handle.close()
    }
  }
  const grouped = workspace !== undefined && await attach(workspace, id)
  return {
    id,
    reused: existing !== undefined,
    live: await makeLive(ctx, id),
    ...(grouped ? { workspace: workspace.path } : {}),
  }
}

async function storedIds(persistence: SessionPersistence): Promise<Set<string>> {
  const ids = new Set<string>()
  if (typeof persistence.list !== 'function') return ids
  try {
    for (const entry of await persistence.list()) {
      // Current hosts list `{ header, revision, sizeBytes }`; older ones listed the headers.
      const record = entry as { header?: { id?: unknown }; id?: unknown } | null
      const id = record?.header !== undefined ? record.header.id : record?.id
      if (typeof id === 'string') ids.add(id)
    }
  } catch {
    // An unreadable listing only means the import cannot tell it ran before.
  }
  return ids
}

/** The workspace of a session's directory: DSH groups a session only under the workspace whose path is its cwd. */
async function workspaceFor(ctx: Context, cwd: string | undefined): Promise<Workspace | undefined> {
  const registry = dshService(ctx, 'workspaceRegistry') as WorkspaceRegistry | undefined
  if (registry === undefined || cwd === undefined || !isDirectory(cwd) || resolve(cwd) === resolve(homedir())) return undefined
  try {
    return await registry.create(cwd)
  } catch {
    return undefined
  }
}

async function attach(workspace: Workspace, id: string): Promise<boolean> {
  if (workspace.sessionIds?.includes(id) === true) return true
  try {
    await workspace.attachSession(id)
    return true
  } catch {
    return false
  }
}

/**
 * Resume the session the way opening it in the browser does (`sessionController.resolveAgent`), which also
 * announces it to the session list; without the controller (a headless profile), through `agents.resume`.
 */
async function makeLive(ctx: Context, id: string): Promise<boolean> {
  const agents = dshService(ctx, 'agents') as Agents | undefined
  const live = (): boolean => agents?.get?.(id) !== undefined
  if (live()) return true
  const controller = dshService(ctx, 'sessionController') as SessionController | undefined
  try {
    if (typeof controller?.resolveAgent === 'function') {
      const result = await controller.resolveAgent(id)
      if (result.error === undefined) return true
    } else if (typeof agents?.resume === 'function') {
      const defaults = dshService(ctx, 'agentDefaultModel') as DefaultModel | undefined
      await agents.resume({
        resumeSessionId: id,
        ...(defaults !== undefined
          ? {
              agentOptions: {
                get provider() { return defaults.currentSelection().provider },
                get model() { return defaults.currentSelection().model },
                get reasoningEffort() { return defaults.currentSelection().reasoningEffort },
              },
            }
          : {}),
      })
    }
  } catch {
    // The session is stored either way; it becomes live when it is opened after a restart.
  }
  return live()
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
