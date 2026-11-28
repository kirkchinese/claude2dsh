/**
 * Which DSH session holds a source session, the same in the list and in the import: provenance for the Codex ids
 * 0.4.0 gave a thread and its forks alike, rows keyed by source and session (never by path), one Codex thread per
 * list, one title, structured errors, and OpenCode rows read one at a time.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, StatementSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { MAX_SESSION_BYTES, SessionTooLargeError, synthesizeDshSession } from '@kirkchinese/harness-forge-core'
import { discoverCodexSessions, importCodexSession, readCodexSession } from '../src/sessions/codex.js'
import { importOpenCodeSession } from '../src/sessions/opencode.js'
import { SessionMaybeImportedError } from '../src/sessions/persist.js'
import { startSessions } from '../src/sessions/row.js'
import { HarnessRemoteService } from '../src/workbench/remote.js'
import { CallError } from '../src/client/typert.js'
import { importErrorText, rowKey, sessionRowState, type SessionView } from '../src/client/secondary.js'
import english from '../src/client/locale/en.json' with { type: 'json' }
import type { SessionsApi } from '../src/forge/contract.js'
import type { TFn } from '../src/client/shared.js'

const temporary: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-forge-identity-'))
  temporary.push(dir)
  return dir
}

const t = ((key: string) => (english as Record<string, string>)[key] ?? key) as TFn

interface Stored { readonly id: string; readonly createdAt?: number; readonly events?: readonly unknown[] }

/** A DSH holding `stored` (headers as 0.4.0 wrote them: id and createdAt, and their events), recording what is created. */
function host(stored: readonly Stored[] = []): { ctx: Context; created: string[]; api: SessionsApi } {
  const headers = new Map(stored.map(({ events: _, ...header }) => [header.id, header]))
  const logs = new Map(stored.map(session => [session.id, [...session.events ?? []]]))
  const created: string[] = []
  const persistence = {
    async list() { return [...headers.values()].map(header => ({ header, revision: 1 })) },
    async create(header: Stored) {
      created.push(header.id)
      headers.set(header.id, header)
      const log: unknown[] = []
      logs.set(header.id, log)
      return { async append(events: readonly unknown[]) { log.push(...events) }, async flush() {}, async close() {} }
    },
    async open(id: string) {
      const log = logs.get(id)
      if (log === undefined) throw new Error(`no session ${id}`)
      return { async read(offset = 0, length = log.length) { return { events: log.slice(offset, offset + length) } }, async close() {} }
    },
  }
  const ctx = { get: (name: string) => (name === 'sessionPersistence' ? persistence : undefined) } as unknown as Context
  let api: SessionsApi | undefined
  startSessions(ctx, { provide: (_: string, value: SessionsApi) => { api = value; return () => {} } } as never)
  return { ctx, created, api: api! }
}

const PARENT = '01a00000-0000-7000-8000-00000000000a'
const CHILD = '01a00000-0000-7000-8000-00000000000b'
const PARENT_AT = '2026-11-01T00:00:00.000Z'
const CHILD_AT = '2026-11-02T00:00:00.000Z'

const line = (value: unknown): string => JSON.stringify(value)
const prompt = (text: string, at?: string): unknown => ({ ...(at !== undefined ? { timestamp: at } : {}), type: 'event_msg', payload: { type: 'user_message', message: text } })
const reply = (text: string): unknown => ({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } })

/**
 * A `~/.codex` with a parent thread and its fork. The fork's `session_meta` names its own thread (`id`) and its
 * parent's (`session_id`), and its rollout starts with the parent's conversation. `timed: false` writes rollouts
 * without any time, which leaves nothing to tell the threads by.
 */
