/**
 * The turn lifecycle of invoked skills and commands, which every row's
 * frontmatter effects share: a user's message ends the previous turn's
 * grants and starts the queued command's, a typed `/skill` line runs on the
 * skill's route from its turn's first step, and a route ends with its turn.
 * The `harness-forge` row listens for these.
 * @module @kirkchinese/harness-forge
 */
import type { Context } from '@deepseek-ai/cordis'
import { interceptCommands } from '../dsh/commands.js'
import { dshService, onDsh } from '../dsh/host.js'
import type { Disposer } from './contract.js'
import type { HarnessForge } from './service.js'

/** The agent facts the turn lifecycle uses. */
interface AgentLike {
  readonly session: { readonly header: { readonly id: string; readonly delegationDepth?: number } }
}

/** Listen for the turn lifecycle. Returns the disposers, one per listener. */
export function turnListeners(ctx: Context, forge: HarnessForge): Array<[string, () => Disposer | undefined]> {
  const invocations = forge.invocations
  return [
    ['turn start', () => onDsh(ctx, 'agent/pre-step', (async (payload: { agent: AgentLike; messages: ReadonlyArray<{ source?: { kind?: string } }>; signal: AbortSignal }, next: () => Promise<unknown>) => {
      const { agent, messages, signal } = payload
      // A forked skill's agent keeps its grants for its whole run; only a user's message ends a turn's.
      if ((agent.session.header.delegationDepth ?? 0) === 0 && messages.some(message => message.source?.kind === 'user')) {
        const sessionId = agent.session.header.id
        invocations.clear(sessionId)
        // A command's frontmatter belongs to the turn its submitted prompt starts.
        for (const spec of invocations.takeQueued(sessionId)) await invocations.activate(agent as never, spec, signal)
      }
      return next()
    }) as never, { prepend: true, owner: 'harness-forge' })],
    ['turn end', () => onDsh(ctx, 'session/event', ((session: { readonly header?: { readonly id?: string }; readonly id?: string }, event: { readonly type: string }) => {
      const id = session.header?.id ?? session.id
      if (id === undefined) return
      if (event.type === 'turn/start') invocations.turnStarted(id)
      else if (event.type === 'turn/end') invocations.turnEnded(id)
    }) as never, { owner: 'harness-forge' })],
    // A typed `/skill` line runs on the skill's route from its turn's first step (DSH 0.2.2 fixes a step's route
    // before agent/pre-step, where the skill is otherwise activated); the route ends with that turn.
    ['typed skills', () => {
      const commands = dshService(ctx, 'commands') as Parameters<typeof interceptCommands>[0] | undefined
      if (commands === undefined) return undefined
      return interceptCommands(commands, async (args, next) => {
        const [agent, line, , signal] = args as [AgentLike | undefined, unknown, unknown, AbortSignal | undefined]
        const name = /^\/([^\s]+)/u.exec(String(line ?? '').trim())?.[1]
        const spec = name === undefined ? undefined : invocations.skill(name)
        if (spec === undefined || agent === undefined) return next()
        await invocations.preselect(agent as never, spec, signal ?? new AbortController().signal).catch(() => undefined)
        // A line that fails or is refused starts no turn: the route it selected is put back now, not after an unrelated turn.
        let execution: unknown
        try {
          execution = await next()
        } catch (error: unknown) {
          invocations.release(agent.session.header.id)
          throw error
        }
        if ((execution as { result?: { kind?: string } } | undefined)?.result?.kind !== 'success') invocations.release(agent.session.header.id)
        return execution
      })
    }],
  ]
}
