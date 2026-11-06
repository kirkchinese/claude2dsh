#!/usr/bin/env node
// End-to-end DSH -> Claude Code migration against a synthetic $DSH_HOME.
//
// Proves the committed build: a concatenated-zstd v4 session plus skills,
// AGENTS.md and an MCP profile row migrate to staging, then install into a
// temporary Claude home as a valid JSONL chain.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { discoverDshSessions, readDshSession } from '../packages/adapters/dsh/lib/index.js'
import { renderClaudeTranscript, verifyClaudeJsonl } from '../packages/adapters/claude-code/lib/index.js'
import { installStaged } from '../packages/plugin/lib/install.js'
import { migrateDsh } from '../packages/plugin/lib/migrate.js'
import { stagingRoot } from '../packages/plugin/lib/staging.js'

const UUID = '11111111-2222-4333-8444-555555555555'
const SESSION_ID = `session-${UUID}`

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'dsh2claude-e2e-'))
  try {
    const sessionDir = join(root, 'sessions', '--tmp-demo--', UUID)
    await mkdir(sessionDir, { recursive: true })
    const records = [
      { type: 'session', version: 4, id: SESSION_ID, createdAt: 1000, cwd: '/tmp/demo', isSeeded: false, delegationDepth: 0 },
      { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 1000, data: { turn: 1, step: 1 } },
      { type: 'user/message', seq: 2, time: 1000, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'list the directory' }], source: { kind: 'user' } } },
      {
        type: 'assistant/message',
        seq: 3,
        time: 1001,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'a1',
            role: 'assistant',
            content: [
              { type: 'text', text: 'I will list it.' },
              { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' },
            ],
            source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' },
          },
          stream: [],
        },
      },
      { type: 'tool/call', seq: 4, time: 1001, data: { turn: 1, step: 1, callId: 'call_1', name: 'bash', arguments: '{"command":"ls"}' } },
      { type: 'tool/result', seq: 5, time: 1002, data: { turn: 1, step: 1, message: { id: 'r1', role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'README.md' }], isError: false, source: { kind: 'tool', callId: 'call_1' } } } },
      { type: 'step/end', seq: 6, time: 1002, data: { turn: 1, step: 1 } },
      { type: 'session/title', seq: 7, time: 1002, data: { title: 'List the directory' } },
      { type: 'turn/end', seq: 8, time: 1002, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const headerFrame = zstdCompressSync(Buffer.from(`${JSON.stringify(records[0])}\n`))
    const eventFrame = zstdCompressSync(Buffer.from(`${records.slice(1).map((row) => JSON.stringify(row)).join('\n')}\n`))
    await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), Buffer.concat([headerFrame, eventFrame]))

    await mkdir(join(root, 'skills', 'reviewer'), { recursive: true })
    await writeFile(join(root, 'skills', 'reviewer', 'SKILL.md'), '---\nname: reviewer\ndescription: Reviews a diff\n---\n\nReview it.\n')
    await writeFile(join(root, 'AGENTS.md'), '# Global rules\n\nBe careful.\n')
    await mkdir(join(root, 'profiles', 'web'), { recursive: true })
    await writeFile(join(root, 'profiles', 'web', 'cordis.patch.yml'), [
      '- insert:',
      '    - id: mcp-demo',
      '      name: "@deepseek-ai/dsh-mcp-client"',
      '      config:',
      '        transport: stdio',
      '        serverName: demo',
      '        command: node',
      '        args: ["server.js"]',
      '',
    ].join('\n'))

    const discovered = []
    for await (const item of discoverDshSessions(join(root, 'sessions'))) discovered.push(item)
    assert.equal(discovered.length, 1)
    assert.equal(discovered[0].version, 4)
    const read = await readDshSession(discovered[0])
    assert.equal(read.view.events.filter((event) => event.type === 'tool/result').length, 1)
    const rendered = renderClaudeTranscript(read.view, discovered[0].dshId)
    assert.equal(verifyClaudeJsonl(rendered.jsonl), true)

    const staged = await migrateDsh({ dshHome: root, skills: true, instructions: true, mcp: true })
    assert.equal(staged.sessions.staged, 1)
    assert.equal(staged.skills?.staged, 1)
    assert.equal(staged.instructions?.staged, 1)
    assert.deepEqual(staged.mcp?.servers, ['demo'])

    const claudeHome = join(root, 'claude-home')
    const installed = await installStaged({ dshHome: root, staging: stagingRoot(root), claudeHome, dryRun: false })
    assert.ok(installed.installed >= 4, JSON.stringify(installed.items))
    const installedTranscript = join(claudeHome, 'projects', '-tmp-demo', `${UUID}.jsonl`)
    assert.ok((await stat(installedTranscript)).isFile())
    assert.equal(verifyClaudeJsonl(await readFile(installedTranscript, 'utf8')), true)
    const config = JSON.parse(await readFile(join(claudeHome, '.claude.json'), 'utf8'))
    assert.equal(config.mcpServers.demo.command, 'node')

    console.log(`E2E_OK session=${UUID} records=${rendered.recordCount} installed=${installed.installed}`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
