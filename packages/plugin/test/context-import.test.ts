import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importGlobalClaudeContext } from '../src/context-import.ts'

test('global CLAUDE.md migrates with preview and never overwrites', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-context-'))
  const home = join(dir, 'dsh-home')
  const source = join(dir, 'CLAUDE.md')
  try {
    await writeFile(source, '# global rules\n')
    const preview = await importGlobalClaudeContext({ path: source, preview: true }, home)
    assert.equal(preview.status, 'preview')
    await assert.rejects(readFile(join(home, 'AGENTS.md')), /ENOENT/)

    const imported = await importGlobalClaudeContext({ path: source }, home)
    assert.equal(imported.status, 'imported')
    assert.equal(await readFile(join(home, 'AGENTS.md'), 'utf8'), '# global rules\n')

    const identical = await importGlobalClaudeContext({ path: source }, home)
    assert.equal(identical.status, 'skipped-identical')

    await writeFile(source, '# changed\n')
    const conflict = await importGlobalClaudeContext({ path: source }, home)
    assert.equal(conflict.status, 'skipped-conflict')
    assert.equal(await readFile(join(home, 'AGENTS.md'), 'utf8'), '# global rules\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('missing global CLAUDE.md reports skipped-missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-context-missing-'))
  try {
    await mkdir(join(dir, 'dsh-home'))
    const result = await importGlobalClaudeContext({ path: join(dir, 'absent.md') }, join(dir, 'dsh-home'))
    assert.equal(result.status, 'skipped-missing')
    assert.equal(result.targetPath, join(dir, 'dsh-home', 'AGENTS.md'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