function codexHome(options: { timed?: boolean } = {}): { home: string; sessions: string; parent: string; child: string } {
  const home = tempDir()
  const sessions = join(home, 'sessions')
  const folder = join(sessions, '2026', '11', '01')
  mkdirSync(folder, { recursive: true })
  const timed = options.timed !== false
  const meta = (id: string, sessionId: string, at: string): unknown => ({
    ...(timed ? { timestamp: at } : {}),
    type: 'session_meta',
    payload: { id, session_id: sessionId, ...(timed ? { timestamp: at } : {}), cwd: '/w', source: 'cli' },
  })
  const parent = join(folder, `rollout-2026-11-01T00-00-00-${PARENT}.jsonl`)
  writeFileSync(parent, [meta(PARENT, PARENT, PARENT_AT), prompt('Plan the work'), reply('Planned.')].map(line).join('\n'))
  utimesSync(parent, 1_000, 1_000)
  const child = join(folder, `rollout-2026-11-02T00-00-00-${CHILD}.jsonl`)
  writeFileSync(child, [meta(CHILD, PARENT, CHILD_AT), prompt('Plan the work'), reply('Planned.'), prompt('Now try it another way'), reply('Tried.')].map(line).join('\n'))
  utimesSync(child, 2_000, 2_000)
  return { home, sessions, parent, child }
}

type Row = { sourceId: string; importedId?: string; maybeImportedId?: string; newId?: string; title?: string }
async function rows(api: SessionsApi, root: string, source: 'codex' | 'opencode' = 'codex'): Promise<Map<string, Row>> {
  const page = await api.sessions(root, source)
  return new Map((page.sessions as Row[]).map(row => [row.sourceId, row]))
}

describe('a Codex fork imported before this version (stored under its parent\'s id)', () => {
  it('is found again by its creation time and its turns, in the list and on import, instead of being imported twice', async () => {
    const { sessions, child, parent } = codexHome()
    // The build before this one stored the fork under `codex-<session_id>`, the parent's id, with the fork's creation time.
    const dsh = host([await storedAs(`codex-${PARENT}`, child)])
    const listed = await rows(dsh.api, sessions)
    expect(listed.get(CHILD)).toMatchObject({ importedId: `codex-${PARENT}` })
    expect(await importCodexSession(dsh.ctx, child)).toMatchObject({ id: `codex-${PARENT}`, reused: true })
    expect(dsh.created).toEqual([])
    // The parent is not the session stored under its id: it is imported under an id of its own.
    expect(listed.get(PARENT)?.importedId).toBeUndefined()
    const imported = await importCodexSession(dsh.ctx, parent)
    expect(imported).toMatchObject({ id: `codex-${PARENT}-${Date.parse(PARENT_AT)}`, reused: false })
    expect((await rows(dsh.api, sessions)).get(PARENT)).toMatchObject({ importedId: imported.id })
  })

  it('is told apart from the parent stored under that id: the fork is imported as a new session', async () => {
    const { sessions, child } = codexHome()
    const dsh = host([{ id: `codex-${PARENT}`, createdAt: Date.parse(PARENT_AT) }])
    const listed = await rows(dsh.api, sessions)
    expect(listed.get(PARENT)).toMatchObject({ importedId: `codex-${PARENT}` })
    expect(listed.get(CHILD)).not.toHaveProperty('importedId')
    expect(listed.get(CHILD)).not.toHaveProperty('maybeImportedId')
    expect(await importCodexSession(dsh.ctx, child)).toMatchObject({ id: `codex-${CHILD}`, reused: false })
    expect(dsh.created).toEqual([`codex-${CHILD}`])
  })

  it('is offered both ways when nothing tells which thread the stored session holds, and never imported silently', async () => {
    const { sessions, child } = codexHome({ timed: false })
    // Rollouts without times: an earlier version stored the creation time as 0.
    const dsh = host([{ id: `codex-${PARENT}`, createdAt: 0 }])
    const row = (await rows(dsh.api, sessions)).get(CHILD)
    expect(row).toMatchObject({ maybeImportedId: `codex-${PARENT}`, newId: `codex-${CHILD}` })
    expect(row).not.toHaveProperty('importedId')
    await expect(importCodexSession(dsh.ctx, child)).rejects.toBeInstanceOf(SessionMaybeImportedError)
    expect(dsh.created).toEqual([])
    // "Import as new".
    expect(await dsh.api.importSession(child, row!.newId, 'codex', CHILD)).toMatchObject({ id: `codex-${CHILD}`, reused: false })
    expect((await rows(dsh.api, sessions)).get(CHILD)).toMatchObject({ importedId: `codex-${CHILD}` })
  })
})

