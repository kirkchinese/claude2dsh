import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { decodeRun } from '../src/hooks/output.js'
import { fillTemplate, HandlerRunner, powershellPlaceholders, type HandlerRequest } from '../src/hooks/runner.js'
import { createForeignShell, findPosixShell, findPowerShell } from '../src/hooks/shell.js'
import { renderTranscript } from '../src/hooks/transcript.js'

const temporary: string[] = []
afterEach(() => {
  // A background child (`sleep 3 &` below) keeps its directory open on Windows until it exits.
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 })
})

function request(root: string, overrides: Partial<HandlerRequest> = {}): HandlerRequest {
  return {
    event: 'PreToolUse',
    dialect: 'claude-code',
    payload: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
    places: { pluginRoot: root, dataDir: root, projectDir: root, cwd: root, options: { webhook_url: 'https://hooks.example' } },
    timeoutMs: 10_000,
    signal: new AbortController().signal,
    ...overrides,
  }
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness forge runner '))
  temporary.push(root)
  return root
}

describe('HandlerRunner', () => {
  const runner = new HandlerRunner({ get: () => undefined } as unknown as Context, createForeignShell())

  it('exec form passes placeholders and user_config values as single arguments, spaces included', async () => {
    const root = tempRoot()
    writeFileSync(join(root, 'echo.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))', 'utf8')
    const outcome = await runner.command({ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/echo.js', '${user_config.webhook_url}', "it's $HOME"] }, request(root))
    expect(JSON.parse(outcome.stdout)).toEqual(['https://hooks.example', "it's $HOME"])
  })

  it('refuses a shell-form command that references user_config', async () => {
    const outcome = await runner.command({ type: 'command', command: 'echo ${user_config.webhook_url}' }, request(tempRoot()))
    expect(outcome.failure?.message).toMatch(/user_config/u)
  })

  it('lets bash expand placeholder defaults from the exported environment', async () => {
    const root = tempRoot()
    const outcome = await runner.command({ type: 'command', command: 'printf "%s|%s" "${CLAUDE_PLUGIN_ROOT:-none}" "$CLAUDE_PLUGIN_OPTION_WEBHOOK_URL"' }, request(root))
    expect(outcome.stdout).toBe(`${root.replace(/\\/gu, '/')}|https://hooks.example`)
  })

  it('rewrites the path placeholders of a PowerShell command to ${env:NAME}, without needing PowerShell', () => {
    expect(powershellPlaceholders('Write-Output "${CLAUDE_PROJECT_DIR}" "${CLAUDE_PLUGIN_ROOT}/x.ps1"')).toBe('Write-Output "${env:CLAUDE_PROJECT_DIR}" "${env:CLAUDE_PLUGIN_ROOT}/x.ps1"')
  })

  // Running it for real needs a PowerShell, which a machine may not have (the CI runners all do).
  it.skipIf(spawnSync(findPowerShell(), ['-NoProfile', '-Command', 'exit 0']).status !== 0)('rewrites placeholders to ${env:NAME} for PowerShell', async () => {
    const root = tempRoot()
    const outcome = await runner.command({ type: 'command', shell: 'powershell', command: 'Write-Output "${CLAUDE_PROJECT_DIR}"' }, request(root))
    expect(outcome.stdout.trim()).toBe(root.replace(/\\/gu, '/'))
  }, 30_000)

  it('refuses an allow when a background child kept the output open', async () => {
    const root = tempRoot()
    const allow = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } })
    writeFileSync(join(root, 'bg.sh'), `printf '%s' '${allow}'\nsleep 3 &\n`, 'utf8')
    const outcome = await runner.command({ type: 'command', command: 'bash "${CLAUDE_PLUGIN_ROOT}/bg.sh"' }, request(root))
    expect(outcome.suspectCapture).toBe(true)
    expect(decodeRun('PreToolUse', 'claude-code', outcome).json).toBeDefined()
  }, 15_000)

  it('posts the payload to an HTTP hook and interpolates only allowed variables', async () => {
    let seen: { body: string; auth: string | undefined; other: string | undefined } | undefined
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString() })
      req.on('end', () => {
        seen = { body, auth: req.headers['authorization'], other: req.headers['x-other'] as string | undefined }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'http says no' } }))
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    process.env['HF_TEST_TOKEN'] = 'secret'
    process.env['HF_TEST_OTHER'] = 'leak'
    try {
      const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/hook`
      const outcome = await runner.http({ type: 'http', url, headers: { Authorization: 'Bearer $HF_TEST_TOKEN', 'X-Other': '${HF_TEST_OTHER}' }, allowedEnvVars: ['HF_TEST_TOKEN'] }, request(tempRoot()))
      expect(seen?.auth).toBe('Bearer secret')
      expect(seen?.other).toBe('')
      expect(JSON.parse(seen?.body ?? '{}')).toMatchObject({ tool_name: 'Bash' })
      expect(decodeRun('PreToolUse', 'claude-code', outcome).json).toMatchObject({ hookSpecificOutput: { permissionDecisionReason: 'http says no' } })
    } finally {
      server.close()
    }
  })

  it('fills mcp_tool input templates, keeping JSON types for whole-value placeholders', () => {
    expect(fillTemplate({ path: '${tool_input.file_path}', count: '${tool_input.count}', message: 'Scanning ${tool_input.file_path}' }, { tool_input: { file_path: 'src/main.rs', count: 3 } }))
      .toEqual({ path: 'src/main.rs', count: 3, message: 'Scanning src/main.rs' })
  })
})

describe('findPosixShell', () => {
  // `/bin/sh` is dash on Debian and Ubuntu; Claude Code hooks are written for bash (Git Bash on Windows).
  it('prefers bash, so bash syntax in a hook runs', async () => {
    expect(findPosixShell()?.shell).toMatch(/bash(?:\.exe)?$/iu)
    const outcome = await createForeignShell().runShell('if [[ "a b" == a* ]]; then words=(x y); echo "${#words[@]}"; fi', 'bash', { cwd: tmpdir() })
    expect(outcome.stdout.trim()).toBe('2')
  })
})

describe('renderTranscript', () => {
  it('writes Claude Code JSONL with Claude tool names and inputs', () => {
    const events = [
      { type: 'user/message', time: 1, data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } },
      { type: 'assistant/message', time: 2, data: { message: { id: 'm1', content: [{ type: 'text', text: 'running' }, { type: 'tool-call', id: 't1', name: 'pwsh', arguments: '{"command":"ls","timeoutMs":5}' }] } } },
      { type: 'tool/result', time: 3, data: { message: { role: 'tool', toolCallId: 't1', content: [{ type: 'text', text: 'a.txt' }] } } },
      { type: 'assistant/message', time: 4, data: { message: { id: 'm2', content: [{ type: 'text', text: 'done' }] } } },
    ]
    const lines = renderTranscript({ header: { id: 's1' }, seq: events.length, snapshotEvents: () => events }, '/repo').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(lines.map(line => line['type'])).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(lines[1]).toMatchObject({ message: { role: 'assistant', content: [{ type: 'text', text: 'running' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls', timeout: 5 } }] } })
    expect(lines[2]).toMatchObject({ message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt' }] } })
    expect(lines[3]?.['parentUuid']).toBe(lines[2]?.['uuid'])
  })
})
