/**
 * Importing sessions that are very large: transcripts are streamed, never held (the line splitter reports the most it
 * holds at once); a transcript above the ceiling is refused (before a byte of it is read: session-reads.test.ts); the
 * list says so beforehand. Large files are written sparse where only their size matters, and every temporary file is
 * removed.
 */
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { MAX_SESSION_BYTES, READ_CHUNK_BYTES, SessionTooLargeError, splitLines, type LineObserver } from '@kirkchinese/harness-forge-core'
import { discoverCodexSessions, importCodexSession, readCodexSession, rolloutLines } from '../src/sessions/codex.js'
import { discoverClaudeSessions, importClaudeSession } from '../src/sessions/claude.js'
import { discoverOpenCodeSessions, importOpenCodeSession } from '../src/sessions/opencode.js'
import { startSessions } from '../src/sessions/row.js'
import { zstdChunks } from '../src/sessions/zstd.js'
import type { SessionsApi } from '../src/forge/contract.js'

const temporary: string[] = []
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-forge-big-'))
  temporary.push(dir)
  return dir
}

const SID = '01a00000-0000-7000-8000-00000000beef'
const META = { timestamp: '2026-11-01T00:00:00.000Z', type: 'session_meta', payload: { id: SID, timestamp: '2026-11-01T00:00:00.000Z', cwd: '/w', source: 'cli' } }
const say = (text: string): unknown => ({ timestamp: '2026-11-01T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: text } })
const reply = (text: string): unknown => ({ timestamp: '2026-11-01T00:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } })
const ROLLOUT = `rollout-2026-11-01T00-00-00-${SID}.jsonl`

/** A rollout of a few turns, with the blobs a real one carries between them. */
function conversation(turns: number, blob = 0): unknown[] {
  const lines: unknown[] = [META]
  for (let i = 0; i < turns; i++) {
    lines.push(say(`question ${i}`))
    if (blob > 0) lines.push({ type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: `thought ${i}` }], encrypted_content: 'e'.repeat(blob) } })
    lines.push({ type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: `c${i}`, arguments: '{"command":["ls"]}' } })
    lines.push({ type: 'response_item', payload: { type: 'function_call_output', call_id: `c${i}`, output: JSON.stringify({ output: `files ${i}` }) } })
    lines.push(reply(`answer ${i} — ünïcode ✓`))
  }
  return lines
}

const jsonl = (lines: readonly unknown[]): string => lines.map(line => JSON.stringify(line)).join('\n') + '\n'

/** A file that claims `bytes` and holds only what `head` says: reading it is never needed to refuse it. */
function sparse(path: string, head: string, bytes: number): void {
  writeFileSync(path, head)
  truncateSync(path, bytes)
}

/** The most the line splitter held at once while the production reader went through `path`. */
async function mostHeld(path: string): Promise<{ held: number; lines: number }> {
  let held = 0
  let lines = 0
  const observer: LineObserver = { held: (bytes) => { held = Math.max(held, bytes) } }
  for await (const _ of rolloutLines(path, observer)) lines++
  return { held, lines }
}

function fakeHost(): { ctx: Context; created: Array<Record<string, unknown>> } {
  const created: Array<Record<string, unknown>> = []
  const persistence = {
    async list() { return [] },
    async create(header: Record<string, unknown>) {
      created.push(header)
      return { async append() {}, async flush() {}, async close() {} }
    },
  }
  return { ctx: { get: (name: string) => name === 'sessionPersistence' ? persistence : undefined } as unknown as Context, created }
}