/** The events an earlier Harness Forge stored for a rollout, under the id it gave it. */
async function storedAs(id: string, path: string): Promise<Stored> {
  const { session } = await readCodexSession(path)
  const synthesized = synthesizeDshSession({ ...session, id, source: { ...session.source, sessionId: id } })
  return { id, createdAt: session.createdAt, events: synthesized.events }
}

/**
 * A `~/.codex` with a parent thread and two forks of it created at one time, as `timestamp` records it: by default
 * told apart by their second prompt; `replies` gives them the same prompts and these answers to the second.
 */
function twinForks(replies?: readonly [string, string]): { sessions: string; first: string; second: string } {
  const { sessions } = codexHome()
  const folder = join(sessions, '2026', '11', '03')
  mkdirSync(folder, { recursive: true })
  const fork = (id: string, prompt2: string, answer: string, at: number): string => {
    const path = join(folder, `rollout-2026-11-03T00-00-00-${id}.jsonl`)
    const meta = { timestamp: TWIN_AT, type: 'session_meta', payload: { id, session_id: PARENT, timestamp: TWIN_AT, cwd: '/w', source: 'cli' } }
    writeFileSync(path, [meta, prompt('Plan the work'), reply('Planned.'), prompt(prompt2), reply(answer)].map(line).join('\n'))
    utimesSync(path, at, at)
    return path
  }
  return replies === undefined
    ? { sessions, first: fork(TWIN_A, 'Take the first road', 'Done.', 3_000), second: fork(TWIN_B, 'Take the second road', 'Done.', 4_000) }
    : { sessions, first: fork(TWIN_A, 'Try again', replies[0], 3_000), second: fork(TWIN_B, 'Try again', replies[1], 4_000) }
}

const TWIN_A = '01a00000-0000-7000-8000-00000000000c'
const TWIN_B = '01a00000-0000-7000-8000-00000000000d'
const TWIN_AT = '2026-11-03T00:00:00.000Z'

