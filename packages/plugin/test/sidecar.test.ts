import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NormalizedSession } from '@claude2dsh/core'
import { copySessionSidecars, findSidecarReferences, loadSidecarMap } from '../src/sidecar.ts'

function sessionWithText(text: string): NormalizedSession {
  return {
    id: 'session-1',
    createdAt: 0,
    turns: [{
      number: 1,
      prompt: 'go',
      timestamp: 0,
      steps: [{
        number: 1,
        content: [],
        toolCalls: [],
        toolResults: [{ toolCallId: 'call-1', content: [{ type: 'text', text }] }],
      }],
    }],
  } as unknown as NormalizedSession
}

test('copies referenced tool-result sidecars and persists the source/target map', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-sidecar-'))
  const home = join(dir, 'dsh-home')
  const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const sourcePath = join(dir, `${sessionId}.jsonl`)
  const sidecarDir = join(dir, sessionId, 'tool-results')
  try {
    await mkdir(sidecarDir, { recursive: true })
    await writeFile(join(sidecarDir, 'b37elc3ww.txt'), 'tool output\n')
    const session = sessionWithText('Full output saved to: /home/me/.claude/projects/p/session/tool-results/b37elc3ww.txt\npreview')

    const refs = findSidecarReferences(session, sourcePath)
    assert.equal(refs.length, 1)
    assert.equal(refs[0]?.filename, 'b37elc3ww.txt')

    const report = await copySessionSidecars(session, sourcePath, `claude-${sessionId}`, home)
    assert.equal(report.copied, 1)
    assert.equal(report.tooLarge, 0)
    const target = join(home, 'claude2dsh', 'sidecars', `claude-${sessionId}`, 'b37elc3ww.txt')
    assert.equal(await readFile(target, 'utf8'), 'tool output\n')
    const map = await loadSidecarMap(home)
    assert.equal(map.sessions[`claude-${sessionId}`]?.[0]?.status, 'copied')

    const rerun = await copySessionSidecars(session, sourcePath, `claude-${sessionId}`, home)
    assert.equal(rerun.reused, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('subagent source resolves the parent session tool-results directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-sidecar-subagent-'))
  const home = join(dir, 'dsh-home')
  const sessionId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
  const sourcePath = join(dir, sessionId, 'subagents', 'agent-1.jsonl')
  try {
    await mkdir(join(dir, sessionId, 'tool-results'), { recursive: true })
    await writeFile(join(dir, sessionId, 'tool-results', 'a.txt'), 'abc')
    const report = await copySessionSidecars(sessionWithText('/tmp/whatever/tool-results/a.txt'), sourcePath, `claude-${sessionId}`, home)
    assert.equal(report.copied, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('files over the configured cap are mapped but never copied', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c2dsh-sidecar-cap-'))
  const home = join(dir, 'dsh-home')
  const sessionId = 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa'
  const sourcePath = join(dir, `${sessionId}.jsonl`)
  try {
    await mkdir(join(dir, sessionId, 'tool-results'), { recursive: true })
    await writeFile(join(dir, sessionId, 'tool-results', 'big.txt'), Buffer.alloc(64))
    const report = await copySessionSidecars(sessionWithText('saved to tool-results/big.txt'), sourcePath, `claude-${sessionId}`, home, 16)
    assert.equal(report.tooLarge, 1)
    await assert.rejects(stat(join(home, 'claude2dsh', 'sidecars', `claude-${sessionId}`, 'big.txt')), /ENOENT/)
    const map = await loadSidecarMap(home)
    assert.equal(map.sessions[`claude-${sessionId}`]?.[0]?.status, 'too-large')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
