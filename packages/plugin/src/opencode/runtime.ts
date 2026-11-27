/**
 * OpenCode plugins in DSH. Each plugin runs in its own Bun process
 * (`runtime/opencode-host.mjs`), loaded as OpenCode loads it; its `client`
 * talks to an OpenCode-compatible server served here, backed by DSH's
 * sessions; its hooks are raised where DSH does the same work:
 *
 * | OpenCode | DSH |
 * | --- | --- |
 * | `tool` | a DSH tool per entry, arguments checked by the plugin's own schema |
 * | `chat.message` | `agent/pre-step`, before a prompt enters; parts it adds or changes enter with it |
 * | `chat.params` | `agent/request` (temperature, output tokens) |
 * | `tool.execute.before` / `.after` | `tools/pre-execute` / `tools/post-execute`, in OpenCode's tool names and arguments |
 * | `permission.ask` | `approval/request` |
 * | `shell.env` | the shell tool's environment (through the hooks broker) |
 * | `command.execute.before` | an OpenCode command's prompt before it is submitted |
 * | `experimental.chat.system.transform`, `tool.definition` | `system-prompt/assemble` |
 * | `config` | the plugin's commands added to DSH |
 * | `event` | session, message, part, permission, command, file and compaction events from the session log |
 * @module @kirkchinese/harness-forge/opencode
 */
import type { Context } from '@deepseek-ai/cordis'
import type { CodeComponent, ForeignPlugin } from '@kirkchinese/harness-forge-core'
import type { LoggedEvent } from './convert.js'
import { onDsh, type DshEvent } from '../dsh/host.js'
import { OpenCodeCore } from './runtime/core.js'
import { EventBridge } from './runtime/events.js'
import { PluginMounter } from './runtime/mount.js'
import { OpenCodeServer } from './runtime/server.js'
import type { Agent, Message, OpenCodeMount, OpenCodeRuntimeHost, ToolExec } from './runtime/types.js'

export type { OpenCodeCommand, OpenCodeMount, OpenCodeRuntimeHost } from './runtime/types.js'

/** The OpenCode plugin runtime of one DSH process. */
export class OpenCodeRuntime {
  private readonly core: OpenCodeCore
  private readonly http: OpenCodeServer
  private readonly mounter: PluginMounter
  private readonly bridge: EventBridge

  constructor(private readonly ctx: Context, host: OpenCodeRuntimeHost) {
    this.core = new OpenCodeCore(ctx, host)
    this.http = new OpenCodeServer(this.core)
    this.mounter = new PluginMounter(this.core, this.http)
    this.bridge = new EventBridge(this.core)
  }

  /** Start a plugin's Bun host and register its tools and commands. */
  mount(component: CodeComponent, plugin: ForeignPlugin, options: Record<string, unknown> = {}): Promise<OpenCodeMount> {
    return this.mounter.mount(component, plugin, options)
  }

  /** Evidence: the commands a plugin's `config` hook added, under their DSH names, with the templates the hook gave them. */
  recordAddedCommands(componentId: string, commands: ReadonlyArray<{ readonly name: string; readonly foreignName: string; readonly template: string }>): void {
    this.mounter.recordAddedCommands(componentId, commands)
  }

  /** Listen on the host. Returns the disposer. */
  install(): () => Promise<void> {
    const on = (name: DshEvent, listener: unknown, options?: { prepend?: boolean }): (() => void) => onDsh(this.ctx, name, listener as never, { ...options, owner: 'opencode' })
    const disposers = [
      on('agent/created', ((payload: { agent: Agent }) => { this.bridge.sessionCreated(payload.agent) }) as never),
      on('session/event', ((session: { id: string }, event: LoggedEvent) => { this.bridge.sessionEvent(session.id, event) }) as never),
      on('agent/pre-step', ((payload: { agent: Agent; messages: Message[]; signal: AbortSignal }, next: () => Promise<{ kind: string; messages?: Message[] }>) => this.bridge.preStep(payload, next)) as never, { prepend: true }),
      on('agent/request', ((payload: { agent: Agent }, next: () => Promise<Record<string, unknown>>) => this.bridge.request(payload, next)) as never),
      on('tools/pre-execute', ((exec: ToolExec, next: () => Promise<unknown>) => this.bridge.preExecute(exec, next)) as never, { prepend: true }),
      on('tools/post-execute', ((exec: ToolExec, result: { isError: boolean; content?: Array<{ type: string; text?: string }> }, next: () => Promise<{ kind: string; content?: unknown[] }>) => this.bridge.postExecute(exec, result, next)) as never, { prepend: true }),
      on('tools/result', ((exec: ToolExec, result: { isError: boolean }) => { this.bridge.toolResult(exec, result) }) as never),
      on('approval/request', ((request: { agent: Agent; toolName: string; callId?: string; reason?: string }, next: () => Promise<string>) => this.bridge.approval(request, next)) as never, { prepend: true }),
      on('system-prompt/assemble', ((_assembly: unknown, _context: unknown, next: () => Promise<{ sections: Array<{ name: string; text: string }>; tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }> }>) => this.bridge.assemble(next)) as never),
    ]
    return async () => {
      for (const dispose of disposers) dispose()
      // A turn's last events (session.idle, session.updated) may still be on their way to the plugins: deliver what is
      // queued before the hosts stop, at most two seconds.
      await Promise.race([
        Promise.allSettled([...this.core.hosts.values()].map(plugin => plugin.events)),
        new Promise<void>(resolve => setTimeout(resolve, 2000).unref()),
      ])
      for (const plugin of this.core.hosts.values()) plugin.stopping = true
      for (const stream of this.core.streams) stream.end()
      this.core.streams.clear()
      // Stop the hosts and let them exit (at most three seconds): an exited host holds no file of its plugin.
      await Promise.all([...this.core.hosts.values()].map(plugin => new Promise<void>((resolve) => {
        if (plugin.child.exitCode !== null || plugin.child.signalCode !== null) return resolve()
        const timer = setTimeout(resolve, 3000).unref()
        plugin.child.once('exit', () => { clearTimeout(timer); resolve() })
        plugin.child.kill()
      })))
      this.core.hosts.clear()
      this.http.server?.close()
    }
  }

  /** `shell.env`: the variables plugins add to a shell call's environment. */
  shellEnv(exec: ToolExec): Promise<Record<string, string>> {
    return this.bridge.shellEnv(exec)
  }

  /**
   * `command.execute.before` for an OpenCode command about to be submitted:
   * the plugin sees the command and the parts of its prompt, and may change them.
   */
  beforeCommand(agent: Agent, command: { name: string; args: string }, prompt: string): Promise<string[] | { stopped: string }> {
    return this.bridge.beforeCommand(agent, command, prompt)
  }
}
