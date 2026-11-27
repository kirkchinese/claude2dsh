/**
 * The skills row: imported `SKILL.md` bundles served zero-copy through one
 * DSH skill provider, their frontmatter taking effect when a skill is invoked
 * (`allowed-tools`, `model`, `context: fork`, arguments of a typed `/skill`),
 * and the hooks a skill's frontmatter declares, which the hooks row runs.
 * @module @kirkchinese/harness-forge/skills
 */
import { isAbsolute, join, dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { renderSkillContent } from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-skill'
import { HarnessError } from '@kirkchinese/harness-forge-core'
import { onDsh } from '../dsh/host.js'
import type { Disposer, FrontmatterHooks, SkillsApi } from '../forge/contract.js'
import { skillRootOf } from '../forge/ledger.js'
import { FORGE_SERVICE, type HarnessForge } from '../forge/service.js'
import { hookSource, parseHookTable } from '../hooks/config.js'
import { appendNotice } from '../hooks/notice.js'
import { isOwnAssets, projectRootOf, templateScope } from '../mcp/mount.js'
import { ForeignSkillProvider } from './provider.js'
import { messageOf } from '../shared/util.js'
import { mounted, Parts, rowEffect } from '../forge/row.js'

/** The skills row's configuration. */
export interface Config {
  /**
   * Directories the person names: every foreign `SKILL.md` bundle in them is
   * served, without import or review. An imported plugin's skills are served
   * one by one instead, only those mounted.
   */
  skillRoots?: string[]
}

export const Config = z.object({
  skillRoots: z.array(z.string()),
}) as unknown as z<Config>

export const name = 'harness-forge-skills'
export const inject = [FORGE_SERVICE, 'skills']

/** The skills row. */
export function apply(ctx: Context, config: Config = {}): void {
  rowEffect(ctx, 'skills', forge => startSkills(ctx, forge, config))
}

/** The agent facts skill invocation uses. */
interface InvocationAgent {
  readonly session: { readonly header: { readonly id: string; readonly cwd?: string; readonly delegationDepth?: number } }
}

/** A user message of a step batch. */
interface MessageLike {
  readonly source?: { readonly kind?: string; readonly name?: unknown }
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>
}

/** The `skill` tool's dispatch result. */
interface SkillToolResult {
  readonly isError: boolean
  readonly value?: { readonly name: string; readonly provider: string; readonly content: string; readonly resourceBase?: unknown }
  readonly content?: unknown
}

function textOf(message: MessageLike): string {
  return message.content.map(block => block.type === 'text' ? block.text ?? '' : '').join('')
}

/** The arguments after a `/name` gesture in what the user typed. */
export function gestureArguments(typed: string, name: string): string {
  const match = new RegExp(`(?:^|\\s)/${name.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&')}(?=\\s|$)([^\\n]*)`, 'u').exec(typed)
  return match?.[1]?.trim() ?? ''
}

/**
 * Put a body rendered with the gesture's arguments in place of the one the
 * host rendered without them, keeping the host's header lines.
 */
function replaceBody(injected: string, body: string): string {
  const headerEnd = injected.indexOf('\n\n')
  return headerEnd === -1 ? body : `${injected.slice(0, headerEnd)}\n\n${body}`
}

/** Start the skills row on the shared service. Returns its teardown. */
export function startSkills(ctx: Context, forge: HarnessForge, config: Config): Disposer {
  /** Files each session has worked with, for skills with `paths`. */
  const worked = new Map<string, Set<string>>()
  /** The component of each skill body, for its load evidence. */
  const bodies = new Map<string, string>()
  const skillHooks = new Map<string, FrontmatterHooks>()
  const provider = new ForeignSkillProvider(forge.shell, (bodyPath) => {
    const componentId = bodies.get(bodyPath)
    if (componentId !== undefined) forge.observe(componentId, 'skill-load', true, 'loaded by the model')
  }, sessionId => worked.get(sessionId) ?? new Set(), dir => forge.projects.trust.state(dir))
  const invocations = forge.invocations
  const directory = (agent: unknown, signal: AbortSignal): Promise<string> => forge.directory(agent, signal)

  /**
   * A skill the user invoked with `/name args` is rendered with its arguments
   * and takes effect (a `context: fork` skill runs in a forked agent instead of
   * entering the conversation). Prepended so it sees the skill tool's own injection.
   */
  const preStep = async (payload: { agent: InvocationAgent; messages: readonly MessageLike[]; signal: AbortSignal }, next: () => Promise<{ kind: string; messages?: MessageLike[] }>): Promise<unknown> => {
    const { agent, messages, signal } = payload
    const sessionId = agent.session.header.id
    const decision = await next()
    if (decision.kind === 'reject' || decision.messages === undefined) return decision
    const typed = messages.filter(message => message.source?.kind === 'user').map(textOf).join('\n')
    const out: MessageLike[] = []
    for (const message of decision.messages) {
      const name = message.source?.kind === 'skill-invocation' ? message.source.name : undefined
      const spec = typeof name === 'string' ? invocations.skill(name) : undefined
      if (typeof name === 'string') {
        // `UserPromptExpansion` sees every skill the user typed, ours or DSH's own.
        const expansion = await forge.lookup('hooks')?.expandSkill(agent, {
          name,
          foreignName: spec?.foreignName ?? name,
          args: gestureArguments(typed, name),
          source: spec?.source ?? 'user',
        }, signal)
        if (expansion?.blocked !== undefined) {
          appendNotice(agent.session, { kind: 'blocked', event: 'UserPromptExpansion', subject: name, plugin: spec?.pluginId ?? 'harness-forge', text: expansion.blocked })
          continue
        }
        for (const text of expansion?.context ?? []) out.push({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
      }
      if (spec === undefined || spec.places.skillDir === undefined) {
        out.push(message)
        continue
      }
      try {
        const rawArguments = gestureArguments(typed, spec.name)
        const cwd = await directory(agent, signal).catch(() => agent.session.header.cwd ?? process.cwd())
        const body = await provider.renderFor(join(spec.places.skillDir, 'SKILL.md'), rawArguments, cwd, sessionId, signal).catch(() => undefined)
        const directives = await invocations.activate(agent as never, spec, signal)
        const rendered = body ?? textOf(message)
        if (directives.fork !== undefined) {
          const result = await invocations.fork(agent as never, spec, directives, rendered, signal).catch((error: unknown) => `Skill ${spec.name} could not start its forked agent: ${messageOf(error)}`)
          out.push({ ...message, content: [{ type: 'text', text: `<skill-result name="${spec.name}">\n${result}\n</skill-result>` }] })
        } else {
          out.push(body === undefined ? message : { ...message, content: [{ type: 'text', text: replaceBody(textOf(message), body) }] })
        }
      } catch (error: unknown) {
        // The skill still reaches the model as the host injected it.
        out.push(message)
        appendNotice(agent.session, { kind: 'hook-error', event: 'SkillInvocation', subject: spec.name, plugin: spec.pluginId, text: `frontmatter of ${spec.name} not applied: ${messageOf(error)}` })
      }
    }
    return { ...decision, messages: out }
  }

  /** A model-invoked skill takes effect; a `context: fork` skill answers with its forked agent's result. */
  const executeSkill = async (exec: { name: string; arguments: unknown; agent?: InvocationAgent; signal: AbortSignal }, next: () => Promise<SkillToolResult>): Promise<SkillToolResult> => {
    const result = await next()
    const name = (exec.arguments as { name?: unknown } | undefined)?.name
    const spec = typeof name === 'string' ? invocations.skill(name) : undefined
    if (exec.name !== 'skill' || result.isError || exec.agent === undefined || spec === undefined) return result
    const directives = await invocations.activate(exec.agent as never, spec, exec.signal)
    if (directives.fork === undefined || result.value === undefined) return result
    const output = await invocations.fork(exec.agent as never, spec, directives, result.value.content, exec.signal)
    const value = { ...result.value, content: output }
    return { isError: false, value, content: [{ type: 'text', text: renderSkillContent(value as never) }] }
  }

  /** Remember the files a session reads or writes. */
  const noteFile = (exec: { name: string; arguments: unknown; agent?: InvocationAgent }): void => {
    if (exec.agent === undefined || !['read', 'read_image', 'write', 'edit'].includes(exec.name)) return
    const path = (exec.arguments as { file_path?: unknown; path?: unknown } | undefined)?.file_path ?? (exec.arguments as { path?: unknown } | undefined)?.path
    if (typeof path !== 'string') return
    const id = exec.agent.session.header.id
    const files = worked.get(id) ?? new Set<string>()
    const absolute = isAbsolute(path) ? path : join(exec.agent.session.header.cwd ?? process.cwd(), path)
    if (files.has(absolute)) return
    files.add(absolute)
    worked.set(id, files)
    provider.refresh()
  }

  const api: SkillsApi = {
    skillHooks: name => skillHooks.get(name),
    reload: () => { provider.refresh() },
    // The configured roots, and the directories of the skills mounted one by one.
    roots: () => [...new Set([...provider.listRoots(), ...provider.listSkills().map(skillRootOf)])].sort((a, b) => a.localeCompare(b, 'en')),
  }

  const parts = new Parts(ctx, forge, 'skills')
  parts.add('skill provider', () => ctx.skills.registerProvider((control) => {
    provider.attach(control)
    provider.addRoots(config.skillRoots ?? [])
    return provider
  }))
  parts.add('typed skills', () => onDsh(ctx, 'agent/pre-step', preStep as never, { prepend: true, owner: 'skills' }))
  parts.add('skill tool', () => onDsh(ctx, 'tools/execute', ((exec: { name: string; arguments: unknown; agent?: InvocationAgent; signal: AbortSignal }, next: () => Promise<SkillToolResult>) => exec.name === 'skill' ? executeSkill(exec, next) : next()) as never, { owner: 'skills' }))
  parts.add('worked files', () => onDsh(ctx, 'tools/post-execute', ((exec: { name: string; arguments: unknown; agent?: InvocationAgent }, result: { isError: boolean }, next: () => unknown) => {
    if (!result.isError) noteFile(exec)
    return next()
  }) as never, { owner: 'skills' }))
  parts.add('skill mounter', () => forge.registerMounter('skill', {
    mount: async ({ component, plugin, dataDir }) => {
      if (component.kind !== 'skill') throw new HarnessError('component-failed', `action expects a skill: ${component.id}`)
      const projectRoot = projectRootOf(plugin)
      const releaseSkill = provider.addSkill(component.bodyPath, { pluginRoot: plugin.root, pluginName: plugin.name, dataDir, scope: templateScope(plugin), ...(projectRoot !== undefined ? { projectRoot } : {}) })
      bodies.set(component.bodyPath, component.id)
      const hooks = component.frontmatter.raw['hooks']
      const name = component.frontmatter.name
      const source = hooks === undefined ? undefined : hookSource(component.id, plugin, dataDir, parseHookTable(hooks), 'skill')
      if (source !== undefined) skillHooks.set(name, source)
      // `allowed-tools`, `model`, `effort`, `context: fork` take effect when the skill is invoked.
      const withdrawInvocation = invocations.registerSkill({
        name,
        kind: 'skill',
        foreignName: isOwnAssets(plugin) ? name : `${plugin.name}:${name}`,
        source: isOwnAssets(plugin) ? String(plugin.manifest['scope']) : 'plugin',
        pluginId: plugin.id,
        componentId: component.id,
        frontmatter: component.frontmatter.raw,
        places: { skillDir: dirname(component.bodyPath), ...(isOwnAssets(plugin) ? {} : { pluginRoot: plugin.root, dataDir }) },
      })
      return {
        outcome: mounted(component, 'L1a', name),
        disposer: async () => {
          if (bodies.get(component.bodyPath) === component.id) bodies.delete(component.bodyPath)
          if (source !== undefined && skillHooks.get(name) === source) skillHooks.delete(name)
          withdrawInvocation()
          releaseSkill()
        },
      }
    },
  }))
  parts.add('api', () => forge.provide('skills', api))
  return () => parts.dispose()
}
