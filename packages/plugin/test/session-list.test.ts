import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { discoverCodexSessions } from '../src/sessions/codex.js'
import { discoverClaudeSessions } from '../src/sessions/claude.js'
import { startSessions } from '../src/sessions/row.js'
import type { SessionPage, SessionsApi } from '../src/forge/contract.js'

const temporary: string[] = []
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fake `~/.codex`, laid out as Codex does; the sessions folder is what discovery is given. */
function codexHome(): { home: string; sessions: string } {
  const home = mkdtempSync(join(tmpdir(), 'harness-forge-codex-list-'))
  temporary.push(home)
  const sessions = join(home, 'sessions')
  mkdirSync(sessions, { recursive: true })
  return { home, sessions }
}

const uuid = (n: number): string => `01a00000-0000-7000-8000-${String(n).padStart(12, '0')}`
const AGENTS = { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions\n\n<INSTRUCTIONS>be nice</INSTRUCTIONS>' }] } }
const ENVIRONMENT = { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } }
const itemPrompt = (text: string): unknown => ({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text }] } } })
const meta = (id: string, extra: Record<string, unknown> = {}): unknown => ({
  timestamp: '2026-11-01T00:00:00.000Z',
  type: 'session_meta',
  payload: { id, session_id: id, timestamp: '2026-11-01T00:00:00.000Z', cwd: '/w', source: 'vscode', base_instructions: 'x'.repeat(20_000), ...extra },
})

/** Write a rollout whose file name and modification time (seconds since epoch) are the ones Codex's would be. */
function rollout(dir: string, id: string, lines: readonly unknown[], options: { at?: number; stamp?: string; suffix?: string; zst?: boolean } = {}): string {
  const folder = join(dir, '2026', '11', '01')
  mkdirSync(folder, { recursive: true })
  const stamp = options.stamp ?? '2026-11-01T00-00-00'
  const path = join(folder, `rollout-${stamp}-${id}${options.suffix ?? ''}.jsonl${options.zst === true ? '.zst' : ''}`)
  const text = lines.map(line => JSON.stringify(line)).join('\n')
  writeFileSync(path, options.zst === true ? zstdCompressSync(Buffer.from(text)) : text)
  if (options.at !== undefined) utimesSync(path, options.at, options.at)
  return path
}

/** Every session, page after page; tolerates the plain array an older version returned. */
async function allCodex(root: string, limit = 50): Promise<Array<{ sourceId: string; title?: string; path: string; archived?: boolean }>> {
  const out: Array<{ sourceId: string; title?: string; path: string; archived?: boolean }> = []
  let cursor: number | undefined
  for (let pages = 0; pages < 100; pages++) {
    const result = await discoverCodexSessions(root, { limit, ...(cursor !== undefined ? { cursor } : {}) } as never) as unknown as SessionPage<(typeof out)[number]> | typeof out
    if (Array.isArray(result)) return result
    out.push(...result.sessions)
    if (result.next === undefined) return out
    cursor = result.next
  }
  throw new Error('paging did not end')
}