describe('line splitting', () => {
  const lines = async (chunks: Array<string | Buffer>, maxLine?: number) => {
    const out: Array<[number, string, boolean]> = []
    async function* source(): AsyncGenerator<Buffer> { for (const chunk of chunks) yield Buffer.from(chunk) }
    for await (const line of splitLines(source(), maxLine)) out.push([line.number, line.text, line.oversized])
    return out
  }

  it('numbers lines like a split on newlines and keeps a last line without one', async () => {
    expect(await lines(['a\n\nb\r\n', 'c'])).toEqual([[1, 'a', false], [2, '', false], [3, 'b\r', false], [4, 'c', false]])
  })

  it('does not care where the chunks end, even inside a multi-byte character', async () => {
    const bytes = Buffer.from('héllo ✓\nwörld\n')
    const split = Array.from(bytes, byte => Buffer.from([byte]))
    expect((await lines(split)).map(line => line[1])).toEqual(['héllo ✓', 'wörld'])
  })

  it('skips a line above the limit without holding it, and goes on', async () => {
    expect(await lines(['ok\n', 'x'.repeat(50), 'y'.repeat(50), '\nnext\n', 'z'.repeat(200)], 64)).toEqual([
      [1, 'ok', false],
      [2, '', true],
      [3, 'next', false],
      [4, '', true],
    ])
  })
})

describe('streaming Codex rollouts', () => {
  it('reads the same conversation from a plain file, a compressed one, and one cut into frames anywhere', async () => {
    const dir = tempDir()
    const text = jsonl(conversation(40, 5000))
    const plain = join(dir, ROLLOUT)
    writeFileSync(plain, text)
    const whole = join(dir, `whole-${ROLLOUT}.zst`)
    writeFileSync(whole, zstdCompressSync(Buffer.from(text)))
    // Frames that end inside a line, with a skippable frame between them: the way a file written in pieces looks.
    const bytes = Buffer.from(text)
    const cuts = [0, 1234, 20_000, 50_001, bytes.length]
    const skippable = Buffer.concat([Buffer.from([0x50, 0x2A, 0x4D, 0x18, 3, 0, 0, 0]), Buffer.from('abc')])
    const framed = join(dir, `framed-${ROLLOUT}.zst`)
    writeFileSync(framed, Buffer.concat(cuts.slice(1).flatMap((end, at) => [zstdCompressSync(bytes.subarray(cuts[at]!, end)), skippable])))

    const expected = await readCodexSession(plain)
    expect(expected.session.turns).toHaveLength(40)
    expect(expected.session.turns[3]!.steps[0]!.toolResults[0]!.content).toEqual([{ type: 'text', text: 'files 3' }])
    for (const path of [whole, framed]) {
      const read = await readCodexSession(path)
      expect(read.session.turns).toEqual(expected.session.turns)
      expect(read.title).toBe(expected.title)
      expect(read.legacyId).toBe(expected.legacyId)
    }
  })

  it('does not keep what a continued session cannot use', async () => {
    const path = join(tempDir(), ROLLOUT)
    writeFileSync(path, jsonl(conversation(3, 100_000)))
    const { session } = await readCodexSession(path)
    expect(JSON.stringify(session).length).toBeLessThan(5000)
  })

  it('decodes a compressed file in many blocks and chunks, byte for byte', async () => {
    const path = join(tempDir(), 'big.zst')
    const data = Buffer.from(randomBytes(3_000_000).toString('hex'))
    writeFileSync(path, Buffer.concat([zstdCompressSync(data.subarray(0, 2_000_000)), zstdCompressSync(data.subarray(2_000_000))]))
    const parts: Buffer[] = []
    for await (const chunk of zstdChunks(path)) parts.push(Buffer.from(chunk))
    expect(Buffer.concat(parts).equals(data)).toBe(true)
  })

  it('names a truncated or malformed compressed file', async () => {
    const dir = tempDir()
    const whole = zstdCompressSync(Buffer.from(jsonl(conversation(20))))
    const truncated = join(dir, `truncated-${ROLLOUT}.zst`)
    writeFileSync(truncated, whole.subarray(0, whole.length - 3))
    await expect(readCodexSession(truncated)).rejects.toThrow(/truncated-rollout.*malformed or truncated zstd data/u)
    const garbage = join(dir, `garbage-${ROLLOUT}.zst`)
    writeFileSync(garbage, Buffer.from('not zstd at all'))
    await expect(readCodexSession(garbage)).rejects.toThrow(/garbage-rollout.*malformed or truncated/u)
  })

  it('holds one read chunk and one line at a time, plain or compressed, however large the rollout', async () => {
    const dir = tempDir()
    const path = join(dir, ROLLOUT)
    // About 20 MB, nearly all of it blobs no continued session can use. Holding the file (the old whole-file read)
    // would hold all of it at once.
    const fd = openSync(path, 'w')
    writeSync(fd, JSON.stringify(META) + '\n')
    const blob = JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Reasoning', blob: 'b'.repeat(450_000) } } }) + '\n'
    for (let i = 0; i < 45; i++) {
      writeSync(fd, blob)
      writeSync(fd, jsonl([say(`question ${i}`), reply(`answer ${i}`)]))
    }
    closeSync(fd)
    const size = statSync(path).size
    const compressed = `${path}.zst`
    writeFileSync(compressed, zstdCompressSync(readFileSync(path)))
    for (const file of [path, compressed]) {
      const { held, lines } = await mostHeld(file)
      expect(lines).toBe(1 + 45 * 3)
      // A chunk being split, and the start of the longest line carried over from the chunk before.
      expect(held, file).toBeLessThanOrEqual(READ_CHUNK_BYTES + blob.length)
      expect(held, file).toBeLessThan(size / 10)
    }
    expect((await readCodexSession(path)).session.turns).toHaveLength(45)
  })
})

