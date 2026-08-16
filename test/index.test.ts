import { Context, type Fiber, type Plugin } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import * as claude2dsh from '../src/index.js'
import {
  DuplicateSessionSourceError,
  type SessionSourceAdapter,
  type SessionSourceRegistry,
} from '../src/index.js'

const activeFibers: Fiber[] = []

async function activate(): Promise<{
  fiber: Fiber
  registry: SessionSourceRegistry
  root: Context
}> {
  const root = new Context()
  const fiber = root.plugin(claude2dsh, { mode: 'read-only' })
  activeFibers.push(fiber)
  await fiber
  const registry = fiber.ctx.get('sessionSources')
  if (!registry) throw new Error('sessionSources service did not activate')
  return { fiber, registry, root }
}

afterEach(async () => {
  await Promise.all(
    activeFibers.splice(0).map(async (fiber) => fiber.dispose()),
  )
})

describe('SessionSourceRegistry', () => {
  it('registers, resolves, and lists adapters in registration order', async () => {
    const { registry } = await activate()
    const first = { id: 'first', displayName: 'First source' }
    const second = { id: 'second', displayName: 'Second source' }

    registry.register(first)
    registry.register(second)

    expect(registry.get('first') === first).toBe(true)
    expect(registry.get('missing') === undefined).toBe(true)
    expect(registry.list().map((entry) => entry.id)).toEqual([
      'first',
      'second',
    ])
  })

  it('rejects duplicate live ids without replacing the owner', async () => {
    const { registry } = await activate()
    const owner = { id: 'duplicate', displayName: 'Owner' }
    registry.register(owner)

    expect(() =>
      registry.register({ id: 'duplicate', displayName: 'Contender' }),
    ).toThrowError(DuplicateSessionSourceError)
    expect(registry.get('duplicate') === owner).toBe(true)
  })

  it('removes an adapter when its explicit disposer runs', async () => {
    const { registry } = await activate()
    const dispose = registry.register({
      id: 'temporary',
      displayName: 'Temporary',
    })

    await dispose()
    await dispose()

    expect(registry.get('temporary') === undefined).toBe(true)
    expect(registry.list()).toEqual([])
  })

  it('owns registrations with the registering plugin fiber', async () => {
    const { registry, root } = await activate()
    const adapter: SessionSourceAdapter = {
      id: 'consumer-owned',
      displayName: 'Consumer owned',
    }
    const consumer: Plugin.Object = {
      name: 'session-source-test-consumer',
      inject: ['sessionSources'],
      apply(ctx: Context) {
        ctx.sessionSources.register(adapter)
      },
    }
    const consumerFiber = root.plugin(consumer)
    activeFibers.push(consumerFiber)
    await consumerFiber
    expect(registry.get(adapter.id) === adapter).toBe(true)

    await consumerFiber.dispose()

    expect(registry.get(adapter.id) === undefined).toBe(true)
  })
})

describe('Cordis plugin', () => {
  it('requires the explicit read-only Config value', async () => {
    const missing = new Context().registry.plugin(claude2dsh, {})
    const writeCapable = new Context().registry.plugin(claude2dsh, {
      mode: 'read-write',
    })
    activeFibers.push(missing, writeCapable)

    await expect(missing.await()).rejects.toThrow(/mode/)
    await expect(writeCapable.await()).rejects.toThrow(/read-only/)
  })

  it('activates and disposes the real object plugin service', async () => {
    const { fiber, registry } = await activate()

    expect(claude2dsh.name).toBe('claude2dsh')
    expect(String(registry.mode)).toBe('read-only')
    expect(fiber.ctx.get('sessionSources')?.list() ?? null).not.toBeNull()

    await fiber.dispose()

    expect(fiber.ctx.get('sessionSources') === undefined).toBe(true)
  })
})
