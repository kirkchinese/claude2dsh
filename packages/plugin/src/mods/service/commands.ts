/**
 * Slash commands and mods: every typed command through `command.run`, and
 * the commands mods register.
 * @module @kirkchinese/harness-forge/mods
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { interceptCommands } from '../../dsh/commands.js'
import type { SessionAgent } from '../host.js'
import { messageOf } from '../values.js'
import { dshService } from '../../dsh/host.js'
import { hasHooks, type SessionRegistry } from './sessions.js'
import type { CommandsExecute, SessionMods, ToolExec } from './types.js'

/** Command routing for the sessions' mods. */
export class ModCommands {
  constructor(private readonly registry: SessionRegistry) {}

  /**
   * Every slash command a session runs goes through `command.run`: DSH's
   * command registry raises no event, so the shared interception point
   * (`dsh/commands`) is used. A command a mod registered raises the event
   * from its own handler.
   */
  wrapCommands(): () => void {
    const commands = dshService(this.registry.ctx, 'commands') as Parameters<typeof interceptCommands>[0] | undefined
    if (commands === undefined) return () => {}
    return interceptCommands(commands, async (args, next) => {
      const [agent, line, attachments, signal] = args as Parameters<CommandsExecute>
      return this.commandRun(agent, line, signal, (text) => next([agent, text, attachments, signal]) as ReturnType<CommandsExecute>)
    })
  }

  /** One typed command, through the session's `command.run` hooks when a mod has them. */
  private async commandRun(agent: Parameters<CommandsExecute>[0], line: string, signal: Parameters<CommandsExecute>[3], run: (text: string) => ReturnType<CommandsExecute>): Promise<Awaited<ReturnType<CommandsExecute>>> {
    const found = this.registry.sessionOf(agent as ToolExec['agent'])
    const parsed = /^\/(\S+)(?:\s+([\s\S]*))?$/u.exec(line.trim())
    if (found === undefined || parsed === null) return run(line)
    // A resumed session's agent is created when the person acts: the command may arrive while its mods still load
    // (session.start not run, their commands not registered). Route it only once they are ready.
    await found.session.ready
    if (!hasHooks(found.session.engine, 'command.run') || found.session.commands.has(parsed[1]!.toLowerCase())) return run(line)
    const session = found.session
    let execution: Awaited<ReturnType<CommandsExecute>> | undefined
    session.nativeCommands.push(async (command, args) => {
      execution = await run(args.length > 0 ? `/${command} ${args}` : `/${command}`)
      if (execution === undefined) throw new Error(`/${command} is not a command`)
      if (execution.result.kind === 'error') throw new Error(execution.result.text ?? `/${command} failed`)
      return execution.result.text === undefined ? {} : { text: execution.result.text }
    })
    try {
      const result = await session.engine.raise('command.run', {
        command: parsed[1]!,
        args: (parsed[2] ?? '').trim(),
        origin: { kind: 'composer' },
        presentation: { isFullscreen: false, columns: 120 },
      }, { signal }) as Record<string, unknown>
      if (Array.isArray(result['context'])) {
        for (const text of result['context']) (agent as SessionAgent).followup(createUserMessage({ content: [{ type: 'text', text: String(text) }], source: { kind: 'user' } }))
      }
      // A hook that answered without the command keeps it from running; its text is the answer.
      if (execution === undefined) return { commandId: `mod-${crypto.randomUUID()}`, result: { kind: 'success', ...(typeof result['text'] === 'string' ? { text: result['text'] } : {}) } }
      if (typeof result['text'] === 'string' && result['text'] !== execution.result.text && execution.result.kind === 'success') return { ...execution, result: { ...execution.result, text: result['text'] } }
      return execution
    } catch (error: unknown) {
      if (execution !== undefined) return execution
      return { commandId: `mod-${crypto.randomUUID()}`, result: { kind: 'error', text: messageOf(error) } }
    } finally {
      session.nativeCommands.pop()
    }
  }

  registerCommand(session: SessionMods, plugin: string, spec: Record<string, unknown>): () => void {
    const name = String(spec['name'] ?? '')
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(name)) throw new Error('command names are letters, digits, "_" and "-", up to 64 characters')
    const agentCtx = session.agent.ctx as { get?(name: string): unknown } | undefined
    const commands = (dshService(agentCtx, 'commands') ?? dshService(this.registry.ctx, 'commands')) as { register(definition: unknown): () => void } | undefined
    if (commands === undefined) throw new Error('this DSH profile composes no command registry')
    const lowered = name.toLowerCase()
    session.commands.get(lowered)?.()
    const withdraw = commands.register({
      name: lowered,
      description: String(spec['description'] ?? `${plugin}'s /${lowered}`),
      ...(typeof spec['argumentHint'] === 'string' ? { input: { hint: spec['argumentHint'] } } : {}),
      handler: async (invocation: { rawInput: string; signal: AbortSignal }) => {
        try {
          const result = await session.engine.raise('command.run', {
            command: lowered,
            args: invocation.rawInput.trim(),
            origin: { kind: 'composer' },
            presentation: { isFullscreen: false, columns: 120 },
          }, { signal: invocation.signal }) as Record<string, unknown>
          if (Array.isArray(result['context'])) {
            for (const text of result['context']) session.agent.followup(createUserMessage({ content: [{ type: 'text', text: String(text) }], source: { kind: 'user' } }))
          }
          return { kind: 'success', ...(typeof result['text'] === 'string' && result['text'].length > 0 ? { text: result['text'] } : {}) }
        } catch (error: unknown) {
          return { kind: 'error', text: messageOf(error) }
        }
      },
    })
    session.commands.set(lowered, withdraw)
    session.commandOwners.set(lowered, plugin)
    return () => {
      withdraw()
      if (session.commands.get(lowered) === withdraw) session.commands.delete(lowered)
    }
  }
}
