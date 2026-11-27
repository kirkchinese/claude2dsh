import { describe, expect, it } from 'vitest'
import { contextsOf, decodeAsyncRun, decodeRun } from '../src/hooks/output.js'

const json = (value: unknown): string => JSON.stringify(value)
const deny = json({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' } })

describe('decodeRun: the exit-code table', () => {
  it('exit 0: JSON applies, invalid JSON is an error, plain text is success', () => {
    expect(decodeRun('PreToolUse', 'claude-code', { exitCode: 0, stdout: deny, stderr: '' })).toMatchObject({ json: { hookSpecificOutput: { permissionDecision: 'deny' } }, failed: false })
    expect(decodeRun('PreToolUse', 'claude-code', { exitCode: 0, stdout: '{not json}', stderr: '' })).toMatchObject({ failed: true, error: expect.stringMatching(/invalid JSON/u) })
    expect(decodeRun('SessionStart', 'claude-code', { exitCode: 0, stdout: 'hello', stderr: '' })).toEqual({ plain: 'hello', failed: false })
    expect(decodeRun('SessionStart', 'claude-code', { exitCode: 0, stdout: '{status: starting', stderr: '' })).toEqual({ plain: '{status: starting', failed: false })
  })

  it('exit 2 blocks with stderr, or the JSON reason when one is given', () => {
    expect(decodeRun('PreToolUse', 'claude-code', { exitCode: 2, stdout: '', stderr: 'Blocked: rm\n' })).toEqual({ block: 'Blocked: rm', failed: false })
    expect(decodeRun('PreToolUse', 'claude-code', { exitCode: 2, stdout: deny, stderr: 'ignored' })).toMatchObject({ block: 'no' })
  })

  it('other exits: valid JSON decides but counts as failure; plain text is a non-blocking error', () => {
    expect(decodeRun('PreToolUse', 'claude-code', { exitCode: 1, stdout: deny, stderr: '' })).toMatchObject({ json: { hookSpecificOutput: { permissionDecision: 'deny' } }, failed: true })
    expect(decodeRun('PreToolUse', 'claude-code', { exitCode: 1, stdout: '', stderr: 'something broke\nmore' })).toEqual({ error: 'Failed with non-blocking status code 1: something broke', failed: true })
  })

  it('rejects a hookSpecificOutput for another event and checks field types', () => {
    expect(decodeRun('PostToolUse', 'claude-code', { exitCode: 0, stdout: deny, stderr: '' })).toMatchObject({ failed: true, error: expect.stringMatching(/hookEventName/u) })
    expect(decodeRun('Stop', 'claude-code', { exitCode: 0, stdout: json({ continue: 'no' }), stderr: '' })).toMatchObject({ failed: true })
    expect(decodeRun('Stop', 'claude-code', { exitCode: 0, stdout: json({ decision: 'allow' }), stderr: '' })).toMatchObject({ failed: true })
  })

  it('reads several JSON lines as plain text unless one sets a field', () => {
    expect(decodeRun('SessionStart', 'claude-code', { exitCode: 0, stdout: '{}\n{}', stderr: '' })).toEqual({ plain: '{}\n{}', failed: false })
    expect(decodeRun('SessionStart', 'claude-code', { exitCode: 0, stdout: '{"a":1}\n{}', stderr: '' })).toMatchObject({ failed: true })
  })

  it('treats a missing-file exit 2 on Stop as a non-blocking error', () => {
    expect(decodeRun('Stop', 'claude-code', { exitCode: 2, stdout: '', stderr: 'bash: /x/hook.sh: No such file or directory' })).toMatchObject({ failed: true, error: expect.any(String) })
    expect(decodeRun('Stop', 'claude-code', { exitCode: 2, stdout: '', stderr: 'keep going' })).toEqual({ block: 'keep going', failed: false })
  })

  it('applies the Codex rules', () => {
    expect(decodeRun('Stop', 'codex', { exitCode: 0, stdout: 'text', stderr: '' })).toMatchObject({ failed: true })
    expect(decodeRun('PreToolUse', 'codex', { exitCode: 0, stdout: json({ continue: false }), stderr: '' })).toMatchObject({ failed: true })
  })

  it('maps start failures, timeouts and cancellation', () => {
    expect(decodeRun('PreToolUse', 'claude-code', { stdout: '', stderr: '', failure: { kind: 'timeout', message: 'timed out after 5ms' } })).toEqual({ error: 'timed out after 5ms', failed: true })
    expect(decodeRun('PreToolUse', 'claude-code', { stdout: '', stderr: '', failure: { kind: 'cancelled', message: 'cancelled' } })).toEqual({ failed: false, cancelled: true })
  })
})

describe('contexts and async output', () => {
  it('reads plain stdout as context only on the events that do', () => {
    expect(contextsOf('UserPromptSubmit', 'claude-code', { plain: 'ctx', failed: false })).toEqual(['ctx'])
    expect(contextsOf('PostToolUse', 'claude-code', { plain: 'ignored', failed: false })).toEqual([])
    expect(contextsOf('PostToolUse', 'claude-code', { json: { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'a' } }, failed: false })).toEqual(['a'])
  })

  it('finds an async JSON response on its own line and drops mistyped fields', () => {
    const decoded = decodeAsyncRun('PostToolUse', 'claude-code', {
      exitCode: 0,
      stdout: `tests running\n${json({ systemMessage: 5, hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'passed' } })}`,
      stderr: '',
    })
    expect(decoded.json).toEqual({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'passed' } })
  })
})
