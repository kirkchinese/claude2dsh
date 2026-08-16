import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateHookConfig } from '../src/hook-bridge.ts'

test('hook bridge validation fails loud for malformed JSON with the path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-hooks-'))
  const file = join(dir, 'hooks.json')
  await writeFile(file, '{bad json')
  try {
    assert.throws(() => validateHookConfig(file), /invalid JSON in .*hooks\.json/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('hook bridge validation accepts a hooks object', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-hooks-ok-'))
  const file = join(dir, 'hooks.json')
  await writeFile(file, '{"hooks":{"SessionStart":[]}}')
  try {
    assert.doesNotThrow(() => validateHookConfig(file))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
