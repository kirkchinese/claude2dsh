import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inventoryClaudePlugins } from '../src/plugin-inventory.ts'

test('plugin inventory refuses path traversal in frontmatter skill names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-inventory-'))
  const root = join(dir, 'plugins')
  const cache = join(root, 'cache', 'demo', 'demo', '1.0.0')
  await mkdir(join(cache, 'skills', 'evil'), { recursive: true })
  await writeFile(join(root, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'demo@demo': [{ scope: 'user', installPath: cache, version: '1.0.0' }] } }))
  await writeFile(join(cache, 'skills', 'evil', 'SKILL.md'), '---\nname: ../../escape\ndescription: bad\n---\nbody\n')
  try {
    const result = await inventoryClaudePlugins({ path: root, apply: true }, join(dir, 'dsh-home'))
    assert.equal(result.migratedSkills, 0)
    assert.equal(result.dryRun, false)
    const escaped = join(dir, 'escape')
    await assert.rejects(readFile(join(escaped, 'SKILL.md')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
