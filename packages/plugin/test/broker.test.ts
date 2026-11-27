import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Session, pluginRecordOf } from '@deepseek-ai/dsh-session'
import { HookBroker, type HookObservation } from '../src/hooks/broker.js'
import { parseHookTable } from '../src/hooks/config.js'
import { createForeignShell } from '../src/hooks/shell.js'

/**
 * One hook script for every case. It records the payload it received and
 * answers according to `HOOK_MODE` (passed as the first argument).
 */
const HOOK_SCRIPT = `
const fs = require('fs')
const mode = process.argv[2] || 'default'
let input = ''
process.stdin.on('data', chunk => { input += chunk })
process.stdin.on('end', () => {
  const event = JSON.parse(input)
  fs.appendFileSync(process.env.CLAUDE_PLUGIN_DATA + '/seen.jsonl', JSON.stringify({ mode, event, setting: process.env.LAB_SETTING }) + '\\n')
  const out = (value) => process.stdout.write(JSON.stringify(value))
  switch (mode) {
    case 'allow-json': return out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } })
    case 'exit2': process.stderr.write('Blocked: no rm'); process.exit(2)
    case 'deny-json': return out({ hookSpecificOutput: { hookEventName: event.hook_event_name, permissionDecision: 'deny', permissionDecisionReason: 'json says no' } })
    case 'rewrite': return out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...event.tool_input, command: 'echo rewritten' } } })
    case 'context': return out({ hookSpecificOutput: { hookEventName: event.hook_event_name, additionalContext: 'ctx from ' + event.hook_event_name } })
    case 'plain': process.stdout.write('plain context'); return
    case 'sleep': setTimeout(() => process.exit(0), 700); return
    case 'stop-block': if (!event.stop_hook_active) { process.stderr.write('keep going'); process.exit(2) } return
    case 'stop-always': out({ decision: 'block', reason: 'again' }); return
    case 'halt': return out({ continue: false, stopReason: 'build failed' })
    case 'perm-allow': return out({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
    case 'redact': return out({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { stdout: '[redacted]', stderr: '', interrupted: false, isImage: false } } })
    case 'system': return out({ systemMessage: 'heads up' })
    case 'rewake': process.stderr.write('tests failed'); process.exit(2)
    case 'async-context': setTimeout(() => out({ hookSpecificOutput: { hookEventName: event.hook_event_name, additionalContext: 'async done' } }), 100); return
    default: return
  }
})
`

const temporary: string[] = []
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface FakeAgent {
  readonly session: Session
  readonly options: { provider: string; model: string }
  readonly injected: unknown[]
  readonly steered: unknown[]
  readonly cancelled: unknown[]
  inject(message: unknown): void
  steer(message: unknown): void
  followup(message: unknown): void
  cancel(cause: unknown): void
}

function fakeAgent(id = 'session-root'): FakeAgent {
  const injected: unknown[] = []
  const steered: unknown[] = []
  const cancelled: unknown[] = []
  return {
    session: Session.create(id as never),
    options: { provider: 'p', model: 'm' },
    injected,
    steered,
    cancelled,
    inject: (message) => { injected.push(message) },
    steer: (message) => { steered.push(message) },
    followup: () => {},
    cancel: (cause) => { cancelled.push(cause) },
  }
}

interface Lab {
  readonly broker: HookBroker
  readonly emit: (event: string, ...args: unknown[]) => Promise<unknown>
  readonly observations: HookObservation[]
  readonly root: string
  readonly seen: () => Array<{ mode: string; event: Record<string, unknown>; setting?: string }>
  readonly executed: Array<{ name: string; args: unknown }>
  /** The broker's own disposer, as DSH calls it. */
  readonly stop: () => Promise<void>
  /** The fiber above Harness Forge's: its state 5 (UNLOADING) is DSH exiting. */
  readonly host: { state: number }
}

