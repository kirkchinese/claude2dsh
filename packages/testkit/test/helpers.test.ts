import { describe, expect, it } from 'vitest'
import { agentPlanePatch, parseEvents, renderTable, toolResults } from '../src/helpers.ts'

describe('parseEvents', () => {
  it('keeps JSON lines and skips diagnostics and broken lines', () => {
    const events = parseEvents('dsh: booting\n{"type":"session","sessionId":"s"}\n{"type":"oops"\r\n{"type":"final"}\n')
    expect(events.map(event => event.type)).toEqual(['session', 'final'])
  })
})

describe('toolResults', () => {
  const events = [
    { type: 'tool_call', callId: 'a', tool: 'bash' },
    { type: 'tool_call', callId: 'b', tool: 'skill' },
    { type: 'tool_result', callId: 'b', status: 'completed', result: 'loaded' },
    { type: 'tool_result', callId: 'a', status: 'error', result: { message: 'denied' } },
  ]

  it('pairs results with their calls by id, in result order, and reports failures', () => {
    expect(toolResults(events, 'bash')).toEqual([{ ok: false, text: '{"message":"denied"}' }])
    expect(toolResults(events, 'skill')).toEqual([{ ok: true, text: 'loaded' }])
    expect(toolResults(events, 'none')).toEqual([])
  })
})

describe('renderTable', () => {
  it('marks failures and counts them', () => {
    const table = renderTable([
      { name: 'skill', ok: true, detail: 'loaded', ms: 1500 },
      { name: 'hook-deny', ok: false, detail: 'ran anyway', ms: 20 },
    ])
    expect(table).toContain('PASS  skill     ')
    expect(table).toContain('FAIL  hook-deny')
    expect(table).toContain('1 of 2 checks FAILED')
  })
})

describe('agentPlanePatch', () => {
  const patch = `
- id: system-prompt
  disabled: true
- insert:
    - id: webserver
      name: '@deepseek-ai/dsh-web-server'
    - id: ui-chat
      name: '@deepseek-ai/dsh-client-ui-chat'
    - id: workspace
      name: '@deepseek-ai/dsh-workspace'
      config:
        root: !!js process.cwd()
- insert:
    - id: session-controller
      name: '@deepseek-ai/dsh-session-controller'
`

  it('drops browser-only and client rows and keeps disables and the rest, with its expressions', () => {
    const out = agentPlanePatch(patch, new Set(['webserver', 'session-controller']))
    expect(out).toContain('id: system-prompt')
    expect(out).toContain('id: workspace')
    expect(out).toContain('!!js process.cwd()')
    expect(out).not.toContain('webserver')
    expect(out).not.toContain('ui-chat')
    expect(out).not.toContain('session-controller')
  })
})
