/**
 * "Open session" for a session an import stored earlier: DSH knows it again (registered, in its workspace, live), and
 * one the person archived in DSH comes back from the archive instead of opening an empty new-session page.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionsApi } from '../src/forge/contract.js'
import { startSessions } from '../src/sessions/row.js'

const temporary: string[] = []
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A project directory of its own: a session there is grouped under a workspace. */
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-forge-open-'))
  temporary.push(dir)
  return dir
}

const BARE = '01a00000-0000-7000-8000-00000000000a'

interface Options {
  /** Archived in DSH. */
  readonly archived?: boolean
  /** The DSH has no way to unarchive. */
  readonly cannotUnarchive?: boolean
  /** The workspace already lists the session. */
  readonly attached?: boolean
  /** The session is live already. */
  readonly live?: boolean
  /** DSH holds no such session. */
  readonly missing?: boolean
}

/** A DSH holding one session as 0.4.0 stored it (header with its directory, nothing else), with the services opening needs. */
function host(options: Options = {}) {
  const cwd = project()
  const archived = new Set<string>(options.archived === true ? [BARE] : [])
  const attached = new Set<string>(options.attached === true ? [BARE] : [])
  const resolved: string[] = []
  const workspace = {
    path: cwd,
    get sessionIds() { return [...attached] },
    async attachSession(id: string) { attached.add(id) },
  }
  const workspaceRegistry = {
    create: async () => workspace,
    get archivedSessionIds() { return [...archived] },
    ...(options.cannotUnarchive === true ? {} : { unarchiveSession: async (id: string) => { archived.delete(id) } }),
  }
  const persistence = { list: async () => (options.missing === true ? [] : [{ header: { id: BARE, createdAt: 1, cwd }, revision: 1 }]) }
  const services: Record<string, unknown> = {
    sessionPersistence: persistence,
    workspaceRegistry,
    agents: { get: (id: string) => (options.live === true || resolved.includes(id) ? {} : undefined) },
    sessionController: { resolveAgent: async (id: string) => { resolved.push(id); return {} } },
  }
  const ctx = { get: (name: string) => services[name] } as unknown as Context
  let api: SessionsApi | undefined
  startSessions(ctx, { provide: (_: string, value: SessionsApi) => { api = value; return () => {} } } as never)
  return { api: api!, archived, attached, resolved }
}

describe('opening a session an import stored earlier', () => {
  it('registers it with DSH: in the workspace of its directory, and live', async () => {
    const dsh = host()
    expect(await dsh.api.open(BARE)).toMatchObject({ id: BARE, live: true, unarchived: false })
    expect([...dsh.attached]).toEqual([BARE])
    expect(dsh.resolved).toEqual([BARE])
  })

  it('takes it back from the archive when the person archived it in DSH, and says so', async () => {
    const dsh = host({ archived: true, attached: true, live: true })
    expect(await dsh.api.open(BARE)).toMatchObject({ id: BARE, unarchived: true })
    expect([...dsh.archived]).toEqual([])
  })

  it('says it is archived, and leaves it so, when DSH cannot unarchive', async () => {
    const dsh = host({ archived: true, cannotUnarchive: true })
    expect(await dsh.api.open(BARE)).toMatchObject({ id: BARE, archived: true, unarchived: false })
    expect([...dsh.archived]).toEqual([BARE])
  })

  it('opens one that is not archived without touching the archive', async () => {
    const dsh = host({ attached: true, live: true })
    expect(await dsh.api.open(BARE)).toEqual({ id: BARE, live: true, unarchived: false, archived: false })
  })

  it('refuses a session DSH does not hold', async () => {
    await expect(host({ missing: true }).api.open(BARE)).rejects.toThrow(/does not hold/u)
  })
})