describe('sessions above the ceiling', () => {
  const BIG = 300_000_000

  it('refuses a Codex rollout before reading it, naming its size', async () => {
    const path = join(tempDir(), ROLLOUT)
    sparse(path, jsonl([META, say('hello')]), BIG)
    const error: unknown = await importCodexSession(fakeHost().ctx, path).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(SessionTooLargeError)
    expect((error as Error).message).toBe(`This session is too large to import (300 MB; the limit is ${MAX_SESSION_BYTES / 1e6} MB).`)
  })

  it('refuses a Claude Code transcript before reading it', async () => {
    const dir = tempDir()
    const id = '11111111-2222-4333-8444-555555555555'
    const path = join(dir, `${id}.jsonl`)
    sparse(path, JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, sessionId: id, message: { role: 'user', content: 'hi' } }) + '\n', BIG)
    const host = fakeHost()
    await expect(importClaudeSession(host.ctx, path)).rejects.toThrow(/too large to import \(300 MB/u)
    expect(host.created).toEqual([])
  })

  it('refuses a compressed rollout as soon as what it decodes to is over the ceiling, holding none of it', async () => {
    const path = join(tempDir(), `${ROLLOUT}.zst`)
    // 12 frames of 10 MB of blank lines: a few KB on disk, 120 MB decoded.
    const frame = zstdCompressSync(Buffer.from(`${' '.repeat(999)}\n`.repeat(10_000)))
    writeFileSync(path, Buffer.concat(Array.from({ length: 12 }, () => frame)))
    await expect(readCodexSession(path)).rejects.toThrow(/over 100 MB once decompressed/u)
    let held = 0
    await expect((async () => { for await (const _ of rolloutLines(path, { held: (bytes) => { held = Math.max(held, bytes) } })) { /* read on */ } })()).rejects.toBeInstanceOf(SessionTooLargeError)
    expect(held).toBeLessThanOrEqual(READ_CHUNK_BYTES)
  })

  it('refuses an OpenCode session whose rows add up to more than the ceiling', async () => {
    const dir = tempDir()
    const path = join(dir, 'opencode.db')
    const db = new DatabaseSync(path)
    db.exec(`
      create table session (id text primary key, parent_id text, title text, directory text, time_created integer, time_updated integer);
      create table message (id text primary key, session_id text, time_created integer, data text);
      create table part (id text primary key, message_id text, session_id text, time_created integer, data text);
    `)
    db.prepare('insert into session values (?, null, ?, ?, 1, 2)').run('ses_big', 'Big', '/w')
    db.prepare('insert into session values (?, null, ?, ?, 1, 3)').run('ses_small', 'Small', '/w')
    db.prepare('insert into message values (?, ?, 1, ?)').run('m1', 'ses_big', JSON.stringify({ role: 'user', time: { created: 1 } }))
    db.prepare('insert into message values (?, ?, 1, ?)').run('m2', 'ses_small', JSON.stringify({ role: 'user', time: { created: 1 } }))
    db.prepare('insert into part values (?, ?, ?, 1, ?)').run('p1', 'm1', 'ses_big', JSON.stringify({ type: 'text', text: 'x'.repeat(MAX_SESSION_BYTES + 1) }))
    db.prepare('insert into part values (?, ?, ?, 1, ?)').run('p2', 'm2', 'ses_small', JSON.stringify({ type: 'text', text: 'hi' }))
    db.close()
    const found = (await discoverOpenCodeSessions(path)).sessions
    expect(found.map(item => [item.sourceId, item.bytes! > MAX_SESSION_BYTES])).toEqual([['ses_small', false], ['ses_big', true]])
    await expect(importOpenCodeSession(fakeHost().ctx, path, 'ses_big')).rejects.toThrow(/too large to import/u)
    expect((await importOpenCodeSession(fakeHost().ctx, path, 'ses_small')).turns).toBe(1)
    // It writes more than 100 MB into SQLite: slow on a busy machine or a slow disk.
  }, 60_000)
})

