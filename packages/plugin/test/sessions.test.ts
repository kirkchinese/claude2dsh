import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { discoverClaudeSessions, importClaudeSession } from '../src/sessions/claude.js'

const temporary: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-forge-session-'))
  temporary.push(root)
  return root
}

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Claude session migration', () => {
  it('discovers and imports one transcript through sessionPersistence', async () => {
    const root = tempRoot()
    const sessionId = '11111111-2222-4333-8444-555555555555'
    const file = join(root, `${sessionId}.jsonl`)
    writeFileSync(file, [
      JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, sessionId, cwd: 'E:/demo', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'Hello' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] } }),
    ].join('\n'), 'utf8')
    const found = (await discoverClaudeSessions(root)).sessions
    expect(found).toHaveLength(1)
    let header: Record<string, unknown> | undefined
    let appended: readonly unknown[] | undefined
    const ctx = {
      get(name: string) {
        return name === 'sessionPersistence'
          ? {
              async create(value: Record<string, unknown>) {
                header = value
                return {
                  async append(events: readonly unknown[]) { appended = events },
                  async flush() {},
                  async close() {},
                }
              },
            }
          : undefined
      },
    }
    const report = await importClaudeSession(ctx as unknown as Context, file)
    expect(header?.['version']).toBe(4)
    expect(report.turns).toBe(1)
    expect(appended?.length).toBeGreaterThan(0)
  })

  it('refuses a transcript with no conversation to import instead of creating an empty session', async () => {
    const root = tempRoot()
    const sessionId = '11111111-2222-4333-8444-555555555555'
    // Renamed: Claude Code names a main transcript by its session id, so this one is not read as a main chain.
    const file = join(root, 'renamed.jsonl')
    writeFileSync(file, `${JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, sessionId, message: { role: 'user', content: 'Hello' } })}\n`, 'utf8')
    let created = false
    const ctx = { get: (name: string) => (name === 'sessionPersistence' ? { async create() { created = true; throw new Error('unexpected') } } : undefined) }
    await expect(importClaudeSession(ctx as unknown as Context, file)).rejects.toThrow(/nothing to import .*does not match source sessionId/u)
    expect(created).toBe(false)
  })
})