describe('a Codex thread 0.4.0 stored under the bare session id its forks share', () => {
  it('is not taken for a fork created at the same time: what the stored session says tells them apart', async () => {
    const { sessions, first, second } = twinForks()
    // 0.4.0 imported the first fork only, under the bare `session_id` both forks (and the parent) carry.
    const dsh = host([await storedAs(PARENT, first)])
    const listed = await rows(dsh.api, sessions)
    expect(listed.get(TWIN_A)).toMatchObject({ importedId: PARENT })
    expect(listed.get(TWIN_B)).not.toHaveProperty('importedId')
    expect(listed.get(TWIN_B)).not.toHaveProperty('maybeImportedId')
    expect(await importCodexSession(dsh.ctx, second)).toMatchObject({ id: `codex-${TWIN_B}`, reused: false })
    expect(await importCodexSession(dsh.ctx, first)).toMatchObject({ id: PARENT, reused: true })
    expect(dsh.created).toEqual([`codex-${TWIN_B}`])
  })

  it('leaves the choice to the person when the stored session only begins like the fork', async () => {
    const { sessions, second } = twinForks()
    // A session that holds the forks' common start, then nothing: either fork, continued later, would begin so.
    const { session } = await readCodexSession(second)
    const head = { ...session, id: PARENT, source: { ...session.source, sessionId: PARENT }, turns: session.turns.slice(0, 1) }
    const dsh = host([{ id: PARENT, createdAt: session.createdAt, events: synthesizeDshSession(head).events }])
    expect((await rows(dsh.api, sessions)).get(TWIN_B)).toMatchObject({ maybeImportedId: PARENT, newId: `codex-${TWIN_B}` })
    await expect(importCodexSession(dsh.ctx, second)).rejects.toBeInstanceOf(SessionMaybeImportedError)
    expect(dsh.created).toEqual([])
  })

  it('with the same prompts as its twin is told apart by the answers: each one finds its own', async () => {
    for (const [imported, other, importedPath, otherPath] of [[TWIN_A, TWIN_B, 'first', 'second'], [TWIN_B, TWIN_A, 'second', 'first']] as const) {
      const twins = twinForks(['The first answer.', 'The second answer.'])
      const dsh = host([await storedAs(PARENT, twins[importedPath])])
      const listed = await rows(dsh.api, twins.sessions)
      expect(listed.get(imported)).toMatchObject({ importedId: PARENT })
      expect(listed.get(other)).not.toHaveProperty('importedId')
      expect(listed.get(other)).not.toHaveProperty('maybeImportedId')
      expect(await importCodexSession(dsh.ctx, twins[otherPath])).toMatchObject({ id: `codex-${other}`, reused: false })
      expect(await importCodexSession(dsh.ctx, twins[importedPath])).toMatchObject({ id: PARENT, reused: true })
      expect(dsh.created).toEqual([`codex-${other}`])
    }
  })

  it('identical to its twin in every turn leaves the choice to the person, for both', async () => {
    const twins = twinForks(['The same answer.', 'The same answer.'])
    const dsh = host([await storedAs(PARENT, twins.first)])
    const listed = await rows(dsh.api, twins.sessions)
    expect(listed.get(TWIN_A)).toMatchObject({ maybeImportedId: PARENT })
    expect(listed.get(TWIN_B)).toMatchObject({ maybeImportedId: PARENT })
    await expect(importCodexSession(dsh.ctx, twins.first)).rejects.toBeInstanceOf(SessionMaybeImportedError)
    await expect(importCodexSession(dsh.ctx, twins.second)).rejects.toBeInstanceOf(SessionMaybeImportedError)
    expect(dsh.created).toEqual([])
  })

  it('is reused silently when no other thread shares its id, even after it went on in Codex', async () => {
    const home = tempDir()
    const folder = join(home, 'sessions', '2026', '11', '01')
    mkdirSync(folder, { recursive: true })
    const path = join(folder, `rollout-2026-11-01T00-00-00-${PARENT}.jsonl`)
    const meta = { timestamp: PARENT_AT, type: 'session_meta', payload: { id: PARENT, session_id: PARENT, timestamp: PARENT_AT, cwd: '/w', source: 'cli' } }
    writeFileSync(path, [meta, prompt('Plan the work'), reply('Planned.')].map(line).join('\n'))
    const dsh = host([await storedAs(PARENT, path)])
    writeFileSync(path, [meta, prompt('Plan the work'), reply('Planned.'), prompt('And then?'), reply('Then this.')].map(line).join('\n'))
    expect((await rows(dsh.api, join(home, 'sessions'))).get(PARENT)).toMatchObject({ importedId: PARENT })
    expect(await importCodexSession(dsh.ctx, path)).toMatchObject({ id: PARENT, reused: true })
    expect(dsh.created).toEqual([])
  })
})

describe('Codex threads in older rollout files', () => {
  it('are listed once across pages, even when two files whose names do not carry the thread hold it', async () => {
    const { sessions } = codexHome()
    const folder = join(sessions, '2025', '01', '01')
    mkdirSync(folder, { recursive: true })
    const old = (name: string, id: string, at: number): void => {
      const path = join(folder, name)
      writeFileSync(path, [{ timestamp: PARENT_AT, type: 'session_meta', payload: { id, timestamp: PARENT_AT, cwd: '/w' } }, prompt(`Old ${id}`)].map(line).join('\n'))
      utimesSync(path, at, at)
    }
    old('rollout-2025-01-01T00-00-00-a.jsonl', 'old-thread', 900)
    old('rollout-2025-01-01T00-00-01-b.jsonl', 'old-thread', 800)
    old('rollout-2025-01-01T00-00-02-c.jsonl', 'other-thread', 700)
    const seen: string[] = []
    let cursor: number | undefined
    for (let pages = 0; pages < 10; pages++) {
      const page = await discoverCodexSessions(sessions, { limit: 1, ...(cursor !== undefined ? { cursor } : {}) })
      seen.push(...page.sessions.map(session => session.sourceId))
      if (page.next === undefined) break
      cursor = page.next
    }
    expect(seen).toEqual([CHILD, PARENT, 'old-thread', 'other-thread'])
  })
})

