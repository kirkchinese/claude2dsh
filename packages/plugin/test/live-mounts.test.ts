import { describe, expect, it } from 'vitest'
import { LiveMounts } from '../src/forge/live-mounts.js'

describe('live mounts', () => {
  it('keeps a mount until its withdrawal succeeds, records a failure, and withdraws it on retry', async () => {
    const faults: unknown[] = []
    const mounts = new LiveMounts(error => faults.push(error))
    let fail = true
    let calls = 0
    mounts.add('a', { componentId: 'c', kind: 'hooks', dispose: async () => { calls += 1; if (fail) throw new Error('busy') } })
    const failed = await mounts.release()
    expect(failed.released).toEqual([])
    expect(failed.failed.map(failure => [failure.mount.componentId, failure.reason])).toEqual([['c', 'busy']])
    expect(mounts.has('a')).toBe(true)
    expect(mounts.failure('a')).toBe('busy')
    expect(faults.map(error => (error as Error).message)).toEqual(['busy'])
    // A registration whose withdrawal failed is never replaced.
    expect(() => mounts.add('a', { componentId: 'c', kind: 'hooks', dispose: async () => undefined })).toThrow(/still live/u)
    fail = false
    expect((await mounts.release()).released.map(mount => mount.componentId)).toEqual(['c'])
    expect(mounts.failure('a')).toBeUndefined()
    expect(mounts.has('a')).toBe(false)
    expect(calls).toBe(2)
  })

  it('withdraws each mount once when withdrawals overlap, and stays live while one runs', async () => {
    const mounts = new LiveMounts()
    let calls = 0
    let finish: () => void = () => undefined
    mounts.add('a', { componentId: 'c', kind: 'hooks', dispose: () => { calls += 1; return new Promise<void>((resolve) => { finish = resolve }) } })
    const first = mounts.release()
    const second = mounts.release()
    await Promise.resolve()
    expect(mounts.has('a')).toBe(true)
    finish()
    await Promise.all([first, second])
    expect(calls).toBe(1)
    expect(mounts.has('a')).toBe(false)
  })
})
