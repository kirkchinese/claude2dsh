import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importClaudeSkills } from '../src/skills-import.ts'

test('copies dereferenced Claude skills into DSH_HOME/skills and skips identical content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-plugin-skills-'))
  const source = join(dir, 'source')
  const home = join(dir, 'dsh-home')
  await mkdir(join(source, 'memory-bridge'), { recursive: true })
  await writeFile(join(source, 'memory-bridge', 'SKILL.md'), '---\nname: memory-bridge\ndescription: Browse memory\n---\n# Body\n')
  await writeFile(join(source, 'README.md'), 'not a skill')
  try {
    const first = await importClaudeSkills(source, home)
    assert.equal(first.length, 1)
    assert.equal(first[0].status, 'imported')
    assert.equal(await readFile(join(home, 'skills', 'memory-bridge', 'SKILL.md'), 'utf8'), '---\nname: memory-bridge\ndescription: Browse memory\n---\n# Body\n')

    const second = await importClaudeSkills(source, home)
    assert.equal(second[0].status, 'skipped-identical')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reports conflicts without overwriting an existing DSH skill', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-plugin-skill-conflict-'))
  const source = join(dir, 'source')
  const home = join(dir, 'dsh-home')
  await mkdir(join(source, 'demo-skill'), { recursive: true })
  await mkdir(join(home, 'skills', 'demo-skill'), { recursive: true })
  await writeFile(join(source, 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: new\n---\n')
  await writeFile(join(home, 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: existing\n---\n')
  try {
    const result = await importClaudeSkills(source, home)
    assert.equal(result[0].status, 'skipped-conflict')
    assert.equal(await readFile(join(home, 'skills', 'demo-skill', 'SKILL.md'), 'utf8'), '---\nname: demo-skill\ndescription: existing\n---\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
