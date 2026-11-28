/**
 * A transcript above the import ceiling is refused before a byte of it is read: every way a reader opens a file is
 * recorded, and the refused file is in none of them.
 */
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionTooLargeError } from '@kirkchinese/harness-forge-core'
import { importCodexSession } from '../src/sessions/codex.js'
import { importClaudeSession } from '../src/sessions/claude.js'

/** The paths opened for reading their contents, by any reader. */
const reads = vi.hoisted(() => [] as string[])

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  const record = <A extends unknown[], R>(read: (path: never, ...rest: A) => R) => (path: never, ...rest: A): R => {
    reads.push(String(path))
    return read(path, ...rest)
  }
  const wrapped = {
    ...fs,
    createReadStream: record(fs.createReadStream as never),
    readFileSync: record(fs.readFileSync as never),
    openSync: record(fs.openSync as never),
  }
  return { ...wrapped, default: wrapped }
})

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  const record = <A extends unknown[], R>(read: (path: never, ...rest: A) => R) => (path: never, ...rest: A): R => {
    reads.push(String(path))
    return read(path, ...rest)
  }
  const wrapped = { ...fs, open: record(fs.open as never), readFile: record(fs.readFile as never) }
  return { ...wrapped, default: wrapped }
})

const temporary: string[] = []
afterEach(() => {
  reads.length = 0
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-forge-reads-'))
  temporary.push(dir)
  return dir
}

/** A file that claims 300 MB and holds only `head`. */
function sparse(path: string, head: string): void {
  writeFileSync(path, head)
  truncateSync(path, 300_000_000)
}

function persistenceHost(): Context {
  const persistence = { async list() { return [] }, async create() { throw new Error('nothing is to be written') } }
  return { get: (name: string) => (name === 'sessionPersistence' ? persistence : undefined) } as unknown as Context
}

describe('a transcript above the ceiling', () => {
  it('is refused before it is read: a Codex rollout', async () => {
    const path = join(tempDir(), 'rollout-2026-11-01T00-00-00-01a00000-0000-7000-8000-00000000beef.jsonl')
    sparse(path, JSON.stringify({ type: 'session_meta', payload: { id: 'beef', cwd: '/w' } }) + '\n')
    // The recorder sees reads: a small file is read through it.
    const small = join(tempDir(), 'rollout-small.jsonl')
    writeFileSync(small, JSON.stringify({ type: 'session_meta', payload: { id: 'small', cwd: '/w' } }) + '\n')
    await importCodexSession(persistenceHost(), small).catch(() => undefined)
    expect(reads).toContain(small)
    await expect(importCodexSession(persistenceHost(), path)).rejects.toBeInstanceOf(SessionTooLargeError)
    expect(reads).not.toContain(path)
  })

  it('is refused before it is read: a Claude Code transcript', async () => {
    const id = '11111111-2222-4333-8444-555555555555'
    const path = join(tempDir(), `${id}.jsonl`)
    sparse(path, JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, sessionId: id, message: { role: 'user', content: 'hi' } }) + '\n')
    await expect(importClaudeSession(persistenceHost(), path)).rejects.toBeInstanceOf(SessionTooLargeError)
    expect(reads).not.toContain(path)
  })
})
