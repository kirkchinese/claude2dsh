import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { codexMcpComponents, codexRules, scanCodexProjectAssets, scanCodexUserAssets } from '../src/index.js'

const temporary: string[] = []
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-forge-codex-'))
  temporary.push(dir)
  return dir
}

describe('Codex user assets', () => {
  it('reads skills (with openai.yaml), prompts, MCP servers, rules, notify and AGENTS.md from ~/.codex', () => {
    const dir = home()
    const codex = join(dir, '.codex')
    mkdirSync(join(codex, 'skills', 'release', 'agents'), { recursive: true })
    mkdirSync(join(codex, 'skills', '.system', 'builtin'), { recursive: true })
    mkdirSync(join(codex, 'prompts'), { recursive: true })
    mkdirSync(join(codex, 'rules'), { recursive: true })
    writeFileSync(join(codex, 'skills', 'release', 'SKILL.md'), '---\nname: release\n---\nCut a release.\n')
    writeFileSync(join(codex, 'skills', 'release', 'agents', 'openai.yaml'), 'interface:\n  short_description: "Cut a release"\npolicy:\n  allow_implicit_invocation: false\n')
    writeFileSync(join(codex, 'skills', '.system', 'builtin', 'SKILL.md'), '---\nname: builtin\ndescription: Codex own\n---\nx\n')
    writeFileSync(join(codex, 'prompts', 'review.md'), '---\ndescription: Review a file\n---\nReview $FILE against $1\n')
    writeFileSync(join(codex, 'rules', 'default.rules'), 'prefix_rule(pattern=["git", ["push", "fetch"]], decision="prompt")\nprefix_rule(pattern=["rm", "-rf"], decision="forbidden")\nprefix_rule(pattern=["pwd"], decision="allow")\n')
    writeFileSync(join(codex, 'config.toml'), [
      'notify = ["notify-send", "Codex"]',
      '[mcp_servers.docs]',
      'url = "https://example.com/mcp"',
      'bearer_token_env_var = "DOCS_TOKEN"',
      '[mcp_servers.local]',
      'command = "node"',
      'args = ["server.js"]',
      'env_vars = ["HOME"]',
      '[mcp_servers.local.env]',
      'MODE = "dev"',
      '[mcp_servers.off]',
      'command = "x"',
      'enabled = false',
    ].join('\n'))
    writeFileSync(join(codex, 'AGENTS.md'), 'Always answer in English.\n')

    const plugin = scanCodexUserAssets(dir)
    expect(plugin?.manifest?.['scope']).toBe('user')
    const byName = new Map(plugin?.components.map(component => [`${component.kind}:${component.name}`, component]))
    expect(byName.has('skill:builtin')).toBe(false)
    expect(byName.get('skill:release')).toMatchObject({ description: 'Cut a release', frontmatter: { modelInvocable: false } })
    expect(byName.get('command:review')).toMatchObject({ invocationName: 'prompts:review', syntax: 'codex', description: 'Review a file' })
    expect(byName.get('mcp:docs')).toMatchObject({ transport: 'streamable-http', headers: { Authorization: 'Bearer ${DOCS_TOKEN}' } })
    expect(byName.get('mcp:local')).toMatchObject({ transport: 'stdio', command: 'node', args: ['server.js'], env: { HOME: '${HOME}', MODE: 'dev' } })
    expect(byName.has('mcp:off')).toBe(false)
    expect(byName.get('settings:rules')).toMatchObject({ permissions: { allow: ['Bash(pwd:*)'], ask: ['Bash(git push:*)', 'Bash(git fetch:*)'], deny: ['Bash(rm -rf:*)'] } })
    expect(byName.get('other:notify')).toMatchObject({ originalKind: 'codex-notify' })
    expect(byName.get('other:agents-md')).toMatchObject({ originalKind: 'codex-instructions', path: 'AGENTS.md' })
  })

  it('expands rule alternatives and leaves out rules it cannot read', () => {
    const dir = home()
    writeFileSync(join(dir, 'a.rules'), 'prefix_rule(pattern=[["npm", "pnpm"], "test"], decision="allow")\nprefix_rule(decision="allow")\n')
    expect(codexRules(dir).allow).toEqual(['Bash(npm test:*)', 'Bash(pnpm test:*)'])
  })

  it('reads agent roles from agents/*.toml and [agents.<name>] with config_file', () => {
    const dir = home()
    const codex = join(dir, '.codex')
    mkdirSync(join(codex, 'agents'), { recursive: true })
    writeFileSync(join(codex, 'agents', 'reviewer.toml'), 'name = "reviewer"\ndescription = "Reviews diffs"\nmodel_reasoning_effort = "high"\nsandbox_mode = "read-only"\ndeveloper_instructions = """Review the diff."""\n')
    writeFileSync(join(codex, 'roles-tester.toml'), 'model = "gpt-5.1-codex"\ndeveloper_instructions = "Write tests."\n')
    writeFileSync(join(codex, 'config.toml'), '[agents.tester]\ndescription = "Writes tests"\nconfig_file = "roles-tester.toml"\n')
    const agents = scanCodexUserAssets(dir)?.components.filter(component => component.kind === 'agent')
    expect(agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'reviewer', description: 'Reviews diffs', body: 'Review the diff.', frontmatter: expect.objectContaining({ effort: 'high', permissionMode: 'plan' }) }),
      expect.objectContaining({ name: 'tester', description: 'Writes tests', body: 'Write tests.', frontmatter: expect.objectContaining({ model: 'gpt-5.1-codex' }) }),
    ]))
  })

  it('reads a project\'s .codex/ from the repository root down to the session directory', () => {
    const dir = home()
    const repo = join(dir, 'repo')
    const sub = join(repo, 'pkg')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, '.codex', 'agents'), { recursive: true })
    mkdirSync(join(sub, '.codex'), { recursive: true })
    writeFileSync(join(repo, '.codex', 'config.toml'), '[mcp_servers.shared]\ncommand = "a"\n[mcp_servers.base]\ncommand = "b"\n')
    writeFileSync(join(sub, '.codex', 'config.toml'), '[mcp_servers.shared]\ncommand = "nearer"\n')
    writeFileSync(join(repo, '.codex', 'agents', 'scout.toml'), 'name = "scout"\ndescription = "Looks around"\ndeveloper_instructions = "Look."\n')
    const plugin = scanCodexProjectAssets(sub, dir)
    expect(plugin?.manifest?.['scope']).toBe('project')
    const byName = new Map(plugin?.components.map(component => [`${component.kind}:${component.name}`, component]))
    expect(byName.get('mcp:shared')).toMatchObject({ command: 'nearer' })
    expect(byName.get('mcp:base')).toMatchObject({ command: 'b' })
    expect(byName.get('agent:scout')).toMatchObject({ body: 'Look.' })
    expect(scanCodexProjectAssets(join(dir, 'elsewhere'), dir)).toBeUndefined()
  })

  it('maps env_http_headers to variables expanded at start', () => {
    const [server] = codexMcpComponents('codex:user', { api: { url: 'https://x', http_headers: { 'X-A': '1' }, env_http_headers: { 'X-Key': 'API_KEY' } } })
    expect(server?.headers).toEqual({ 'X-A': '1', 'X-Key': '${API_KEY}' })
  })
})
