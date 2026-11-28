import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { conditionMatches } from '../src/hooks/condition.js'
import { handlerTypes, parseHookTable } from '../src/hooks/config.js'
import { matcherSelects } from '../src/hooks/matcher.js'
import { shellCommands } from '../src/hooks/shell-commands.js'
import { dshInput, dshToolsFor, dshValue, foreignResponse, foreignTool } from '../src/hooks/vocabulary.js'

const cwd = process.platform === 'win32' ? 'C:\\repo' : '/repo'

describe('foreignTool', () => {
  it('presents a DSH shell call as Claude Bash with Claude input fields', () => {
    const tool = foreignTool('claude-code', 'pwsh', { command: 'git status', description: 'status', timeoutMs: 5000, workdir: 'x' })
    expect(tool.name).toBe('Bash')
    expect(tool.aliases).toEqual(['Bash', 'PowerShell', 'pwsh'])
    expect(tool.input).toEqual({ command: 'git status', description: 'status', timeout: 5000 })
  })

  it('presents a capability-catalog call as the MCP tool it runs, both ways', () => {
    const call = { id: 'mcp:plugin_ctx_ctx7/resolve-library-id', arguments: { libraryName: 'react' } }
    const tool = foreignTool('claude-code', 'capability_call', call)
    expect(tool).toMatchObject({ name: 'mcp__plugin_ctx_ctx7__resolve-library-id', input: { libraryName: 'react' } })
    expect(matcherSelects('claude-code', 'PreToolUse', 'mcp__plugin_ctx_ctx7__.*', tool.aliases)).toBe(true)
    expect(dshInput('claude-code', 'capability_call', call, { libraryName: 'vue' })).toEqual({ id: call.id, arguments: { libraryName: 'vue' } })
    expect(foreignResponse('claude-code', 'capability_call', call, { text: 'ok' }, 'ok')).toEqual([{ type: 'text', text: 'ok' }])
    expect(foreignResponse('claude-code', 'capability_call', call, { text: 'ok', structuredContent: { id: 1 } }, 'ok')).toEqual({ id: 1 })
    // A catalog search is not an MCP call.
    expect(foreignTool('claude-code', 'capability_search', { query: 'x' }).name).toBe('capability_search')
  })

  it('makes file paths absolute against the working directory', () => {
    const tool = foreignTool('claude-code', 'write', { file_path: 'src/a.ts', content: 'x', sandbox_permissions: 'y' }, { cwd })
    expect(tool.input).toEqual({ file_path: join(cwd, 'src', 'a.ts'), content: 'x' })
  })

  it('presents DSH write/edit as apply_patch to Codex hooks', () => {
    const tool = foreignTool('codex', 'edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }, { cwd })
    expect(tool.name).toBe('apply_patch')
    expect(tool.aliases).toEqual(expect.arrayContaining(['apply_patch', 'Edit', 'Write']))
    expect(String(tool.input['command'])).toContain(`*** Update File: ${join(cwd, 'a.ts')}`)
  })

  it('names delegated agents with their foreign name and maps grep/web_search/skill shapes', () => {
    const agent = foreignTool('claude-code', 'agent', { agent_preset: 'p1', prompt: 'p', description: 'd' }, { agentName: id => id === 'p1' ? 'pr-review-toolkit:code-reviewer' : undefined })
    expect(agent).toMatchObject({ name: 'Agent', input: { subagent_type: 'pr-review-toolkit:code-reviewer', prompt: 'p' } })
    expect(foreignTool('claude-code', 'grep', { pattern: 'x', include: '*.ts' }).input).toEqual({ pattern: 'x', glob: '*.ts', output_mode: 'content' })
    expect(foreignTool('claude-code', 'web_search', { queries: ['a', 'b'] }).input).toEqual({ query: 'a', queries: ['a', 'b'] })
    expect(foreignTool('claude-code', 'skill', { name: 'tdd' }).input).toEqual({ skill: 'tdd' })
  })

  it('keeps MCP tool names and input', () => {
    expect(foreignTool('claude-code', 'mcp__plugin_x_y__run', { a: 1 })).toMatchObject({ name: 'mcp__plugin_x_y__run', input: { a: 1 } })
  })
})

describe('dshInput', () => {
  it('maps a Claude Bash rewrite back, keeping DSH-only fields', () => {
    expect(dshInput('claude-code', 'pwsh', { command: 'a', description: 'd', workdir: 'w' }, { command: 'b', timeout: 9 }))
      .toEqual({ workdir: 'w', command: 'b', description: 'd', timeoutMs: 9 })
  })

  it('turns a Codex patch rewrite into write/edit arguments', () => {
    expect(dshInput('codex', 'write', {}, { command: '*** Begin Patch\n*** Add File: /x.txt\n+hello\n+world\n*** End Patch' }))
      .toEqual({ file_path: '/x.txt', content: 'hello\nworld' })
    expect(dshInput('codex', 'edit', {}, { command: '*** Begin Patch\n*** Update File: /x.txt\n@@\n-old\n+new\n*** End Patch' }))
      .toEqual({ file_path: '/x.txt', old_string: 'old', new_string: 'new' })
  })

  it('refuses a shell rewrite without a command', () => {
    expect(() => dshInput('claude-code', 'pwsh', {}, { description: 'x' })).toThrow(/command/u)
  })
})

describe('tool responses', () => {
  it('shapes DSH values as Claude tool_response objects', () => {
    expect(foreignResponse('claude-code', 'pwsh', {}, { kind: 'foreground', exitCode: 0, stdout: { text: 'out' }, stderr: { text: '' }, timedOut: false, aborted: false }, 'out'))
      .toEqual({ stdout: 'out', stderr: '', interrupted: false, isImage: false, exitCode: 0 })
    expect(foreignResponse('claude-code', 'write', {}, { path: '/a', operation: 'create', before: null, after: 'x' }, ''))
      .toMatchObject({ type: 'create', filePath: '/a', content: 'x' })
    expect(foreignResponse('codex', 'write', {}, { path: '/a' }, 'Wrote /a')).toBe('Wrote /a')
  })

  it('maps updatedToolOutput back into a DSH shell value', () => {
    const original = { kind: 'foreground', exitCode: 0, stdout: { text: 'secret', truncated: false }, stderr: { text: '', truncated: false } }
    expect(dshValue('pwsh', original, { stdout: '[redacted]', stderr: '' })).toMatchObject({ stdout: { text: '[redacted]' } })
    expect(dshValue('glob', { paths: [] }, { filenames: [] })).toBeUndefined()
  })
})

describe('dshToolsFor', () => {
  it('maps foreign names and rule forms to DSH tools', () => {
    expect(dshToolsFor('Read')).toEqual(['read', 'read_image'])
    expect(dshToolsFor('Bash(git *)')).toEqual(['bash', 'pwsh'])
    expect(dshToolsFor('apply_patch')).toEqual(['write', 'edit'])
    expect(dshToolsFor('Unknown')).toEqual([])
  })
})

describe('matcherSelects', () => {
  it('applies Claude exact lists, regexes and unmatched events', () => {
    expect(matcherSelects('claude-code', 'PreToolUse', 'Edit, Write', ['Write'])).toBe(true)
    expect(matcherSelects('claude-code', 'PreToolUse', 'Edit|Write', ['NotebookEdit'])).toBe(false)
    expect(matcherSelects('claude-code', 'SubagentStart', 'code-reviewer', ['other-code-reviewer'])).toBe(false)
    // Unanchored: `Edit.*` matches NotebookEdit too; `^Edit$` does not.
    expect(matcherSelects('claude-code', 'PreToolUse', 'Edit.*', ['NotebookEdit'])).toBe(true)
    expect(matcherSelects('claude-code', 'PreToolUse', '^Edit$', ['NotebookEdit'])).toBe(false)
    expect(matcherSelects('claude-code', 'PreToolUse', 'mcp__memory', ['mcp__memory__create'])).toBe(false)
    expect(matcherSelects('claude-code', 'PreToolUse', 'mcp__memory__.*', ['mcp__memory__create'])).toBe(true)
    expect(matcherSelects('claude-code', 'Stop', 'Bash', [''])).toBe(true)
    expect(matcherSelects('claude-code', 'StopFailure', 'rate-limit', ['rate-limit'])).toBe(true)
    expect(matcherSelects('claude-code', 'SubagentStart', '^my-plugin:reviewer$', ['my-plugin:reviewer'])).toBe(true)
  })

  it('treats Codex matchers as regular expressions', () => {
    expect(matcherSelects('codex', 'PreToolUse', 'Bash', ['xBashy'])).toBe(true)
    expect(matcherSelects('codex', 'PreToolUse', '^apply_patch$', ['apply_patch', 'Edit'])).toBe(true)
  })
})

describe('shellCommands', () => {
  it('splits subcommands, substitutions and assignments', () => {
    expect(shellCommands('FOO=bar git push')?.commands).toEqual(['git push'])
    expect(shellCommands('npm test && git push')?.commands).toEqual(['npm test', 'git push'])
    expect(shellCommands('echo $(rm -rf /)')).toEqual({ commands: ['rm -rf /', 'echo $(rm -rf /)'], dynamic: true })
    expect(shellCommands('echo "unterminated')).toBeUndefined()
  })
})

describe('conditionMatches', () => {
  const bash = (command: string) => foreignTool('claude-code', 'pwsh', { command })
  it('matches Bash rules per subcommand, as the hook reference table shows', () => {
    expect(conditionMatches('Bash(git *)', bash('FOO=bar git push'), cwd)).toBe(true)
    expect(conditionMatches('Bash(git *)', bash('npm test && git push'), cwd)).toBe(true)
    expect(conditionMatches('Bash(rm *)', bash('echo $(rm -rf /)'), cwd)).toBe(true)
    expect(conditionMatches('Bash(rm *)', bash('echo $(date)'), cwd)).toBe(false)
    expect(conditionMatches('Bash(git push *)', bash('echo $(date)'), cwd)).toBe(false)
    expect(conditionMatches('Bash(git push *)', bash('git $(date)'), cwd)).toBe(true)
    expect(conditionMatches('Bash(npm run test:*)', bash('npm run test -- --watch'), cwd)).toBe(true)
    expect(conditionMatches('Bash(git *)', bash('gitk'), cwd)).toBe(false)
  })

  it('matches file rules relative to the working directory', () => {
    const edit = (file: string) => foreignTool('claude-code', 'edit', { file_path: file }, { cwd })
    expect(conditionMatches('Edit(src/**)', edit('src/a/b.ts'), cwd)).toBe(true)
    expect(conditionMatches('Edit(src/**)', edit('lib/src/b.ts'), cwd)).toBe(false)
    expect(conditionMatches('Edit(**/src/**)', edit('lib/src/b.ts'), cwd)).toBe(true)
    expect(conditionMatches('Edit(*.ts)', edit('deep/dir/x.ts'), cwd)).toBe(true)
    expect(conditionMatches('Edit(*.ts)', foreignTool('claude-code', 'write', { file_path: 'x.ts' }, { cwd }), cwd)).toBe(true)
    expect(conditionMatches('Write(*.md)', edit('a.md'), cwd)).toBe(false)
  })

  it('matches MCP and WebFetch domain rules', () => {
    const mcp = foreignTool('claude-code', 'mcp__plugin_my-plugin_db__query', {})
    expect(conditionMatches('mcp__plugin_my-plugin_db__query', mcp, cwd)).toBe(true)
    expect(conditionMatches('mcp__plugin_my-plugin_db', mcp, cwd)).toBe(true)
    expect(conditionMatches('mcp__plugin_other_db', mcp, cwd)).toBe(false)
    const fetch = (url: string): ReturnType<typeof foreignTool> => foreignTool('claude-code', 'web_fetch', { url })
    // `domain:example.com` is that host only; `*.example.com` its subdomains; other `*` stays between dots.
    expect(conditionMatches('WebFetch(domain:example.com)', fetch('https://example.com/x'), cwd)).toBe(true)
    expect(conditionMatches('WebFetch(domain:example.com)', fetch('https://api.example.com/x'), cwd)).toBe(false)
    expect(conditionMatches('WebFetch(domain:*.example.com)', fetch('https://a.b.example.com/x'), cwd)).toBe(true)
    expect(conditionMatches('WebFetch(domain:*.example.com)', fetch('https://example.com/x'), cwd)).toBe(false)
    expect(conditionMatches('WebFetch(domain:example.*)', fetch('https://example.org/'), cwd)).toBe(true)
    expect(conditionMatches('WebFetch(domain:example.*)', fetch('https://example.evil.com/'), cwd)).toBe(false)
  })
})

describe('parseHookTable', () => {
  it('keeps every handler field of every handler type', () => {
    const table = parseHookTable({ hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [
      { type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/x.js'], timeout: 5, if: 'Bash(git *)', asyncRewake: true, rewakeMessage: 'M', shell: 'powershell', onFailure: 'block', statusMessage: 'S' },
      { type: 'http', url: 'http://localhost', headers: { A: '$T' }, allowedEnvVars: ['T'] },
      { type: 'mcp_tool', server: 's', tool: 't', input: { p: '${tool_input.command}' } },
      { type: 'prompt', prompt: 'p', continueOnBlock: true },
      { command: 'no type' },
    ] }] } })
    const handlers = table.get('PostToolUse')?.[0]?.handlers ?? []
    expect(handlers[0]).toEqual({ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/x.js'], timeoutSec: 5, condition: 'Bash(git *)', asyncRewake: true, rewakeMessage: 'M', shell: 'powershell', onFailure: 'block', statusMessage: 'S' })
    expect(handlers[1]).toMatchObject({ type: 'http', url: 'http://localhost', allowedEnvVars: ['T'] })
    expect(handlers[2]).toMatchObject({ type: 'mcp_tool', server: 's', tool: 't' })
    expect(handlers[3]).toMatchObject({ type: 'prompt', continueOnBlock: true })
    expect(handlers[4]).toMatchObject({ type: 'invalid' })
    expect(handlerTypes(table).sort()).toEqual(['command', 'http', 'invalid', 'mcp_tool', 'prompt'])
  })
})