describe('a Codex thread\'s title', () => {
  it('is the one the list shows when it is imported: the thread name from session_index.jsonl', async () => {
    const { home, sessions, child } = codexHome()
    writeFileSync(join(home, 'session_index.jsonl'), line({ id: CHILD, thread_name: 'Second approach' }))
    const dsh = host()
    expect((await rows(dsh.api, sessions)).get(CHILD)?.title).toBe('Second approach')
    expect((await importCodexSession(dsh.ctx, child)).title).toBe('Second approach')
  })
})

describe('the rows of one source', () => {
  function openCodeDatabase(): string {
    const path = join(tempDir(), 'opencode.db')
    const db = new DatabaseSync(path)
    db.exec(`
      create table session (id text primary key, parent_id text, title text, directory text, time_created integer, time_updated integer);
      create table message (id text primary key, session_id text, time_created integer, data text);
      create table part (id text primary key, message_id text, session_id text, time_created integer, data text);
    `)
    for (const [n, id] of ['ses_a', 'ses_b'].entries()) {
      db.prepare('insert into session values (?, null, ?, ?, ?, ?)').run(id, n === 0 ? 'First' : null, '/w', 1000 + n, 2000 + n)
      db.prepare('insert into message values (?, ?, ?, ?)').run(`m_u_${id}`, id, 1001, line({ role: 'user', time: { created: 1001 } }))
      db.prepare('insert into part values (?, ?, ?, ?, ?)').run(`p_u_${id}`, `m_u_${id}`, id, 1001, line({ type: 'text', text: `Hello ${id}` }))
      db.prepare('insert into message values (?, ?, ?, ?)').run(`m_a_${id}`, id, 1002, line({ role: 'assistant', time: { created: 1002 } }))
      db.prepare('insert into part values (?, ?, ?, ?, ?)').run(`p_a_${id}`, `m_a_${id}`, id, 1002, line({ type: 'text', text: 'Hi' }))
    }
    db.close()
    return path
  }

  it('share a path (OpenCode\'s one database) and are still told apart, on the server and in the browser', async () => {
    const path = openCodeDatabase()
    const dsh = host([{ id: 'opencode-ses_a', createdAt: 1000 }])
    const listed = await rows(dsh.api, path, 'opencode')
    expect(listed.get('ses_a')?.importedId).toBe('opencode-ses_a')
    expect(listed.get('ses_b')?.importedId).toBeUndefined()
    const [a, b] = ['ses_a', 'ses_b'].map(id => ({ source: 'opencode', path, sourceId: id } satisfies SessionView))
    // Importing one row marks that row only, and only it shows "Importing…".
    const imported = { [rowKey(a!)]: 'opencode-ses_a' }
    expect(sessionRowState(t, a!, imported, rowKey(a!))).toMatchObject({ openId: 'opencode-ses_a', importing: true })
    expect(sessionRowState(t, b!, imported, rowKey(a!))).toMatchObject({ importing: false })
    expect(sessionRowState(t, b!, imported, rowKey(a!)).openId).toBeUndefined()
    // A Codex thread and an OpenCode session with one id are two rows.
    expect(rowKey({ ...a!, source: 'codex' })).not.toBe(rowKey(a!))
  })

  it('read an OpenCode session one row at a time: no statement materializes a session\'s messages or parts', async () => {
    const path = openCodeDatabase()
    const all = StatementSync.prototype.all
    const materialized: string[] = []
    vi.spyOn(StatementSync.prototype, 'all').mockImplementation(function (this: StatementSync, ...params: never[]) {
      materialized.push(this.sourceSQL)
      return all.apply(this, params)
    })
    const report = await importOpenCodeSession(host().ctx, path, 'ses_b')
    expect(report.turns).toBe(1)
    expect(materialized.filter(sql => /\bfrom (?:message|part|session_message)\b/u.test(sql))).toEqual([])
  })
})

