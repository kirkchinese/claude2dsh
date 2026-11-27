import { afterEach, describe, expect, it } from 'vitest'
import { claudeFamily, resolveRoute, setModelAliases } from '../src/shared/invocation.js'

const llm = {
  listProviders: () => [{ id: 'deepseek-official' }],
  listModels: async () => [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }, { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }],
  resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }] } }),
}
const ctx = { get: (name: string) => (name === 'llm' ? llm : undefined) } as never
const current = { provider: 'deepseek-official', model: 'deepseek-flash' }
const signal = new AbortController().signal

afterEach(() => { setModelAliases(undefined) })

describe('Claude model aliases', () => {
  it('reads the family of an alias or a Claude model id', () => {
    expect(claudeFamily('haiku')).toBe('haiku')
    expect(claudeFamily('opusplan')).toBe('opus')
    expect(claudeFamily('claude-sonnet-4-5-20250929')).toBe('sonnet')
    expect(claudeFamily('deepseek-flash')).toBeUndefined()
  })

  it('keeps the session model for an unmapped alias, with a note', async () => {
    const opus = await resolveRoute(ctx, current, 'opus', undefined, signal)
    expect(opus.route).toBeUndefined()
    expect(opus.note).toMatch(/is Claude's opus; it runs on deepseek-flash/u)
  })

  it('routes an alias the person mapped', async () => {
    setModelAliases({ haiku: 'deepseek-official/deepseek-v4-pro' })
    expect((await resolveRoute(ctx, current, 'haiku', undefined, signal)).route).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })
    expect((await resolveRoute(ctx, current, 'sonnet', undefined, signal)).route).toBeUndefined()
  })
})