import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importClaudeAgents, importClaudeCommands, importClaudeMcpServers } from '../src/assets-import.ts'

async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'c2dsh-assets-'))
}

test('translates a subagent definition into a skill that records its Claude origin', async () => {
  const dir = await scratch()
  const home = join(dir, 'dsh-home')
  const agents = join(dir, 'agents')
  await mkdir(agents, { recursive: true })
  await writeFile(join(agents, 'reviewer.md'), [
    '---',
    'name: reviewer',
    'description: Reviews a diff for correctness',
    'tools: Read, Bash',
    'model: sonnet',
    '---',
    '',
    'You review diffs.',
    '',
  ].join('\n'))
  try {
    const report = await importClaudeAgents({ path: agents }, home)
    assert.equal(report.imported, 1)
    assert.equal(report.items[0].target, 'cc-agent-reviewer')
    const written = await readFile(join(home, 'skills', 'cc-agent-reviewer', 'SKILL.md'), 'utf8')
    assert.match(written, /^---\nname: cc-agent-reviewer\n/)
    assert.match(written, /description: "Reviews a diff for correctness"/)
    assert.match(written, /source: claude-code-agent/)
    assert.match(written, /originalName: reviewer/)
    assert.match(written, /delegated subagent on model sonnet/)
    assert.match(written, /You review diffs\./)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a second identical agent import is skipped and different content is a conflict', async () => {
  const dir = await scratch()
  const home = join(dir, 'dsh-home')
  const agents = join(dir, 'agents')
  await mkdir(agents, { recursive: true })
  const source = join(agents, 'helper.md')
  await writeFile(source, '---\nname: helper\ndescription: Helps\n---\n\nBody.\n')
  try {
    const first = await importClaudeAgents({ path: agents }, home)
    assert.equal(first.imported, 1)
    const again = await importClaudeAgents({ path: agents }, home)
    assert.equal(again.skippedIdentical, 1)
    await writeFile(source, '---\nname: helper\ndescription: Helps\n---\n\nChanged body.\n')
    const changed = await importClaudeAgents({ path: agents }, home)
    assert.equal(changed.skippedConflict, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('translates a namespaced slash command into a user-invocable skill', async () => {
  const dir = await scratch()
  const home = join(dir, 'dsh-home')
  const commands = join(dir, 'commands', 'git')
  await mkdir(commands, { recursive: true })
  await writeFile(join(commands, 'commit.md'), [
    '---',
    'description: Commit staged changes',
    'argument-hint: "[message]"',
    'allowed-tools: Bash(git commit:*)',
    '---',
    '',
    'Create a commit.',
    '',
  ].join('\n'))
  try {
    const report = await importClaudeCommands({ path: join(dir, 'commands') }, home)
    assert.equal(report.imported, 1)
    assert.equal(report.items[0].target, 'cc-cmd-git-commit')
    const written = await readFile(join(home, 'skills', 'cc-cmd-git-commit', 'SKILL.md'), 'utf8')
    // A slash command is human-invoked, so the translation must stay out of the model catalog.
    assert.match(written, /disable-model-invocation: true/)
    assert.match(written, /source: claude-code-command/)
    assert.match(written, /originalName: git:commit/)
    assert.match(written, /argumentHint: "\[message\]"/)
    assert.match(written, /Create a commit\./)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('translates stdio and HTTP MCP servers and reports SSE as unsupported', async () => {
  const dir = await scratch()
  const home = join(dir, 'dsh-home')
  const config = join(dir, '.claude.json')
  await writeFile(config, JSON.stringify({
    mcpServers: {
      memory: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], env: { TOKEN: 'x' } },
      docs: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer t' } },
      legacy: { type: 'sse', url: 'https://example.test/sse' },
    },
    projects: { '/tmp/proj': { mcpServers: { local: { command: 'node', args: ['server.js'] } } } },
  }))
  try {
    const report = await importClaudeMcpServers({ path: config }, home)
    assert.equal(report.servers, 4)
    assert.equal(report.supported, 3)
    assert.equal(report.unsupported, 1)
    const sse = report.items.find((item) => item.server === 'legacy')
    assert.equal(sse?.status, 'unsupported')
    assert.match(sse?.reason ?? '', /SSE/)
    // Dry-run writes nothing.
    assert.equal(report.patchPath, undefined)

    const applied = await importClaudeMcpServers({ path: config, apply: true }, home)
    assert.ok(applied.patchPath?.endsWith('mcp.patch.yml'))
    assert.match(applied.applyCommand ?? '', /--patch/)
    const layer = await readFile(applied.patchPath as string, 'utf8')
    assert.match(layer, /name: "?@deepseek-ai\/dsh-mcp-client"?/)
    assert.match(layer, /transport: stdio/)
    assert.match(layer, /serverName: memory/)
    assert.match(layer, /transport: streamable-http/)
    assert.match(layer, /cwd: \/tmp\/proj/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('two MCP servers claiming one namespace report a collision instead of an unbootable layer', async () => {
  const dir = await scratch()
  const home = join(dir, 'dsh-home')
  const config = join(dir, '.claude.json')
  await writeFile(config, JSON.stringify({
    mcpServers: {
      'docs.v1': { command: 'node', args: ['a.js'] },
      'docs-v1': { command: 'node', args: ['b.js'] },
    },
  }))
  try {
    const report = await importClaudeMcpServers({ path: config, apply: true }, home)
    assert.equal(report.supported, 1)
    assert.equal(report.unsupported, 1)
    assert.match(report.items.find((item) => item.status === 'unsupported')?.reason ?? '', /already claimed/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a missing Claude configuration is reported as zero servers, not an error', async () => {
  const dir = await scratch()
  try {
    const report = await importClaudeMcpServers({ path: join(dir, 'absent.json') }, join(dir, 'home'))
    assert.equal(report.servers, 0)
    assert.equal(report.scannedFiles.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
