import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverClaudeHooks } from '../src/hook-discovery.ts'

test('discovers command hooks from settings and plugin hooks.json, reports unsupported types', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-hook-scan-'))
  const plugin = join(dir, 'plugins', 'p1')
  try {
    await mkdir(plugin, { recursive: true })
    await writeFile(join(dir, 'settings.json'), JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo settings' }] }],
      },
    }))
    await writeFile(join(plugin, 'hooks.json'), JSON.stringify({
      PostToolUse: [
        { hooks: [{ type: 'command', command: 'echo plugin' }, { type: 'prompt', prompt: 'ignored' }] },
      ],
      UnknownEvent: [{ hooks: [{ type: 'command', command: 'ignored' }] }],
    }))
    const report = await discoverClaudeHooks({ configDir: dir, pluginRoot: join(dir, 'plugins') })
    assert.equal(report.scannedFiles, 2)
    assert.equal(report.supportedCommands, 2)
    assert.equal(report.skipped, 1)
    assert.equal(report.config.PreToolUse?.[0]?.hooks[0]?.command, 'echo settings')
    assert.equal(report.config.PostToolUse?.[0]?.hooks[0]?.command, 'echo plugin')
    assert.equal(report.config.PostToolUse?.[0]?.hooks.length, 1)
    assert.equal(report.config.UnknownEvent, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('empty and invalid candidates degrade to a preview report', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-hook-empty-'))
  try {
    const empty = await discoverClaudeHooks({ configDir: dir, pluginRoot: join(dir, 'plugins') })
    assert.equal(empty.scannedFiles, 0)
    assert.equal(empty.supportedCommands, 0)
    await writeFile(join(dir, 'settings.json'), '{ bad json')
    const invalid = await discoverClaudeHooks({ configDir: dir, pluginRoot: join(dir, 'plugins') })
    assert.equal(invalid.scannedFiles, 1)
    assert.equal(invalid.skipped, 1)
    assert.match(invalid.entries[0]?.reason ?? '', /invalid JSON/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
