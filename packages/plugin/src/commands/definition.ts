/**
 * Foreign Markdown commands as DSH commands. Invoking one renders its body the
 * way Claude Code does (arguments, path variables, shell injection, `@` files),
 * fires `UserPromptExpansion` hooks, and submits the result as the user's next
 * message. Commands stay out of the model's tool list, as in Claude Code.
 * @module @kirkchinese/harness-forge
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { CommandDefinition, CommandInvocation } from '@deepseek-ai/dsh-commands'
import { toolList, type CommandComponent } from '@kirkchinese/harness-forge-core'
import type { FrontmatterHooks, HooksApi } from '../forge/contract.js'
import { untrustedShell, type TrustCheck } from '../forge/trust.js'
import type { ForeignShell } from '../hooks/shell.js'
import { directivesOf, type InvocationSpec, type Invocations } from '../shared/invocation.js'
import { renderBody, renderCodexPrompt, withAttachments } from '../shared/render.js'

/** Host services a command needs while it runs. */
export interface CommandHost {
  readonly shell: ForeignShell
  /** The hooks row, while it runs. */
  hooks(): HooksApi | undefined
  readonly invocations?: Invocations
  directory(agent: CommandInvocation['agent'], signal: AbortSignal): Promise<string>
  observe(componentId: string, ok: boolean, detail: string): void
  /** A project's command runs shell lines only while its workspace is trusted, checked each time it renders. */
  readonly trust?: TrustCheck
  /** OpenCode's `command.execute.before`: the prompt's parts as plugins leave them. */
  beforeSubmit?(agent: CommandInvocation['agent'], command: { name: string; args: string }, prompt: string): Promise<string[] | { stopped: string }>
}

/** The plugin facts a command body may reference. */
export interface CommandOrigin {
  readonly pluginRoot: string
  readonly dataDir: string
  /** The command's name in its own harness (`plugin:command`), for hook matchers. */
  readonly foreignName?: string
  readonly pluginId?: string
  /** The command's frontmatter `hooks`: they run for the rest of the session once it is invoked, as a skill's do. */
  readonly hooks?: FrontmatterHooks
  /** Whose command this is, for what `@file` may attach (default: an installed plugin's). */
  readonly scope?: 'user' | 'project' | 'plugin'
  /** A project's command: the project directory, whose workspace must be trusted for its shell lines to run. */
  readonly projectRoot?: string
}

/** Build the DSH command for one foreign command. */
export function commandDefinition(component: CommandComponent, name: string, origin: CommandOrigin, host: CommandHost): CommandDefinition {
  const hint = typeof component.frontmatter['argument-hint'] === 'string' && component.frontmatter['argument-hint'].trim().length > 0
    ? component.frontmatter['argument-hint']
    : undefined
  const description = component.description !== undefined && component.description.trim().length > 0
    ? component.description.trim()
    : `Command from ${component.path ?? component.name}`
  return {
    name,
    description,
    ...(hint !== undefined ? { input: { hint } } : {}),
    handler: async (invocation: CommandInvocation) => {
      let selected = false
      let submitted = false
      let spec: InvocationSpec | undefined
      try {
        const cwd = await host.directory(invocation.agent, invocation.signal)
        const trust = origin.projectRoot !== undefined ? host.trust?.(origin.projectRoot) : undefined
        const rendered = component.syntax === 'codex' ? renderCodexPrompt(component.body, invocation.rawInput) : await renderBody(component.body, {
          rawArguments: invocation.rawInput,
          argumentNames: toolList(component.frontmatter['arguments']) ?? [],
          cwd,
          pluginRoot: origin.pluginRoot,
          dataDir: origin.dataDir,
          sessionId: invocation.agent.session.header.id,
          shell: host.shell,
          scope: origin.scope ?? 'plugin',
          ...(trust !== undefined && !trust.trusted ? { refuseShell: untrustedShell(trust.workspace) } : {}),
          ...(typeof component.frontmatter['shell'] === 'string' ? { shellKind: component.frontmatter['shell'] } : {}),
          signal: invocation.signal,
        })
        const prompt = withAttachments(rendered)
        if (prompt.length === 0) return { kind: 'error', text: `/${name} has an empty body` }
        const expansion: { blocked?: string; context: string[] } = await (host.hooks()?.expandCommand(invocation.agent as never, {
          name,
          foreignName: origin.foreignName ?? name,
          args: invocation.rawInput.trim(),
          expanded: [prompt].join(''),
        }, invocation.signal) ?? { context: [] })
        if (expansion.blocked !== undefined) {
          host.observe(component.id, true, 'blocked by a prompt hook')
          return { kind: 'error', text: expansion.blocked }
        }
        if (origin.hooks !== undefined) host.hooks()?.add({ ...origin.hooks, origin: 'skill', sessionId: invocation.agent.session.header.id })
        spec = {
          name,
          kind: 'command',
          pluginId: origin.pluginId ?? '',
          componentId: component.id,
          frontmatter: component.frontmatter,
          places: { pluginRoot: origin.pluginRoot, dataDir: origin.dataDir },
        }
        const directives = directivesOf(component.frontmatter)
        if (directives.fork !== undefined && host.invocations !== undefined) {
          // `context: fork`: the prompt is the task of a forked agent, not a message of this conversation.
          const result = await host.invocations.fork(invocation.agent as never, spec, directives, [prompt, ...expansion.context].join('\n\n'), invocation.signal)
          host.observe(component.id, true, 'ran in a forked agent')
          if (directives.fork.background) return { kind: 'success', text: result }
          invocation.agent.followup(createUserMessage({
            content: [{ type: 'text', text: `<skill-result name="${name}">\n${result}\n</skill-result>` }],
            source: { kind: 'user' },
          }))
          return { kind: 'success' }
        }
        // The route is selected before the prompt is submitted (a step's route is fixed before it runs); the
        // frontmatter's grants are queued only once the prompt is actually submitted.
        selected = true
        await host.invocations?.preselect(invocation.agent as never, spec, invocation.signal)
        const parts = host.beforeSubmit === undefined ? [prompt] : await host.beforeSubmit(invocation.agent, { name: origin.foreignName ?? name, args: invocation.rawInput.trim() }, prompt)
        if (!Array.isArray(parts)) {
          host.invocations?.release(invocation.agent.session.header.id)
          host.observe(component.id, true, `handled by a plugin: ${parts.stopped}`)
          return { kind: 'success', text: parts.stopped }
        }
        host.invocations?.queue(invocation.agent.session.header.id, spec)
        invocation.agent.followup(createUserMessage({
          content: [...parts, ...expansion.context].map(text => ({ type: 'text' as const, text })),
          source: { kind: 'user' },
        }))
        submitted = true
        host.observe(component.id, true, `submitted${rendered.commands > 0 ? ` after ${rendered.commands} shell command(s)` : ''}`)
        return { kind: 'success' }
      } catch (error: unknown) {
        // Nothing reached the conversation: no route or grant of this command waits for an unrelated turn.
        if (selected && !submitted && spec !== undefined) {
          const sessionId = invocation.agent.session.header.id
          host.invocations?.unqueue(sessionId, spec)
          host.invocations?.release(sessionId)
        }
        const message = error instanceof Error ? error.message : String(error)
        host.observe(component.id, false, message)
        return { kind: 'error', text: `/${name} failed: ${message}` }
      }
    },
  }
}
