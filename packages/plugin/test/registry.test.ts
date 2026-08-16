import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRegistry, saveRegistryRecord } from '../src/registry.ts'

test('registry round-trips records under DSH_HOME/claude2dsh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-registry-'))
  const home = join(dir, 'dsh-home')
  try {
    const record = {
      adapter: 'claude-code',
      targetId: 'claude-abc',
      sourcePath: '/tmp/source.jsonl',
      turns: 3,
      events: 12,
      sourceSize: 99,
      sourceMtimeMs: 1234,
      importedAt: 5678,
    }
    await saveRegistryRecord(record, home)
    const loaded = await loadRegistry(home)
    assert.equal(loaded.version, 1)
    assert.deepEqual(loaded.imports['/tmp/source.jsonl'], record)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
