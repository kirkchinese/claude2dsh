import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileSettingsScope, defaultClaude2dshSettings, mergeSettingsPatch } from '../src/settings-service.ts'

test('file settings scope layers the stored document over the config base and persists updates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-settings-'))
  const path = join(dir, 'claude2dsh', 'settings.json')
  try {
    const base = defaultClaude2dshSettings()
    const scope = createFileSettingsScope(base, path)
    assert.deepEqual(scope.get(), base)
    const seen: boolean[] = []
    const stop = scope.watch((next) => seen.push(next.autoSync.enabled))
    await scope.update({ autoSync: { enabled: true }, ui: { language: 'en' } })
    assert.equal(scope.get().autoSync.enabled, true)
    assert.equal(scope.get().autoSync.debounceMs, 500)
    assert.equal(scope.get().ui.language, 'en')
    assert.deepEqual(seen, [true])
    stop()
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { autoSync: { enabled: true }, ui: { language: 'en' } })
    const reopened = createFileSettingsScope(base, path)
    assert.equal(reopened.get().autoSync.enabled, true)
    assert.equal(reopened.get().ui.language, 'en')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('file settings scope refuses invalid updates and ignores a corrupt document', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-settings-bad-'))
  const path = join(dir, 'settings.json')
  try {
    await writeFile(path, '{not json')
    const scope = createFileSettingsScope(defaultClaude2dshSettings(), path)
    assert.equal(scope.get().autoSync.enabled, false)
    await assert.rejects(scope.update({ importDefaults: { imageMode: 'bogus' } }))
    assert.equal(scope.get().importDefaults.imageMode, 'auto')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('settings patches merge objects recursively and never touch prototypes', () => {
  assert.deepEqual(mergeSettingsPatch({ a: { b: 1, c: 2 } }, { a: { c: 3 } }), { a: { b: 1, c: 3 } })
  const merged = mergeSettingsPatch({}, JSON.parse('{"__proto__": {"polluted": true}}')) as Record<string, unknown>
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
  assert.equal(Object.hasOwn(merged, '__proto__'), false)
})
