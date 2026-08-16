import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { activateAutoSync } from '../src/auto-sync.ts'
import { loadAutoSyncState } from '../src/auto-sync-state.ts'

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

test('watcher activation injects a double-side conflict and pauses without touching either side', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-autosync-activation-'))
  const home = join(dir, 'dsh-home')
  const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const sourcePath = join(dir, `${sessionId}.jsonl`)
  const sourceText = [
    { type: 'mode', mode: 'normal', sessionId },
    { type: 'user', uuid: 'u1', parentUuid: null, isSidechain: false, cwd: '/tmp/p', sessionId, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'hello' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', isSidechain: false, cwd: '/tmp/p', sessionId, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'hi' }] } },
  ].map((record) => JSON.stringify(record)).join('\n') + '\n'
  await mkdir(join(home, 'claude2dsh'), { recursive: true })
  await writeFile(join(home, 'claude2dsh', 'registry.json'), JSON.stringify({
    version: 1,
    imports: {
      [resolve(sourcePath)]: {
        adapter: 'claude-code',
        targetId: `claude-${sessionId}`,
        sourcePath: resolve(sourcePath),
        turns: 1,
        events: 2,
        sourceSize: -1,
        sourceMtimeMs: -1,
        prefixHash: 'stale',
        importedAt: 1,
      },
    },
    exports: {},
  }))

  let appended = 0
  let cleanup: (() => void) | undefined
  const mock = {
    effect(fn: () => () => void) {
      cleanup = fn()
      return () => cleanup?.()
    },
    on() {},
    sessionPersistence: {
      async list() { return [{ id: `claude-${sessionId}`, version: 0, createdAt: 0, delegationDepth: 0 }] },
      async readFrom() { return { meta: { id: `claude-${sessionId}`, version: 0, createdAt: 0, delegationDepth: 0 }, events: Array.from({ length: 5 }, (_, seq) => ({ seq })) } },
      async append() { appended += 1 },
      async create() { throw new Error('must not create') },
    },
  }

  try {
    activateAutoSync(mock as unknown as Context, { enabled: true, claudeProjectsRoot: dir, debounceMs: 100, dshToClaude: false }, { DSH_HOME: home })
    await sleep(300)
    await writeFile(sourcePath, sourceText)
    const deadline = Date.now() + 5000
    let state = await loadAutoSyncState(home)
    while (!state.paused && Date.now() < deadline) {
      await sleep(50)
      state = await loadAutoSyncState(home)
    }
    assert.equal(state.paused, true)
    assert.equal(state.conflicts.length, 1)
    assert.equal(state.conflicts[0]?.sessionId, `claude-${sessionId}`)
    assert.match(state.conflicts[0]?.detail ?? '', /both sides/)
    assert.equal(appended, 0)
    assert.equal(await readFile(sourcePath, 'utf8'), sourceText)
  } finally {
    cleanup?.()
    await sleep(50)
    await rm(dir, { recursive: true, force: true })
  }
})
