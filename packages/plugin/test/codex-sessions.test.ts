import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultCodexSessionsRoot, discoverCodexSessions, importCodexSession, readCodexSession } from '../src/sessions/codex.js'

const fixture = join(process.cwd(), 'test', 'fixtures', 'codex-rollout.jsonl')
const temporary: string[] = []
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fake home whose `.codex/sessions/2026/01/02` holds the fixture rollout, laid out the way Codex stores them. */
function codexHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'harness-forge-codex-home-'))
  temporary.push(home)
  const day = join(defaultCodexSessionsRoot(home), '2026', '01', '02')
  mkdirSync(day, { recursive: true })
  copyFileSync(fixture, join(day, 'rollout-2026-01-02T03-04-05-fixture.jsonl'))
  return home
}

describe('Codex rollout migration', () => {
  it('discovers, normalizes and imports a rollout from the Codex sessions folder', async () => {
    const root = defaultCodexSessionsRoot(codexHome())
    const { sessions } = await discoverCodexSessions(root, { limit: 1 })
    expect(sessions.length).toBeGreaterThan(0)
    const parsed = await readCodexSession(sessions[0]!.path)
    expect(parsed.session.source.tool).toBe('codex')
    expect(parsed.session.turns.length).toBeGreaterThan(0)
    expect(parsed.session.turns.some(turn => turn.steps.length > 0)).toBe(true)

    let header: Record<string, unknown> | undefined
    let events: unknown[] = []
    const ctx = {
      get(name: string) {
        if (name !== 'sessionPersistence') return undefined
        return {
          async create(value: Record<string, unknown>) {
            header = value
            return {
              async append(next: readonly unknown[]) { events = [...next] },
              async flush() {},
              async close() {},
            }
          },
        }
      },
    }
    const report = await importCodexSession(ctx as never, sessions[0]!.path)
    expect(header?.['version']).toBe(4)
    expect(report.events).toBe(events.length)
    expect(report.turns).toBeGreaterThan(0)
  })

  it('lifts tool results to the v4 tool role', async () => {
    let events: Array<{ type?: string; data?: { message?: Record<string, unknown> } }> = []
    const ctx = {
      get(name: string) {
        if (name !== 'sessionPersistence') return undefined
        return {
          async create() {
            return {
              async append(next: readonly unknown[]) { events = next as never },
              async flush() {},
              async close() {},
            }
          },
        }
      },
    }
    await importCodexSession(ctx as never, fixture, { targetId: 'codex-fixture' })
    const result = events.find(event => event.type === 'tool/result')
    expect(result?.data?.message).toMatchObject({ role: 'tool', toolCallId: 'call-1' })
    expect((result?.data?.message as { content?: unknown[] })?.content).not.toContainEqual(expect.objectContaining({ type: 'tool-result' }))
  })
})
