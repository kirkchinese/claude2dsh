import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAutoSyncState, pauseAutoSync, resumeAutoSync } from '../src/auto-sync-state.ts'

test('auto-sync state persists pause and conflict records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-autosync-state-'))
  const home = join(dir, 'dsh-home')
  try {
    const initial = await loadAutoSyncState(home)
    assert.equal(initial.paused, false)
    const paused = await pauseAutoSync(initial, 'conflict', {
      at: 123,
      kind: 'claude-to-dsh',
      sessionId: 's1',
      detail: 'both grew',
    }, home)
    assert.equal(paused.paused, true)
    assert.equal(paused.conflicts.length, 1)
    const loaded = await loadAutoSyncState(home)
    assert.equal(loaded.paused, true)
    assert.equal(loaded.conflicts[0]?.detail, 'both grew')
    const resumed = await resumeAutoSync(loaded, home)
    assert.equal(resumed.paused, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
