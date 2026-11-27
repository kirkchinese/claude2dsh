import { describe, expect, it } from 'vitest'
import { selectRoute } from '../src/dsh/model-route.js'
import { narrowRows } from '../src/agents/presets.js'

/** An agent whose route is selected on `agent.model`. */
function agent022(current: { provider: string; model: string; reasoningEffort?: string }): { model: { current(): typeof current; select(next: typeof current): void }; selected: Array<typeof current> } {
  const selected: Array<typeof current> = []
  let now = current
  return { selected, model: { current: () => now, select: (next) => { selected.push(next); now = next } } }
}

describe('model routes', () => {
  it('selects the route on the agent and can put it back', () => {
    const agent = agent022({ provider: 'p', model: 'flash', reasoningEffort: 'high' })
    const selected = selectRoute(agent, { reasoningEffort: 'low' })
    expect(agent.selected).toEqual([{ provider: 'p', model: 'flash', reasoningEffort: 'low' }])
    selected?.restore()
    expect(agent.selected.at(-1)).toEqual({ provider: 'p', model: 'flash', reasoningEffort: 'high' })
    expect(selectRoute({}, { model: 'pro' })).toBeUndefined()
  })

  it('an agent that may delegate keeps the delegation row without model discovery', () => {
    const rows = [{ name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'spawn', toolName: 'subagent', modelDiscovery: true } }]
    expect(narrowRows(rows as never, new Set(['agent', 'read']), new Set())).toEqual([{ name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'spawn', toolName: 'subagent', modelDiscovery: false } }])
    expect(narrowRows(rows as never, new Set(['read']), new Set())).toEqual([])
  })
})
