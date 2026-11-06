import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installStaged } from '../src/install.ts'
import { migrateDsh } from '../src/migrate.ts'
import { stagingRoot } from '../src/staging.ts'

const UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

function sessionRecords(): Record<string, unknown>[] {
  return [
    { type: 'session', version: 4, id: `session-${UUID}`, createdAt: 1000, cwd: '/tmp/project', isSeeded: false, delegationDepth: 0 },
    { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 1000, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 2, time: 1000, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } },
    {
      type: 'assistant/message',
      seq: 3,
      time: 1001,
      data: {
        turn: 1,
        step: 1,
        message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'hi' }], source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' } },
        stream: [],
      },
    },
    { type: 'step/end', seq: 4, time: 1001, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 5, time: 1001, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'session/title', seq: 6, time: 1001, data: { title: 'Greeting' } },
  ]
}

async function corpus(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh2claude-migrate-'))
  const sessions = join(root, 'sessions', 'workspace', UUID)
  await mkdir(sessions, { recursive: true })
  await writeFile(join(sessions, 'session.v4.jsonl'), sessionRecords().map((row) => JSON.stringify(row)).join('\n') + '\n')
  await mkdir(join(root, 'skills', 'reviewer'), { recursive: true })
  await writeFile(join(root, 'skills', 'reviewer', 'SKILL.md'), '---\nname: reviewer\ndescription: Reviews a diff\n---\n\nReview it.\n')
  await writeFile(join(root, 'AGENTS.md'), '# Global rules\n\nBe careful.\n')
  const profile = join(root, 'profiles', 'web')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: mcp-demo',
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '      config:',
    '        transport: stdio',
    '        serverName: demo',
    '        command: node',
    '        args: ["server.js"]',
    '        env: { TOKEN: x }',
    '',
  ].join('\n'))
  return root
}

test('stages a session plus skills, instructions and MCP, then installs them', async () => {
  const root = await corpus()
  try {
    const dshHome = root
    const report = await migrateDsh({ dshHome, skills: true, instructions: true, mcp: true })
    assert.equal(report.sessions.staged, 1)
    assert.equal(report.skills?.staged, 1)
    assert.equal(report.instructions?.staged, 1)
    assert.deepEqual(report.mcp?.servers, ['demo'])

    const staging = stagingRoot(dshHome)
    const manifest = JSON.parse(await readFile(join(staging, 'manifest.json'), 'utf8')) as { items: Array<{ kind: string; stagedPath: string; targetPath: string }> }
    const sessionItem = manifest.items.find((item) => item.kind === 'session')
    assert.ok(sessionItem !== undefined)
    assert.ok((await stat(join(staging, sessionItem.stagedPath))).isFile())
    assert.ok((await stat(join(staging, 'skills', 'reviewer', 'SKILL.md'))).isFile())
    assert.ok((await stat(join(staging, 'CLAUDE.md'))).isFile())
    const mcp = JSON.parse(await readFile(join(staging, 'mcp-servers.json'), 'utf8')) as { mcpServers: Record<string, unknown> }
    assert.deepEqual(mcp.mcpServers.demo, { type: 'stdio', command: 'node', args: ['server.js'], env: { TOKEN: 'x' } })

    const claudeHome = join(root, 'claude-home')
    const install = await installStaged({ dshHome, staging, claudeHome, dryRun: false })
    assert.equal(install.dryRun, false)
    assert.ok(install.installed >= 4, JSON.stringify(install.items))
    assert.ok((await stat(join(claudeHome, sessionItem.targetPath))).isFile())
    assert.ok((await stat(join(claudeHome, 'skills', 'reviewer', 'SKILL.md'))).isFile())
    assert.ok((await stat(join(claudeHome, 'CLAUDE.md'))).isFile())
    const userConfig = JSON.parse(await readFile(join(claudeHome, '.claude.json'), 'utf8')) as { mcpServers: Record<string, unknown> }
    assert.deepEqual(userConfig.mcpServers.demo, { type: 'stdio', command: 'node', args: ['server.js'], env: { TOKEN: 'x' } })

    const again = await installStaged({ dshHome, staging, claudeHome, dryRun: false })
    assert.equal(again.installed, 0)
    assert.equal(again.conflicts, 0)
    assert.ok(again.skippedIdentical >= 4)

    await writeFile(join(claudeHome, 'skills', 'reviewer', 'SKILL.md'), '---\nname: reviewer\ndescription: Different\n---\n')
    const conflict = await installStaged({ dshHome, staging, claudeHome, dryRun: false })
    assert.equal(conflict.conflicts, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('preview writes no transcript and no manifest', async () => {
  const root = await corpus()
  try {
    const report = await migrateDsh({ dshHome: root, preview: true, skills: true })
    assert.equal(report.preview, true)
    assert.equal(report.sessions.items[0]?.status, 'preview')
    await assert.rejects(stat(join(stagingRoot(root), 'manifest.json')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