/** Imported settings a lab broker sees. */
interface LabSettings {
  readonly rules?: { allow?: string[]; deny?: string[]; ask?: string[] }
  readonly env?: Record<string, string>
  readonly disableAllHooks?: boolean
}

const node = (mode: string, extra: Record<string, unknown> = {}) => ({ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/hook.js', mode], ...extra })
const shellForm = (mode: string, extra: Record<string, unknown> = {}) => ({ type: 'command', command: `node "\${CLAUDE_PLUGIN_ROOT}/hook.js" ${mode}`, ...extra })

function lab(hooks: Record<string, unknown>, dialect: 'claude-code' | 'codex' = 'claude-code', settings: LabSettings = {}): Lab {
  const root = mkdtempSync(join(tmpdir(), 'harness-forge-broker-'))
  temporary.push(root)
  writeFileSync(join(root, 'hook.js'), HOOK_SCRIPT, 'utf8')
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>()
  const executed: Array<{ name: string; args: unknown }> = []
  const tools = {
    get: (name: string) => ({
      execute: async (args: unknown) => {
        executed.push({ name, args })
        return { kind: 'foreground', exitCode: 0, stdout: { text: 'ran', truncated: false }, stderr: { text: '', truncated: false }, timedOut: false, aborted: false }
      },
      output: { render: (_args: unknown, value: { stdout: { text: string } }) => [{ type: 'text', text: value.stdout.text }] },
    }),
  }
  // Cordis fibers: DSH's tree above Harness Forge's own.
  const host = { state: 2 }
  const ctx = {
    fiber: { state: 2, parent: { fiber: host } },
    get: (name: string) => (name === 'tools' ? tools : undefined),
    on(name: string, listener: (...args: unknown[]) => unknown) {
      listeners.set(name, [...listeners.get(name) ?? [], listener])
      return () => {}
    },
  }
  const observations: HookObservation[] = []
  const broker = new HookBroker(ctx as unknown as Context, {
    shell: createForeignShell(),
    dataRoot: join(root, 'data'),
    observe: (observation) => { observations.push(observation) },
    agentName: () => undefined,
    environment: () => settings.env ?? {},
    permissionRules: () => ({ allow: settings.rules?.allow ?? [], deny: settings.rules?.deny ?? [], ask: settings.rules?.ask ?? [] }),
    hooksDisabled: () => settings.disableAllHooks === true,
  })
  const stop = broker.install()
  broker.add({ componentId: 'demo:hooks', pluginId: 'claude-code:demo', dialect, pluginRoot: root, dataDir: root, table: parseHookTable({ hooks }), origin: 'plugin' })
  return {
    broker,
    emit: async (event, ...args) => listeners.get(event)?.[0]?.(...args),
    observations,
    root,
    seen: () => existsSync(join(root, 'seen.jsonl'))
      ? readFileSync(join(root, 'seen.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { mode: string; event: Record<string, unknown> })
      : [],
    executed,
    stop: async () => { await stop() },
    host,
  }
}

const exec = (agent: FakeAgent, name: string, args: Record<string, unknown>, callId = 'call-1') => ({ name, arguments: args, callId, agent, signal: new AbortController().signal })
const allow = async () => ({ kind: 'allow' })
const accept = async () => ({ kind: 'accept' })
const text = (message: unknown): string => (message as { content: Array<{ text: string }> }).content.map(block => block.text).join('')
const notices = (agent: FakeAgent) => agent.session.snapshotEvents().map(event => pluginRecordOf(event)).filter(record => record !== undefined && record.type === 'plugin:harness-forge/notice').map(record => record.data as { kind: string; text: string })

describe('HookBroker — SessionEnd', () => {
  it('runs SessionEnd for a session still open when DSH shuts down, once', async () => {
    const hooks = lab({ SessionEnd: [{ hooks: [node('default')] }] })
    const agent = fakeAgent('session-open')
    await hooks.emit('agent/created', { agent, source: 'startup', signal: new AbortController().signal })
    hooks.host.state = 5
    await hooks.stop()
    const ended = hooks.seen().filter(item => item.event['hook_event_name'] === 'SessionEnd')
    expect(ended).toHaveLength(1)
    expect(ended[0]?.event['session_id']).toBe('session-open')
    // Kept beside the session's log, which may no longer take records at that point.
    const kept = readFileSync(join(hooks.root, 'data', 'session-ends.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { sessionId: string; handlerId: string; exitCode: number })
    expect(kept).toEqual([expect.objectContaining({ sessionId: 'session-open', exitCode: 0 })])
    expect(kept[0]?.handlerId.startsWith('demo:hooks:SessionEnd:g0h0:')).toBe(true)
    // DSH disposes the agent afterwards: the session already ended.
    await hooks.emit('agent/disposed', { agent })
    await hooks.broker.drain()
    expect(hooks.seen().filter(item => item.event['hook_event_name'] === 'SessionEnd')).toHaveLength(1)
  }, 30_000)
})

describe('HookBroker — reload', () => {
  it('ends no session when Harness Forge alone is reloaded or removed while DSH goes on', async () => {
    const hooks = lab({ SessionEnd: [{ hooks: [node('default')] }] })
    await hooks.emit('agent/created', { agent: fakeAgent('session-kept'), source: 'startup', signal: new AbortController().signal })
    await hooks.stop()
    expect(hooks.seen().filter(item => item.event['hook_event_name'] === 'SessionEnd')).toEqual([])
  }, 30_000)
})

describe('HookBroker — PreToolUse', () => {
  it('runs a Claude Bash hook for a DSH pwsh call and denies on exit 2 with Claude\'s message', async () => {
    const hooks = lab({ PreToolUse: [{ matcher: 'Bash', hooks: [node('exit2')] }] })
    const agent = fakeAgent()
    const decision = await hooks.emit('tools/pre-execute', exec(agent, 'pwsh', { command: 'rm -rf build', description: 'x' }), allow) as { kind: string; reason: string }
    expect(decision.kind).toBe('deny')
    expect(decision.reason).toMatch(/^PreToolUse:Bash hook error: \[node .*hook\.js exit2\]: Blocked: no rm$/u)
    const payload = hooks.seen()[0]?.event
    expect(payload).toMatchObject({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf build', description: 'x' }, tool_use_id: 'call-1', session_id: 'session-root' })
    expect(typeof payload?.['transcript_path']).toBe('string')
    expect(existsSync(String(payload?.['transcript_path']))).toBe(true)
  })

  it('takes a JSON deny reason and lets deny win over allow from another hook', async () => {
    const hooks = lab({ PreToolUse: [{ matcher: 'Bash', hooks: [node('perm-allow'), node('deny-json')] }] })
    const decision = await hooks.emit('tools/pre-execute', exec(fakeAgent(), 'pwsh', { command: 'ls' }), allow)
    expect(decision).toEqual({ kind: 'deny', reason: 'json says no' })
  })

  it('runs updatedInput with the rewritten arguments through tools/execute', async () => {
    const hooks = lab({ PreToolUse: [{ matcher: 'Bash', hooks: [node('rewrite')] }] })
    const agent = fakeAgent()
    const call = exec(agent, 'pwsh', { command: 'echo original', description: 'd', workdir: 'w' })
    expect(await hooks.emit('tools/pre-execute', call, allow)).toEqual({ kind: 'allow' })
    const result = await hooks.emit('tools/execute', call, async () => { throw new Error('the original call must not run') }) as { value: unknown }
    expect(hooks.executed).toEqual([{ name: 'pwsh', args: { workdir: 'w', command: 'echo rewritten', description: 'd' } }])
    expect(result).toMatchObject({ isError: false, content: [{ type: 'text', text: 'ran' }] })
  })

  it('holds permission rules over hook decisions, against the rewritten input', async () => {
    const host = async () => ({ kind: 'host-decides' })
    // A hook's allow does not pass a deny rule; the rule sees the input the hook rewrote.
    const rewritten = lab({ PreToolUse: [{ matcher: 'Bash', hooks: [node('rewrite')] }] }, 'claude-code', { rules: { deny: ['Bash(echo rewritten)'] } })
    const denied = await rewritten.emit('tools/pre-execute', exec(fakeAgent(), 'pwsh', { command: 'echo original' }), host) as { kind: string; reason: string }
    expect(denied).toEqual({ kind: 'deny', reason: 'Permission to use Bash has been denied by the rule Bash(echo rewritten).' })
    // A matching ask rule prompts even when a hook returned allow.
    const asking = lab({ PreToolUse: [{ matcher: 'Bash', hooks: [node('allow-json')] }] }, 'claude-code', { rules: { ask: ['Bash(git push *)'] } })
    expect(await asking.emit('tools/pre-execute', exec(fakeAgent(), 'pwsh', { command: 'git push origin main' }), host)).toMatchObject({ kind: 'ask' })
    // Without hooks an allow rule skips the host's prompt, and an unmatched call is the host's to decide.
    const rulesOnly = lab({}, 'claude-code', { rules: { allow: ['Bash(npm run *)'] } })
    expect(await rulesOnly.emit('tools/pre-execute', exec(fakeAgent(), 'pwsh', { command: 'npm run build' }), host)).toEqual({ kind: 'allow' })
    expect(await rulesOnly.emit('tools/pre-execute', exec(fakeAgent(), 'pwsh', { command: 'npm run build && curl x' }), host)).toEqual({ kind: 'host-decides' })
  })

  it('gives hooks the settings environment and runs none while disableAllHooks is on', async () => {
    const withEnv = lab({ PreToolUse: [{ hooks: [node('default')] }] }, 'claude-code', { env: { LAB_SETTING: 'from-settings' } })
    await withEnv.emit('tools/pre-execute', exec(fakeAgent(), 'read', { file_path: 'a' }), allow)
    expect(withEnv.seen()[0]?.setting).toBe('from-settings')
    const disabled = lab({ PreToolUse: [{ hooks: [node('exit2')] }] }, 'claude-code', { disableAllHooks: true })
    expect(await disabled.emit('tools/pre-execute', exec(fakeAgent(), 'read', { file_path: 'a' }), allow)).toEqual({ kind: 'allow' })
    expect(disabled.seen()).toEqual([])
  })

  it('applies the settings environment to the model\'s shell commands', async () => {
    const hooks = lab({}, 'claude-code', { env: { LAB_SETTING: "it's set" } })
    const call = exec(fakeAgent(), 'pwsh', { command: 'echo $env:LAB_SETTING' })
    await hooks.emit('tools/execute', call, async () => { throw new Error('the call runs with the settings environment') })
    expect(hooks.executed).toEqual([{ name: 'pwsh', args: { command: "$env:LAB_SETTING = 'it''s set'\necho $env:LAB_SETTING" } }])
    const bash = lab({}, 'claude-code', { env: { LAB_SETTING: "it's set" } })
    await bash.emit('tools/execute', exec(fakeAgent(), 'bash', { command: 'echo "$LAB_SETTING"' }), async () => undefined)
    expect(bash.executed).toEqual([{ name: 'bash', args: { command: "export LAB_SETTING='it'\\''s set'\necho \"$LAB_SETTING\"" } }])
  })

  it('runs matching hooks in parallel', async () => {
    const hooks = lab({ PreToolUse: [{ hooks: [node('sleep'), node('sleep'), node('sleep')] }] })
    const started = Date.now()
    await hooks.emit('tools/pre-execute', exec(fakeAgent(), 'read', { file_path: 'a' }), allow)
    expect(Date.now() - started).toBeLessThan(1900)
    expect(hooks.seen()).toHaveLength(3)
  })

  it('skips a handler whose `if` does not match, and never runs `if` handlers on other events', async () => {
    const hooks = lab({
      PreToolUse: [{ matcher: 'Bash', hooks: [node('exit2', { if: 'Bash(git *)' })] }],
      SessionStart: [{ hooks: [node('plain', { if: 'Bash(git *)' })] }],
    })
    const agent = fakeAgent()
    expect(await hooks.emit('tools/pre-execute', exec(agent, 'pwsh', { command: 'npm test' }), allow)).toEqual({ kind: 'allow' })
    expect((await hooks.emit('tools/pre-execute', exec(agent, 'pwsh', { command: 'npm test && git push' }, 'call-2'), allow) as { kind: string }).kind).toBe('deny')
    await hooks.emit('agent/created', { agent, source: 'startup' })
    expect(agent.injected).toHaveLength(0)
  })

  it('blocks on a failure when onFailure is "block"', async () => {
    const hooks = lab({ PreToolUse: [{ hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/missing.js'], onFailure: 'block' }] }] })
    const decision = await hooks.emit('tools/pre-execute', exec(fakeAgent(), 'read', { file_path: 'a' }), allow) as { kind: string; reason: string }
    expect(decision.kind).toBe('deny')
    expect(decision.reason).toMatch(/failed; blocking because onFailure is "block"/u)
    const passes = lab({ PreToolUse: [{ hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/missing.js'] }] }] })
    expect(await passes.emit('tools/pre-execute', exec(fakeAgent(), 'read', { file_path: 'a' }), allow)).toEqual({ kind: 'allow' })
  })

  it('stops the agent on continue:false and records the reason for the user', async () => {
    const hooks = lab({ PreToolUse: [{ hooks: [node('halt')] }] })
    const agent = fakeAgent()
    expect(await hooks.emit('tools/pre-execute', exec(agent, 'read', { file_path: 'a' }), allow)).toEqual({ kind: 'deny', reason: 'build failed' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(agent.cancelled).toEqual([{ kind: 'hook', reason: 'build failed' }])
    expect(notices(agent)).toEqual([expect.objectContaining({ kind: 'stopped', text: 'build failed' })])
  })

  it('runs shell-form commands in Git Bash with the plugin variables exported', async () => {
    const hooks = lab({ PreToolUse: [{ matcher: 'Read', hooks: [shellForm('deny-json')] }] })
    const decision = await hooks.emit('tools/pre-execute', exec(fakeAgent(), 'read', { file_path: 'a' }), allow)
    expect(decision).toEqual({ kind: 'deny', reason: 'json says no' })
  })
})

describe('HookBroker — PostToolUse and PermissionRequest', () => {
  it('passes a structured tool_response and folds additionalContext as a system reminder', async () => {
    const hooks = lab({ PostToolUse: [{ matcher: 'Write|Edit', hooks: [node('context')] }] })
    const agent = fakeAgent()
    const decision = await hooks.emit('tools/post-execute',
      exec(agent, 'write', { file_path: 'a.txt', content: 'x' }),
      { isError: false, content: [{ type: 'text', text: 'Wrote a.txt' }], value: { path: '/abs/a.txt', operation: 'create', before: null, after: 'x' } },
      accept) as { additionalContexts: unknown[] }
    expect(text(decision.additionalContexts[0])).toBe('<system-reminder>\nPostToolUse hook additional context: ctx from PostToolUse\n</system-reminder>')
    expect(hooks.seen()[0]?.event).toMatchObject({ tool_name: 'Write', tool_response: { type: 'create', filePath: '/abs/a.txt' } })
  })

  it('replaces the model-visible output with updatedToolOutput', async () => {
    const hooks = lab({ PostToolUse: [{ matcher: 'Bash', hooks: [node('redact')] }] })
    const value = { kind: 'foreground', exitCode: 0, stdout: { text: 'secret', truncated: false }, stderr: { text: '', truncated: false }, timedOut: false, aborted: false }
    const decision = await hooks.emit('tools/post-execute', exec(fakeAgent(), 'pwsh', { command: 'cat .env' }), { isError: false, content: [], value }, accept) as { value: { stdout: { text: string } } }
    expect(decision.value.stdout.text).toBe('[redacted]')
  })

  it('treats a shell command that exits non-zero as a failed tool call, as Claude Code does', async () => {
    const hooks = lab({ PostToolUse: [{ matcher: 'Bash', hooks: [node('default')] }], PostToolUseFailure: [{ matcher: 'Bash', hooks: [node('default', { if: 'Bash(npm test)' })] }] })
    const value = { kind: 'foreground', exitCode: 1, stdout: { text: '', truncated: false }, stderr: { text: "Error: Cannot find module 'express'", truncated: false }, timedOut: false, aborted: false }
    await hooks.emit('tools/post-execute', exec(fakeAgent(), 'pwsh', { command: 'npm test' }), { isError: false, content: [], value }, accept)
    expect(hooks.seen()).toHaveLength(1)
    expect(hooks.seen()[0]?.event).toMatchObject({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', error: "Exit code 1\nError: Cannot find module 'express'", is_interrupt: false })
    expect(hooks.seen()[0]?.event).not.toHaveProperty('tool_response')
  })

  it('ignores exit 2 on PermissionRequest and allows on a decision object, with the real tool input', async () => {
    const ignored = lab({ PermissionRequest: [{ hooks: [node('exit2')] }] })
    const agent = fakeAgent()
    expect(await ignored.emit('approval/request', { agent, toolName: 'pwsh', callId: 'c' }, async () => 'cancelled')).toBe('cancelled')
    const allowed = lab({ PreToolUse: [{ hooks: [] }], PermissionRequest: [{ matcher: 'Bash', hooks: [node('perm-allow')] }] })
    await allowed.emit('tools/pre-execute', exec(agent, 'pwsh', { command: 'git push' }, 'c2'), async () => ({ kind: 'ask' }))
    expect(await allowed.emit('approval/request', { agent, toolName: 'pwsh', callId: 'c2' }, async () => 'cancelled')).toBe('allowed-once')
    expect(allowed.seen()[0]?.event).toMatchObject({ tool_name: 'Bash', tool_input: { command: 'git push' } })
    expect(allowed.seen()[0]?.event['tool_use_id']).toBeUndefined()
  })
})

describe('HookBroker — prompts, sessions and turns', () => {
  it('injects SessionStart plain stdout as context, matching on the start source', async () => {
    const hooks = lab({ SessionStart: [{ matcher: 'startup|resume', hooks: [node('plain')] }] })
    const agent = fakeAgent()
    await hooks.emit('agent/created', { agent, source: 'startup' })
    expect(text(agent.injected[0])).toContain('SessionStart hook additional context: plain context')
    const compacted = fakeAgent('session-2')
    await hooks.emit('agent/created', { agent: compacted, source: 'compact' })
    expect(compacted.injected).toHaveLength(0)
  })

  it('rejects a prompt blocked by UserPromptSubmit and shows the reason to the user only', async () => {
    const hooks = lab({ UserPromptSubmit: [{ hooks: [node('exit2')] }] })
    const agent = fakeAgent()
    const decision = await hooks.emit('agent/pre-step', {
      agent,
      messages: [{ content: [{ type: 'text', text: 'please rm everything' }], source: { kind: 'user' } }],
      turn: 1,
      signal: new AbortController().signal,
    }, async () => ({ kind: 'enter', messages: [] }))
    expect(decision).toEqual({ kind: 'reject' })
    expect(notices(agent)).toEqual([expect.objectContaining({ kind: 'blocked', text: 'Blocked: no rm\n\nOriginal prompt: please rm everything' })])
    expect(hooks.seen()[0]?.event).toMatchObject({ prompt: 'please rm everything', prompt_id: expect.any(String) })
  })

  it('continues the turn when Stop blocks, reports stop_hook_active, and caps consecutive continuations', async () => {
    const hooks = lab({ Stop: [{ hooks: [node('stop-block')] }] })
    const agent = fakeAgent()
    const stopping = { agent, turn: 1, signal: new AbortController().signal }
    await hooks.emit('agent/turn-stopping', stopping)
    expect(text(agent.steered[0])).toBe('Stop hook feedback:\nkeep going')
    await hooks.emit('agent/turn-stopping', stopping)
    expect(agent.steered).toHaveLength(1)
    expect(hooks.seen().map(item => item.event['stop_hook_active'])).toEqual([false, true])

    const always = lab({ Stop: [{ hooks: [node('stop-always')] }] })
    const looping = fakeAgent('session-loop')
    for (let index = 0; index < 10; index++) await always.emit('agent/turn-stopping', { agent: looping, turn: 1, signal: new AbortController().signal })
    expect(looping.steered).toHaveLength(8)
  })

  it('continues the turn with Stop additionalContext as feedback', async () => {
    const hooks = lab({ Stop: [{ hooks: [node('context')] }] })
    const agent = fakeAgent()
    await hooks.emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
    expect(text(agent.steered[0])).toBe('Stop hook feedback:\nctx from Stop')
  })

  it('delivers an async hook\'s context to the next model request and wakes the agent on asyncRewake exit 2', async () => {
    const hooks = lab({ PostToolUse: [{ hooks: [node('async-context', { async: true }), node('rewake', { asyncRewake: true, rewakeMessage: 'Background tests:' })] }] })
    const agent = fakeAgent()
    await hooks.emit('tools/post-execute', exec(agent, 'read', { file_path: 'a' }), { isError: false, content: [] }, accept)
    await hooks.broker.drain()
    expect(text(agent.injected[0])).toContain('async done')
    expect(text(agent.steered[0])).toContain('Background tests:\ntests failed')
  })

  it('shows a systemMessage to the user', async () => {
    const hooks = lab({ PreToolUse: [{ hooks: [node('system')] }] })
    const agent = fakeAgent()
    await hooks.emit('tools/pre-execute', exec(agent, 'read', { file_path: 'a' }), allow)
    expect(notices(agent)).toEqual([expect.objectContaining({ kind: 'system-message', text: 'heads up' })])
  })

  it('reports a failing hook as a failed observation and a hook-error notice', async () => {
    const hooks = lab({ PreToolUse: [{ hooks: [{ type: 'command', command: 'exit 7' }] }] })
    const agent = fakeAgent()
    expect(await hooks.emit('tools/pre-execute', exec(agent, 'read', { file_path: 'a' }), allow)).toEqual({ kind: 'allow' })
    expect(hooks.observations).toEqual([expect.objectContaining({ event: 'PreToolUse', ok: false })])
    expect(notices(agent)[0]?.text).toMatch(/^PreToolUse:Read hook error: \[exit 7\]: Failed with non-blocking status code 7/u)
  })
})

describe('HookBroker — Codex dialect', () => {
  it('matches apply_patch for a DSH edit and replaces the result on a PostToolUse block', async () => {
    const hooks = lab({ PostToolUse: [{ matcher: '^apply_patch$', hooks: [node('exit2')] }] }, 'codex')
    const decision = await hooks.emit('tools/post-execute', exec(fakeAgent(), 'edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }), { isError: false, content: [{ type: 'text', text: 'ok' }] }, accept)
    expect(decision).toMatchObject({ kind: 'block', feedback: [{ type: 'text', text: 'Blocked: no rm' }] })
    expect(hooks.seen()[0]?.event).toMatchObject({ tool_name: 'apply_patch', tool_input: { command: expect.stringContaining('*** Update File:') }, turn_id: expect.any(String) })
  })
})