describe('the list marks sessions that are too large', () => {
  function api(): SessionsApi {
    let found: SessionsApi | undefined
    const ctx = { get: () => undefined } as unknown as Context
    startSessions(ctx, { provide: (_: string, value: SessionsApi) => { found = value; return () => {} } } as never)
    return found!
  }

  it('gives a Codex rollout its size and, above the ceiling, says it cannot be imported', async () => {
    const root = join(tempDir(), 'sessions')
    const folder = join(root, '2026', '11', '01')
    mkdirSync(folder, { recursive: true })
    const small = '01a00000-0000-7000-8000-000000000001'
    const big = '01a00000-0000-7000-8000-000000000002'
    const head = (id: string): string => jsonl([{ ...META, payload: { ...META.payload, id } }, say(`prompt ${id.slice(-1)}`)])
    writeFileSync(join(folder, `rollout-2026-11-01T00-00-00-${small}.jsonl`), head(small))
    sparse(join(folder, `rollout-2026-11-01T00-00-01-${big}.jsonl`), head(big), 463_000_000)
    const page = await api().sessions(root, 'codex')
    const rows = page.sessions as Array<{ sourceId: string; title?: string; bytes?: number; tooLarge?: boolean; limit?: number }>
    const byId = new Map(rows.map(row => [row.sourceId, row]))
    expect(byId.get(big)).toMatchObject({ title: 'prompt 2', bytes: 463_000_000, tooLarge: true, limit: MAX_SESSION_BYTES })
    expect(byId.get(small)!.tooLarge).toBeUndefined()
    expect(byId.get(small)!.bytes).toBeGreaterThan(0)
    expect((await discoverCodexSessions(root)).sessions.find(row => row.sourceId === big)!.bytes).toBe(463_000_000)
  })

  it('does the same for Claude Code transcripts', async () => {
    const root = tempDir()
    const dir = join(root, '-w')
    mkdirSync(dir)
    const id = '11111111-2222-4333-8444-555555555555'
    const line = JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, sessionId: id, cwd: '/w', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'hi' } }) + '\n'
    sparse(join(dir, `${id}.jsonl`), line, 120_000_000)
    const page = await api().sessions(root, 'claude-code')
    expect(page.sessions).toMatchObject([{ sourceId: id, bytes: 120_000_000, tooLarge: true, limit: MAX_SESSION_BYTES }])
    expect((await discoverClaudeSessions(root)).sessions[0]!.bytes).toBe(120_000_000)
  })
})