describe('what a row and an import failure say', () => {
  it('calls a session without a title "Untitled session", not by its id', () => {
    expect(sessionRowState(t, { source: 'opencode', path: '/db', sourceId: 'ses_x' }, {}, undefined).title).toBe('Untitled session')
  })

  it('carries the size and the limit of a session too large to import, and words them in the person\'s language', async () => {
    const remote = Object.create(HarnessRemoteService.prototype) as HarnessRemoteService
    const failWith = (error: Error): void => {
      Object.defineProperty(remote, 'forge', { configurable: true, value: { lookup: () => ({ importSession: () => { throw error } }) } })
    }
    const reach = async (): Promise<CallError> => {
      const error = await remote.importSession({ path: '/x.jsonl.zst', source: 'codex' }).then(() => undefined, (cause: unknown) => cause) as { code: string; message: string; details: Record<string, unknown> }
      return new CallError(error.message, error.code, error.details)
    }
    // A small compressed rollout that decodes past the ceiling: its size was not known when it was listed.
    failWith(new SessionTooLargeError(undefined, MAX_SESSION_BYTES))
    const decoded = await reach()
    expect(decoded).toMatchObject({ code: 'harness-forge/session-too-large', details: { operation: 'importSession', limit: MAX_SESSION_BYTES } })
    expect(decoded.details).not.toHaveProperty('size')
    expect(importErrorText(t, decoded)).toBe('This session is too large to import: decompressed, it is over the limit of 100 MB.')
    failWith(new SessionTooLargeError(300_000_000, MAX_SESSION_BYTES))
    const sized = await reach()
    expect(sized.details).toMatchObject({ size: 300_000_000, limit: MAX_SESSION_BYTES })
    expect(importErrorText(t, sized)).toBe('This session is too large to import (300 MB; the limit is 100 MB).')
    failWith(new SessionMaybeImportedError('codex-x'))
    const maybe = await reach()
    expect(maybe).toMatchObject({ code: 'harness-forge/session-maybe-imported', details: { existingId: 'codex-x' } })
    expect(importErrorText(t, maybe)).toBe(english.sessionMaybeImported)
  })
})

const SUBAGENT = '01a00000-0000-7000-8000-00000000000e'
const OTHER_SUBAGENT = '01a00000-0000-7000-8000-00000000000f'
const SUBAGENT_AT = '2026-11-04T00:00:00.000Z'

/** `codexHome()` plus two subagent threads Codex spawned from the parent. */
function subagentHome(): { sessions: string; subagent: string; other: string } {
  const { sessions } = codexHome()
  const folder = join(sessions, '2026', '11', '04')
  mkdirSync(folder, { recursive: true })
  const thread = (id: string, at: number): string => {
    const path = join(folder, `rollout-2026-11-04T00-00-00-${id}.jsonl`)
    const meta = { timestamp: SUBAGENT_AT, type: 'session_meta', payload: { id, session_id: PARENT, timestamp: SUBAGENT_AT, cwd: '/w', source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1 } } } } }
    writeFileSync(path, [meta, prompt(`Research ${id.slice(-1)}`), reply('Found.')].map(line).join('\n'))
    utimesSync(path, at, at)
    return path
  }
  return { sessions, subagent: thread(SUBAGENT, 5_000), other: thread(OTHER_SUBAGENT, 6_000) }
}

describe('a Codex subagent thread 0.4.0 imported under the bare session id', () => {
  it('is listed, as imported, though subagent threads are otherwise left out of the list', async () => {
    const { sessions, subagent } = subagentHome()
    // 0.4.0 imported the subagent's thread under the bare `session_id` it shares with its parent.
    const dsh = host([await storedAs(PARENT, subagent)])
    const listed = await rows(dsh.api, sessions)
    expect(listed.get(SUBAGENT)).toMatchObject({ importedId: PARENT })
    // The other subagent thread was never imported: still not a session to import on its own.
    expect(listed.has(OTHER_SUBAGENT)).toBe(false)
    // The parent is not the session stored under its id.
    expect(listed.get(PARENT)).not.toHaveProperty('importedId')
  })

  it('stays out of the list when nothing was imported', async () => {
    const { sessions } = subagentHome()
    const listed = await rows(host().api, sessions)
    expect([...listed.keys()].sort()).toEqual([CHILD, PARENT].sort())
  })
})
