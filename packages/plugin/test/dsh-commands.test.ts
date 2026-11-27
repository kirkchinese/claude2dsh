import { describe, expect, it } from 'vitest'
import { interceptCommands } from '../src/dsh/commands.js'

class Commands {
  readonly calls: unknown[][] = []
  async execute(...args: unknown[]): Promise<unknown> {
    this.calls.push(args)
    return `ran ${String(args[1])}`
  }
}

describe('interceptCommands', () => {
  it('chains interceptors around the service (latest outermost) and restores the class method when the last goes', async () => {
    const commands = new Commands()
    const order: string[] = []
    const removeGate = interceptCommands(commands, async (args, next) => { order.push('gate'); return next(args) })
    const removeMods = interceptCommands(commands, async (args, next) => {
      order.push('mods')
      return args[1] === '/answered' ? 'answered by a hook' : next(['agent', `${String(args[1])} changed`])
    })
    expect(await commands.execute('agent', '/x')).toBe('ran /x changed')
    expect(order).toEqual(['mods', 'gate'])
    expect(await commands.execute('agent', '/answered')).toBe('answered by a hook')
    expect(commands.calls).toHaveLength(1)
    // Removing the first-added keeps the other in place.
    removeGate()
    order.length = 0
    expect(await commands.execute('agent', '/y')).toBe('ran /y changed')
    expect(order).toEqual(['mods'])
    removeMods()
    expect(Object.prototype.hasOwnProperty.call(commands, 'execute')).toBe(false)
    expect(await commands.execute('agent', '/z')).toBe('ran /z')
  })
})