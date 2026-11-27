/**
 * One interception point on DSH's slash-command execution.
 *
 * DSH's `commands` service has no hook around `execute` (DSH 0.2.2-rc.3 and
 * 0.2.2-rc.5: it emits only `commands/change`), yet Harness Forge must act
 * there twice: commands wait for Harness Forge's startup, and a Claude Code
 * mod's `command.run` hooks see, answer or replace a typed command. So the
 * service's `execute` is wrapped once, here, and every use adds an
 * interceptor to one ordered chain; the wrapper goes when the last
 * interceptor does. Interceptors added later run first (outermost).
 *
 * DSH has no such hook yet. When it has one,
 * only this module changes.
 * @module @kirkchinese/harness-forge
 */

/** `commands.execute`'s arguments: the agent, the line, its attachments, the signal. */
export type ExecuteArgs = readonly unknown[]
/** One interceptor: call `next` to go on (with the same or changed arguments), or answer without it. */
export type CommandInterceptor = (args: ExecuteArgs, next: (args?: ExecuteArgs) => Promise<unknown>) => Promise<unknown>

interface CommandsService {
  execute(...args: unknown[]): Promise<unknown>
}

interface Chain {
  readonly interceptors: CommandInterceptor[]
  readonly original: (...args: unknown[]) => Promise<unknown>
  readonly wrapper: (...args: unknown[]) => Promise<unknown>
  /** Whether `execute` was the object's own property (else its class's method). */
  readonly own: boolean
}

const chains = new WeakMap<object, Chain>()

/**
 * Add an interceptor around the commands service's `execute`.
 * @param commands - DSH's `commands` service.
 * @param interceptor - the interceptor.
 * @returns a function that removes it.
 */
export function interceptCommands(commands: CommandsService, interceptor: CommandInterceptor): () => void {
  let chain = chains.get(commands)
  if (chain === undefined) {
    const original = commands.execute
    const own = Object.prototype.hasOwnProperty.call(commands, 'execute')
    const interceptors: CommandInterceptor[] = []
    const wrapper = async (...args: unknown[]): Promise<unknown> => {
      // The interceptors present when the call starts: one added or removed meanwhile does not shift this call.
      const present = [...interceptors]
      const run = async (index: number, current: ExecuteArgs): Promise<unknown> => {
        const next = present[index]
        if (next === undefined) return original.apply(commands, current as unknown[])
        return next(current, (changed) => run(index + 1, changed ?? current))
      }
      return run(0, args)
    }
    chain = { interceptors, original, wrapper, own }
    chains.set(commands, chain)
    Object.defineProperty(commands, 'execute', { value: wrapper, configurable: true, writable: true })
  }
  chain.interceptors.unshift(interceptor)
  const owned = chain
  return () => {
    const at = owned.interceptors.indexOf(interceptor)
    if (at >= 0) owned.interceptors.splice(at, 1)
    if (owned.interceptors.length > 0 || chains.get(commands) !== owned) return
    chains.delete(commands)
    // Back to what DSH had, unless something else replaced the wrapper meanwhile.
    if (commands.execute !== owned.wrapper) return
    if (owned.own) Object.defineProperty(commands, 'execute', { value: owned.original, configurable: true, writable: true })
    else delete (commands as Partial<CommandsService>).execute
  }
}
