import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverClaudeSkills, parseSkillFrontmatter } from '../src/skills.ts'

test('parses folded YAML frontmatter and validates name/description', () => {
  const meta = parseSkillFrontmatter(`---
name: memory-bridge
description: >
  A folded
  description
allowed-tools:
  - Bash
---
# body
`)
  assert.equal(meta.name, 'memory-bridge')
  assert.equal(String(meta.description).trim(), 'A folded description')
})

test('discovers symlinked directory bundles and collects real files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-skills-'))
  const real = join(dir, 'real')
  const root = join(dir, 'root')
  await mkdir(join(real, 'memory-bridge'), { recursive: true })
  await mkdir(join(real, 'memory-bridge', 'assets'), { recursive: true })
  await writeFile(join(real, 'memory-bridge', 'SKILL.md'), '---\nname: memory-bridge\ndescription: Browse memory\n---\n# Memory Bridge\n')
  await writeFile(join(real, 'memory-bridge', 'assets', 'x.txt'), 'resource', { flag: 'wx' }).catch(() => {})
  await mkdir(root)
  await symlink(join(real, 'memory-bridge'), join(root, 'memory-bridge'), 'dir')
  await writeFile(join(root, 'README.md'), 'not a skill')
  try {
    const skills = await discoverClaudeSkills(root)
    assert.equal(skills.length, 1)
    assert.equal(skills[0].name, 'memory-bridge')
    assert.equal(skills[0].description, 'Browse memory')
    assert.ok(skills[0].files.some((file) => file.relPath === 'SKILL.md'))
    assert.ok(skills[0].files.some((file) => file.relPath === join('assets', 'x.txt')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('skips skills without a kebab-case name or description', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-skills-invalid-'))
  await mkdir(join(dir, 'Bad_Name'))
  await writeFile(join(dir, 'Bad_Name', 'SKILL.md'), '---\nname: Bad_Name\ndescription: x\n---\n')
  await mkdir(join(dir, 'no-desc'))
  await writeFile(join(dir, 'no-desc', 'SKILL.md'), '---\nname: no-desc\ndescription:\n---\n')
  try {
    const skills = await discoverClaudeSkills(dir)
    assert.equal(skills.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
