import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importClaudeMemory } from '../src/memory-import.ts'

test('project memory becomes one DSH skill bundle with preview and conflict safety', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-memory-'))
  const project = join(dir, 'Drone_3D')
  const home = join(dir, 'dsh-home')
  try {
    await mkdir(join(project, 'memory'), { recursive: true })
    await writeFile(join(project, 'MEMORY.md'), '# project memory\n')
    await writeFile(join(project, 'memory', 'decisions.md'), '# decisions\n')

    const preview = await importClaudeMemory({ path: project, preview: true }, home)
    assert.equal(preview.status, 'preview')
    assert.equal(preview.files, 2)

    const imported = await importClaudeMemory({ path: project }, home)
    assert.equal(imported.status, 'imported')
    assert.equal(imported.skillName, 'claude-memory-drone-3d')
    const skill = join(home, 'skills', 'claude-memory-drone-3d', 'SKILL.md')
    assert.match(await readFile(skill, 'utf8'), /^---\nname: claude-memory-drone-3d/)
    assert.equal(await readFile(join(home, 'skills', 'claude-memory-drone-3d', 'memory', 'decisions.md'), 'utf8'), '# decisions\n')

    const identical = await importClaudeMemory({ path: project }, home)
    assert.equal(identical.status, 'skipped-identical')

    await writeFile(join(project, 'memory', 'decisions.md'), '# changed\n')
    const conflict = await importClaudeMemory({ path: project }, home)
    assert.equal(conflict.status, 'skipped-conflict')
    assert.equal(await readFile(join(home, 'skills', 'claude-memory-drone-3d', 'memory', 'decisions.md'), 'utf8'), '# decisions\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('projects without memory files are skipped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-memory-empty-'))
  try {
    const result = await importClaudeMemory({ path: dir }, join(dir, 'dsh-home'))
    assert.equal(result.status, 'skipped-missing')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
