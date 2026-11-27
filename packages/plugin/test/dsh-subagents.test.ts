import { describe, expect, it } from 'vitest'
import { startActivation } from '../src/dsh/subagents.js'

const activation = { result: Promise.resolve({}), dispose: async () => {} }
const task = { parent: { id: 'parent' }, prompt: [{ type: 'text', text: 'go' }], agentPreset: 'reviewer' }
const options = { provider: 'spawn', label: 'lab', signal: new AbortController().signal, delivery: 'caller' as const }

describe('startActivation', () => {
  it('puts the task at the top level, where DSH reads spec.parent', async () => {
    let spec: Record<string, unknown> | undefined
    await startActivation({ startActivation: async (value: Record<string, unknown>) => { spec = value; return activation } }, task, options)
    expect(spec).toEqual({ ...options, ...task })
    expect(spec?.['request']).toBeUndefined()
  })
})
