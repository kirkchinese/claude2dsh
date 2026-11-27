import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ruleVerdict, type PermissionRuleSet } from '../src/hooks/permissions.js'
import { foreignTool } from '../src/hooks/vocabulary.js'

const cwd = process.platform === 'win32' ? 'C:\\work\\repo' : '/work/repo'
const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
const context = { cwd, agentName: () => undefined, presetOf: () => undefined }

function rules(partial: Partial<PermissionRuleSet>): PermissionRuleSet {
  return { allow: [], deny: [], ask: [], ...partial }
}

function bash(command: string): ReturnType<typeof foreignTool> {
  return foreignTool('claude-code', shell, { command }, context)
}

describe('permission rules', () => {
  it('evaluates deny, then ask, then allow, whatever the specificity', () => {
    const set = rules({ allow: ['Bash(aws s3 ls)'], deny: ['Bash(aws *)'] })
    expect(ruleVerdict(set, bash('aws s3 ls'), cwd)).toEqual({ kind: 'deny', rule: 'Bash(aws *)' })
    const asking = rules({ allow: ['Bash(git push origin main)'], ask: ['Bash(git push *)'] })
    expect(ruleVerdict(asking, bash('git push origin main'), cwd)?.kind).toBe('ask')
  })

  it('matches the documented Bash wildcard rows', () => {
    const allowed = (rule: string, command: string): boolean => ruleVerdict(rules({ allow: [rule] }), bash(command), cwd)?.kind === 'allow'
    expect(allowed('Bash(npm run build)', 'npm run build')).toBe(true)
    expect(allowed('Bash(npm run build)', 'npm run build --watch')).toBe(false)
    expect(allowed('Bash(npm run *)', 'npm run')).toBe(true)
    expect(allowed('Bash(npm run *)', 'npm install')).toBe(false)
    expect(allowed('Bash(ls *)', 'ls')).toBe(true)
    expect(allowed('Bash(ls *)', 'lsof')).toBe(false)
    expect(allowed('Bash(ls*)', 'lsof')).toBe(true)
    expect(allowed('Bash(git log * main)', 'git log --oneline main')).toBe(true)
    expect(allowed('Bash(git log * main)', 'git push origin main')).toBe(false)
  })

  it('needs every subcommand allowed, and any subcommand denies', () => {
    const set = rules({ allow: ['Bash(safe-cmd *)'], deny: ['Bash(rm *)'] })
    expect(ruleVerdict(set, bash('safe-cmd one && other-cmd'), cwd)).toBeUndefined()
    expect(ruleVerdict(set, bash('safe-cmd one && safe-cmd two'), cwd)?.kind).toBe('allow')
    expect(ruleVerdict(set, bash('safe-cmd one; FOO=bar rm -rf tmp/'), cwd)?.kind).toBe('deny')
    expect(ruleVerdict(rules({ ask: ['Bash(git clean *)'] }), bash('echo "$(git clean -f)"'), cwd)?.kind).toBe('ask')
  })

  it('applies a bare tool name to every call of the tool', () => {
    expect(ruleVerdict(rules({ deny: ['WebFetch'] }), foreignTool('claude-code', 'web_fetch', { url: 'https://a.test' }, context), cwd)?.kind).toBe('deny')
    expect(ruleVerdict(rules({ allow: ['Bash'] }), bash('anything && else'), cwd)?.kind).toBe('allow')
  })

  it('matches file rules relative to the working directory', () => {
    const read = (path: string): ReturnType<typeof foreignTool> => foreignTool('claude-code', 'read', { file_path: path }, context)
    const set = rules({ deny: ['Read(./.env)'], allow: ['Read(src/**)'] })
    expect(ruleVerdict(set, read(join(cwd, '.env')), cwd)?.kind).toBe('deny')
    expect(ruleVerdict(set, read(join(cwd, 'src', 'app.ts')), cwd)?.kind).toBe('allow')
    expect(ruleVerdict(set, read(join(cwd, 'docs', 'a.md')), cwd)).toBeUndefined()
  })

  it('matches WebFetch domains and MCP server rules', () => {
    const fetch = foreignTool('claude-code', 'web_fetch', { url: 'https://api.example.com/x' }, context)
    expect(ruleVerdict(rules({ allow: ['WebFetch(domain:*.example.com)'] }), fetch, cwd)?.kind).toBe('allow')
    expect(ruleVerdict(rules({ allow: ['WebFetch(domain:example.com)'] }), fetch, cwd)).toBeUndefined()
    const mcp = foreignTool('claude-code', 'mcp__github__get_issue', {}, context)
    expect(ruleVerdict(rules({ allow: ['mcp__github__*'] }), mcp, cwd)?.kind).toBe('allow')
    expect(ruleVerdict(rules({ allow: ['mcp__github__get_*'] }), mcp, cwd)?.kind).toBe('allow')
    expect(ruleVerdict(rules({ allow: ['mcp__github'] }), mcp, cwd)?.kind).toBe('allow')
    // An unanchored allow glob approves nothing; the same glob as deny removes every MCP tool.
    expect(ruleVerdict(rules({ allow: ['mcp__*'] }), mcp, cwd)).toBeUndefined()
    expect(ruleVerdict(rules({ deny: ['mcp__*'] }), mcp, cwd)?.kind).toBe('deny')
    // An MCP allow rule with a specifier matches no call.
    expect(ruleVerdict(rules({ allow: ['mcp__github__get_issue(owner:me)'] }), mcp, cwd)).toBeUndefined()
  })

  it('matches parameter rules on deny and ask, never on a primary content field', () => {
    const background = bash('npm test')
    const withFlag = foreignTool('claude-code', shell, { command: 'npm test', run_in_background: true }, context)
    expect(ruleVerdict(rules({ deny: ['Bash(run_in_background:true)'] }), withFlag, cwd)?.kind).toBe('deny')
    // An omitted parameter never matches.
    expect(ruleVerdict(rules({ deny: ['Bash(run_in_background:true)'] }), background, cwd)).toBeUndefined()
    expect(ruleVerdict(rules({ deny: ['Bash(command:npm *)'] }), background, cwd)).toBeUndefined()
  })
})