describe('the Codex import list', () => {
  it('titles a session with its thread name, else with what the person first said (either way Codex writes it)', async () => {
    const { home, sessions } = codexHome()
    rollout(sessions, uuid(1), [meta(uuid(1)), AGENTS, ENVIRONMENT, itemPrompt('Fix the build please')], { at: 1_000 })
    rollout(sessions, uuid(2), [meta(uuid(2)), { type: 'event_msg', payload: { type: 'user_message', message: 'Old style\nprompt' } }], { at: 2_000 })
    rollout(sessions, uuid(3), [meta(uuid(3)), AGENTS, itemPrompt('ignored: the thread has a name')], { at: 3_000 })
    writeFileSync(join(home, 'session_index.jsonl'), [
      JSON.stringify({ id: uuid(3), thread_name: 'First name', updated_at: '2026-11-01T00:00:00Z' }),
      JSON.stringify({ id: uuid(3), thread_name: '整理 Git 配置', updated_at: '2026-11-02T00:00:00Z' }),
      'not json',
    ].join('\n'))
    const found = await allCodex(sessions)
    expect(found.map(item => [item.sourceId, item.title])).toEqual([
      [uuid(3), '整理 Git 配置'],
      [uuid(2), 'Old style prompt'],
      [uuid(1), 'Fix the build please'],
    ])
  })

  it('lists every rollout of every date, newest first, and pages through them without a cap', async () => {
    const { sessions } = codexHome()
    // A few rollouts, each on its own date and written in an order no folder order gives; small pages make
    // several of them. (Creating hundreds of files is slow on Windows, and the properties do not need them.)
    const count = 11
    const pageSize = 4
    const order = [7, 2, 10, 5, 0, 8, 3, 9, 1, 6, 4]
    for (let n = 1; n <= count; n++) {
      const folder = join(sessions, '2026', String(n).padStart(2, '0'), String(1 + ((n * 5) % 28)).padStart(2, '0'))
      mkdirSync(folder, { recursive: true })
      const path = join(folder, `rollout-2026-01-01T00-00-00-${uuid(n)}.jsonl`)
      writeFileSync(path, [meta(uuid(n)), itemPrompt(`Session ${n}`)].map(line => JSON.stringify(line)).join('\n'))
      utimesSync(path, 10_000 + order[n - 1]!, 10_000 + order[n - 1]!)
    }
    const newestFirst = Array.from({ length: count }, (_, index) => index + 1).sort((a, b) => order[b - 1]! - order[a - 1]!).map(uuid)
    expect((await allCodex(sessions, pageSize)).map(item => item.sourceId)).toEqual(newestFirst)
    const first = await discoverCodexSessions(sessions, { limit: pageSize })
    expect(first.sessions).toHaveLength(pageSize)
    expect(first.next).toBe(pageSize)
    // Whatever the page size, paging until done gives every session: neither the page size nor the number of pages caps the list.
    expect((await allCodex(sessions, 1)).map(item => item.sourceId)).toEqual(newestFirst)
    const whole = await discoverCodexSessions(sessions, { limit: count + 1 })
    expect(whole.sessions.map(item => item.sourceId)).toEqual(newestFirst)
    expect(whole.next).toBeUndefined()
  })

  it('reads compressed rollouts and the archived ones', async () => {
    const { home, sessions } = codexHome()
    rollout(sessions, uuid(1), [meta(uuid(1)), itemPrompt('Compressed one')], { zst: true, at: 5_000 })
    const archive = join(home, 'archived_sessions')
    mkdirSync(archive)
    writeFileSync(join(archive, `rollout-2026-09-01T00-00-00-${uuid(2)}.jsonl`), [meta(uuid(2)), itemPrompt('Archived one')].map(line => JSON.stringify(line)).join('\n'))
    utimesSync(join(archive, `rollout-2026-09-01T00-00-00-${uuid(2)}.jsonl`), 4_000, 4_000)
    const found = await allCodex(sessions)
    expect(found.map(item => [item.title, item.archived ?? false])).toEqual([['Compressed one', false], ['Archived one', true]])
  })

  it('lists a thread once however many files hold it, and a fork as its own session', async () => {
    const { sessions } = codexHome()
    rollout(sessions, uuid(1), [meta(uuid(1)), itemPrompt('Thread one')], { at: 1_000 })
    // Codex continues a thread in a new file named with a segment id: same thread, same session.
    rollout(sessions, uuid(1), [meta(uuid(1)), itemPrompt('Thread one')], { at: 3_000, suffix: `_${uuid(9)}`, stamp: '2026-11-02T00-00-00' })
    // A fork has its own thread id; `session_id` is the parent's.
    rollout(sessions, uuid(2), [meta(uuid(2), { session_id: uuid(1), forked_from_id: uuid(1) }), itemPrompt('Thread one')], { at: 2_000 })
    const found = await allCodex(sessions)
    expect(found.map(item => item.sourceId)).toEqual([uuid(1), uuid(2)])
    expect(found[0]!.path).toContain(`_${uuid(9)}`)
  })

  it('leaves out the threads of subagents', async () => {
    const { sessions } = codexHome()
    rollout(sessions, uuid(1), [meta(uuid(1)), itemPrompt('Main')], { at: 1_000 })
    rollout(sessions, uuid(2), [meta(uuid(2), { source: { subagent: { thread_spawn: { parent_thread_id: uuid(1) } } } }), itemPrompt('Worker task')], { at: 2_000 })
    expect((await allCodex(sessions)).map(item => item.sourceId)).toEqual([uuid(1)])
  })
})

describe('the Claude Code import list', () => {
  function transcript(root: string, project: string, id: string, at: number, prompt: string): void {
    const dir = join(root, project)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${id}.jsonl`)
    writeFileSync(path, JSON.stringify({ type: 'user', uuid: `u-${id}`, parentUuid: null, sessionId: id, cwd: '/w', timestamp: '2026-11-01T00:00:00.000Z', message: { role: 'user', content: prompt } }))
    utimesSync(path, at, at)
  }

  it('lists the newest sessions first and pages, instead of the first 200 by path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-forge-claude-list-'))
    temporary.push(root)
    // "-a" sorts first by path and is the oldest; "-z" is the newest.
    for (let n = 1; n <= 230; n++) transcript(root, n <= 115 ? '-a' : '-z', `s${String(n).padStart(3, '0')}`, 10_000 + n, `Prompt ${n}`)
    const page = await discoverClaudeSessions(root, { limit: 200 }) as unknown as SessionPage<{ sourceId: string }> | Array<{ sourceId: string }>
    const first = Array.isArray(page) ? page : page.sessions
    expect(first[0]!.sourceId).toBe('s230')
    const next = Array.isArray(page) ? undefined : page.next
    expect(next).toBe(200)
    const rest = await discoverClaudeSessions(root, { cursor: 200, limit: 200 })
    expect([...first, ...rest.sessions].map(item => item.sourceId)).toHaveLength(230)
    expect(rest.next).toBeUndefined()
  })
})

describe('sessions already imported', () => {
  it('are marked with the DSH session that holds them, by the prefixed id or an older bare one', async () => {
    const { sessions: root } = codexHome()
    rollout(root, uuid(1), [meta(uuid(1)), itemPrompt('Prefixed')], { at: 3_000 })
    rollout(root, uuid(2), [meta(uuid(2)), itemPrompt('Bare')], { at: 2_000 })
    rollout(root, uuid(3), [meta(uuid(3)), itemPrompt('Not imported')], { at: 1_000 })
    // Every import stores the thread's creation time, which is what tells a stored session's thread.
    const createdAt = Date.parse('2026-11-01T00:00:00.000Z')
    const stored = [`codex-${uuid(1)}`, uuid(2)]
    const ctx = { get: (name: string) => name === 'sessionPersistence' ? { async list() { return stored.map(id => ({ header: { id, createdAt } })) } } : undefined } as unknown as Context
    let api: SessionsApi | undefined
    startSessions(ctx, { provide: (_: string, value: SessionsApi) => { api = value; return () => {} } } as never)
    const page = await api!.sessions(root, 'codex')
    expect((page.sessions as Array<{ title: string; importedId?: string }>).map(item => [item.title, item.importedId])).toEqual([
      ['Prefixed', `codex-${uuid(1)}`],
      ['Bare', uuid(2)],
      ['Not imported', undefined],
    ])
  })
})
