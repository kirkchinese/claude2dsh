/**
 * What a skill's or command's frontmatter asks of the turn that invokes it,
 * as Claude Code applies it (commands and skills share the fields):
 *
 * - `allowed-tools`: allow rules for that turn; deny and ask rules still win.
 *   `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT}`
 *   and `${CLAUDE_PLUGIN_DATA}` expand inside the rules.
 * - `disallowed-tools`: the tools are refused while the skill is active.
 * - `model` / `effort`: the rest of the turn runs on that model and effort.
 *   A value naming no model DSH has (a Claude alias such as `opus`) keeps the
 *   session's model, and the session records why.
 * - `context: fork`: the rendered content runs as the task of a new delegated
 *   agent (`agent` names its type, `general-purpose` by default) and its
 *   result comes back; `background: false` waits for it in the invoking turn,
 *   otherwise the result arrives as a message when the agent finishes.
 *
 * Everything clears when the user sends the next message.
 * @module @kirkchinese/harness-forge
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { booleanValue, toolList } from '@kirkchinese/harness-forge-core'
import { appendNotice } from '../hooks/notice.js'
import { dshService } from '../dsh/host.js'
import { startActivation } from '../dsh/subagents.js'
import { selectRoute } from '../dsh/model-route.js'

/** Where a skill or command lives, for the variables its rules may name. */
export interface InvocationPlaces {
  readonly skillDir?: string
  readonly pluginRoot?: string
  readonly dataDir?: string
}

/** One skill's or command's invocation frontmatter. */
export interface InvocationSpec {
  /** The DSH name: the skill name, or the command name. */
  readonly name: string
  readonly kind: 'skill' | 'command'
  /** The name its own harness invokes it by (`plugin:skill`, or bare for the user's own). */
  readonly foreignName?: string
  /** `plugin`, `user` or `project`, as `UserPromptExpansion` reports `command_source`. */
  readonly source?: string
  readonly pluginId: string
  readonly componentId: string
  readonly frontmatter: Readonly<Record<string, unknown>>
  readonly places: InvocationPlaces
}

/** The parsed directives of a spec. */
export interface Directives {
  readonly allowedTools: readonly string[]
  readonly disallowedTools: readonly string[]
  readonly model?: string
  readonly effort?: string
  readonly fork?: { readonly agent?: string; readonly background: boolean }
}

/** Read the invocation fields of a frontmatter. */
export function directivesOf(frontmatter: Readonly<Record<string, unknown>>): Directives {
  const model = typeof frontmatter['model'] === 'string' && frontmatter['model'].trim().length > 0 ? frontmatter['model'].trim() : undefined
  const effort = typeof frontmatter['effort'] === 'string' && frontmatter['effort'].trim().length > 0 ? frontmatter['effort'].trim().toLowerCase() : undefined
  // OpenCode's `subtask: true` runs a command as a subagent and waits for its answer.
  const subtask = frontmatter['subtask'] === true
  const fork = frontmatter['context'] === 'fork' || subtask
  const agent = typeof frontmatter['agent'] === 'string' && frontmatter['agent'].trim().length > 0 ? frontmatter['agent'].trim() : undefined
  return {
    allowedTools: toolList(frontmatter['allowed-tools'] ?? frontmatter['allowedTools']) ?? [],
    disallowedTools: toolList(frontmatter['disallowed-tools'] ?? frontmatter['disallowedTools']) ?? [],
    ...(model !== undefined && model !== 'inherit' ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(fork ? { fork: { ...(agent !== undefined ? { agent } : {}), background: subtask ? false : booleanValue(frontmatter['background']) !== false } } : {}),
  }
}

/** Expand the path variables a rule may name. */
export function expandRule(rule: string, places: InvocationPlaces & { readonly projectDir: string }): string {
  const posix = (path: string | undefined): string | undefined => path?.replace(/\\/gu, '/')
  return rule.replace(/\$\{(CLAUDE_SKILL_DIR|CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA)\}/gu, (match, name: string) => {
    const value = name === 'CLAUDE_SKILL_DIR' ? posix(places.skillDir)
      : name === 'CLAUDE_PROJECT_DIR' ? posix(places.projectDir)
        : name === 'CLAUDE_PLUGIN_ROOT' ? posix(places.pluginRoot)
          : posix(places.dataDir)
    return value ?? match
  })
}

/** The grants and overrides of one session's current turn. */
interface TurnState {
  allow: string[]
  deny: string[]
  route?: { provider?: string; model?: string; reasoningEffort?: string }
  active: string[]
}

interface AgentLike {
  readonly id?: string
  readonly options?: { readonly provider?: string; readonly model?: string; readonly reasoningEffort?: string }
  readonly session: { readonly header: { readonly id: string; readonly cwd?: string } }
  followup(message: unknown): void
}

interface LlmLike {
  listProviders(): ReadonlyArray<{ readonly id: string }>
  listModels(provider: string): Promise<ReadonlyArray<{ readonly id: string; readonly name: string }>>
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ readonly reasoning?: { readonly efforts: ReadonlyArray<{ readonly id: string; readonly name: string }> } }>
}

/** Claude effort levels, least to greatest. */
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/** Per-session invocation state of foreign skills and commands. */
export class Invocations {
  private readonly specs = new Map<string, InvocationSpec>()
  private readonly turns = new Map<string, TurnState>()
  private readonly pending = new Map<string, InvocationSpec[]>()

  /**
   * A command submitted its prompt: its frontmatter takes effect in the turn
   * that prompt starts, after that turn clears the previous grants.
   */
  queue(sessionId: string, spec: InvocationSpec): void {
    this.pending.set(sessionId, [...this.pending.get(sessionId) ?? [], spec])
  }

  /** Withdraw a spec queued for a session's next turn (its prompt was not submitted after all). */
  unqueue(sessionId: string, spec: InvocationSpec): void {
    const left = (this.pending.get(sessionId) ?? []).filter(queued => queued !== spec)
    if (left.length > 0) this.pending.set(sessionId, left)
    else this.pending.delete(sessionId)
  }

  /** Take the specs queued for a session's next turn. */
  takeQueued(sessionId: string): InvocationSpec[] {
    const specs = this.pending.get(sessionId) ?? []
    this.pending.delete(sessionId)
    return specs
  }

  /**
   * @param presetOf - the DSH preset of a foreign agent name, for `agent`.
   * @param directory - the session's working directory.
   */
  constructor(
    private readonly ctx: Context,
    private readonly presetOf: (foreignName: string) => string | undefined,
    private readonly directory: (agent: AgentLike, signal: AbortSignal) => Promise<string>,
  ) {}

  /** Make a skill's frontmatter take effect when the skill is invoked. Returns the withdrawal. */
  registerSkill(spec: InvocationSpec): () => void {
    this.specs.set(spec.name, spec)
    return () => { if (this.specs.get(spec.name) === spec) this.specs.delete(spec.name) }
  }

  /** The registered spec of a skill name. */
  skill(name: string): InvocationSpec | undefined {
    return this.specs.get(name)
  }

  /** The turn's tool grants of a session, as allow and deny rules. */
  rules(sessionId: string): { allow: readonly string[]; deny: readonly string[] } {
    const turn = this.turns.get(sessionId)
    return { allow: turn?.allow ?? [], deny: turn?.deny ?? [] }
  }

  /** The skills and commands active in a session's turn. */
  active(sessionId: string): readonly string[] {
    return this.turns.get(sessionId)?.active ?? []
  }

  /** The user sent a new message: grants and overrides end. */
  clear(sessionId: string): void {
    this.turns.delete(sessionId)
  }

  /**
   * DSH 0.2.2 fixes a step's route before `agent/pre-step`, so a route is selected on the agent ahead of the step
   * that must run on it: a typed command's or skill's when the line is dispatched (its turn has not begun), a
   * model-invoked skill's during the step that loads it. The route the agent had is put back when that turn ends.
   */
  private readonly selected = new Map<string, { restore(): void; armed: boolean }>()

  private applyRoute(agent: AgentLike, route: NonNullable<TurnState['route']>, armed: boolean): void {
    const sessionId = agent.session.header.id
    const held = this.selected.get(sessionId)
    const selection = selectRoute(agent, route)
    if (held !== undefined) {
      held.armed ||= armed
      return
    }
    if (selection !== undefined) this.selected.set(sessionId, { restore: selection.restore, armed })
  }

  /** A typed command or skill line is about to run: its frontmatter route is selected for the turn it starts. */
  async preselect(agent: AgentLike, spec: InvocationSpec, signal: AbortSignal): Promise<void> {
    const directives = directivesOf(spec.frontmatter)
    if (directives.fork !== undefined || (directives.model === undefined && directives.effort === undefined)) return
    const route = await this.route(agent, directives, signal)
    if (route.route !== undefined) this.applyRoute(agent, route.route, false)
  }

  /** A session's turn started: a route selected ahead of it now belongs to it. */
  turnStarted(sessionId: string): void {
    const held = this.selected.get(sessionId)
    if (held !== undefined) held.armed = true
  }

  /**
   * A session's turn ended: the route it ran on is put back. Called from a `session/event` listener, which runs
   * while DSH publishes the event and may not append (selecting a route appends `model/selection`), so the
   * selection is put back right after; the next step reads the route only later.
   */
  turnEnded(sessionId: string): void {
    const held = this.selected.get(sessionId)
    if (held === undefined || !held.armed) return
    this.selected.delete(sessionId)
    queueMicrotask(() => {
      try {
        held.restore()
      } catch {
        // The session no longer takes records (closed or taken out of its store meanwhile).
      }
    })
  }

  /** A typed line was answered without starting a turn: the route it selected is put back now. */
  release(sessionId: string): void {
    const held = this.selected.get(sessionId)
    if (held === undefined || held.armed) return
    this.selected.delete(sessionId)
    held.restore()
  }

  /** Apply a spec's grants and overrides to the agent's current turn. */
  async activate(agent: AgentLike, spec: InvocationSpec, signal: AbortSignal): Promise<Directives> {
    const directives = directivesOf(spec.frontmatter)
    const sessionId = agent.session.header.id
    const turn = this.turns.get(sessionId) ?? { allow: [], deny: [], active: [] }
    // A forked skill's tool grants belong to its forked agent (see `fork`).
    if (directives.fork === undefined) {
      const rules = await this.expandedRules(agent, spec, directives, signal)
      turn.allow.push(...rules.allow)
      turn.deny.push(...rules.deny)
    }
    turn.active.push(spec.name)
      // With `context: fork` the model and effort belong to the forked agent.
    if (directives.fork === undefined && (directives.model !== undefined || directives.effort !== undefined)) {
      const route = await this.route(agent, directives, signal)
      if (route.route !== undefined) {
        turn.route = { ...turn.route, ...route.route }
        // DSH 0.2.2: selected on the agent for the turn's next steps (a typed line's was already, see `preselect`).
        this.applyRoute(agent, route.route, true)
      }
      if (route.note !== undefined) appendNotice(agent.session, { kind: 'feedback', event: 'SkillInvocation', subject: spec.name, plugin: spec.pluginId, text: route.note })
    }
    this.turns.set(sessionId, turn)
    return directives
  }

  /**
   * Run rendered content in a forked agent. With `background`, return at once
   * and deliver the result to the parent when the agent finishes.
   * @returns the result text, or the launch note in the background case.
   */
  async fork(agent: AgentLike, spec: InvocationSpec, directives: Directives, content: string, signal: AbortSignal): Promise<string> {
    const subagents = dshService(this.ctx, 'subagents')
    if (subagents === undefined) throw new Error(`/${spec.name} runs in a forked agent (context: fork), and this DSH profile composes no subagent runtime`)
    const foreignAgent = directives.fork?.agent
    const preset = foreignAgent === undefined || /^(general-purpose|Explore|Plan)$/u.test(foreignAgent) ? undefined : this.presetOf(foreignAgent)
    const background = directives.fork?.background !== false
    // The forked agent runs with the skill's model and effort (start options, which every DSH release takes) and its tool grants.
    const route = directives.model !== undefined || directives.effort !== undefined ? await this.route(agent, directives, signal) : {}
    const activation = await startActivation(subagents, {
      parent: agent,
      prompt: [{ type: 'text', text: content }],
      ...(preset !== undefined ? { agentPreset: preset } : {}),
      ...(route.route !== undefined ? { agentOptions: route.route } : {}),
    }, { provider: 'spawn', label: `${spec.name} (forked skill)`, signal: background ? AbortSignal.timeout(3_600_000) : signal, delivery: 'caller' })
    if (activation.childId !== undefined) {
      const rules = await this.expandedRules(agent, spec, directives, signal)
      this.turns.set(activation.childId, { allow: rules.allow, deny: rules.deny, ...(route.route !== undefined ? { route: route.route } : {}), active: [spec.name] })
    }
    const text = async (): Promise<string> => {
      const result = await activation.result
      return (result.output ?? []).map(block => block.type === 'text' ? block.text ?? '' : '').join('').trim()
    }
    if (!background) return text()
    void text().then((output) => {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: `<skill-result name="${spec.name}">\n${output.length > 0 ? output : '(the forked agent returned no text)'}\n</skill-result>` }],
        source: { kind: 'user' },
      }))
    }).catch((error: unknown) => {
      appendNotice(agent.session, { kind: 'hook-error', event: 'SkillInvocation', subject: spec.name, plugin: spec.pluginId, text: `the forked agent of ${spec.name} failed: ${error instanceof Error ? error.message : String(error)}` })
    })
    return `Skill ${spec.name} is running in a forked ${foreignAgent ?? 'general-purpose'} agent in the background. Its result will arrive as a message when it finishes; continue with other work meanwhile.`
  }

  private async expandedRules(agent: AgentLike, spec: InvocationSpec, directives: Directives, signal: AbortSignal): Promise<{ allow: string[]; deny: string[] }> {
    const projectDir = await this.directory(agent, signal).catch(() => agent.session.header.cwd ?? process.cwd())
    return {
      allow: directives.allowedTools.map(rule => expandRule(rule, { ...spec.places, projectDir })),
      deny: directives.disallowedTools.map(rule => expandRule(rule, { ...spec.places, projectDir })),
    }
  }



  /**
   * Resolve a frontmatter `model` and `effort` to a DSH route: an exact
   * `provider/model`, a model id or name one provider lists (the current
   * provider first), and an effort the model offers by name or, failing that,
   * by rank.
   */
  private route(agent: AgentLike, directives: Directives, signal: AbortSignal): Promise<RouteResolution> {
    return resolveRoute(this.ctx, agent.options ?? {}, directives.model, directives.effort, signal)
  }
}

/** A requested model and effort resolved against what DSH serves. */
export interface RouteResolution {
  readonly route?: { provider?: string; model?: string; reasoningEffort?: string }
  /** Why a requested value was not applied. */
  readonly note?: string
}

/**
 * Resolve a Claude `model` and `effort` to a DSH route: an exact
 * `provider/model`, else a model id or name one provider lists (the current
 * provider first); an effort the model offers by id or name, else by rank
 * among Claude's `low`…`max`. `inherit` keeps the current model.
 */
export async function resolveRoute(
  ctx: Context,
  current: { readonly provider?: string; readonly model?: string },
  wantedModel: string | undefined,
  wantedEffort: string | undefined,
  signal: AbortSignal,
): Promise<RouteResolution> {
  const llm = dshService(ctx, 'llm') as LlmLike | undefined
  if (llm === undefined) return {}
  let provider = current.provider
  let model = current.model
  const notes: string[] = []
  if (wantedModel !== undefined && wantedModel !== 'inherit') {
    const found = await findModel(llm, wantedModel, current.provider)
    const family = found === undefined ? claudeFamily(wantedModel) : undefined
    // A Claude alias runs on the model the person mapped it to, else on the session's model.
    const mapped = family === undefined ? undefined : modelAliases[family]
    const routed = mapped === undefined ? undefined : await findModel(llm, mapped, current.provider)
    if (found !== undefined) {
      provider = found.provider
      model = found.model
    } else if (routed !== undefined) {
      provider = routed.provider
      model = routed.model
      notes.push(`model "${wantedModel}" runs on ${routed.provider}/${routed.model} (modelAliases.${family ?? ''})`)
    } else if (family !== undefined) {
      notes.push(`model "${wantedModel}" is Claude's ${family}; it runs on ${current.model ?? 'the session model'}${mapped !== undefined ? ` (modelAliases.${family} names no served model)` : ''}`)
    } else {
      notes.push(`model "${wantedModel}" names no model this DSH profile serves; ${current.model ?? 'the session model'} is kept`)
    }
  }
  let reasoningEffort: string | undefined
  const effort = wantedEffort?.toLowerCase()
  if (effort !== undefined && provider !== undefined && model !== undefined) {
    const info = await llm.resolveModelInfo(provider, model, signal).catch(() => undefined)
    const efforts = info?.reasoning?.efforts ?? []
    const exact = efforts.find(item => item.id.toLowerCase() === effort || item.name.toLowerCase() === effort)
    const rank = CLAUDE_EFFORTS.indexOf(effort)
    const ranked = exact ?? (rank >= 0 && efforts.length > 0 ? efforts[Math.round(rank / (CLAUDE_EFFORTS.length - 1) * (efforts.length - 1))] : undefined)
    if (ranked !== undefined) reasoningEffort = ranked.id
    else notes.push(`effort "${effort}" is not offered by ${model}; its effort is kept`)
  }
  const changed = (provider !== current.provider || model !== current.model) || reasoningEffort !== undefined
  return {
    ...(changed ? { route: { ...(provider !== undefined ? { provider } : {}), ...(model !== undefined ? { model } : {}), ...(reasoningEffort !== undefined ? { reasoningEffort } : {}) } } : {}),
    ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
  }
}

/** The Claude family a `model` value names: an alias (`haiku`, `sonnet`, `opus`, `opusplan`) or a `claude-…` id. */
export function claudeFamily(wanted: string): ClaudeFamily | undefined {
  const lower = wanted.trim().toLowerCase()
  if (!/^(?:haiku|sonnet|opus|opusplan)(?:\[1m\])?$|^claude-/u.test(lower)) return undefined
  if (lower.includes('haiku')) return 'haiku'
  if (lower.includes('opus')) return 'opus'
  if (lower.includes('sonnet')) return 'sonnet'
  return undefined
}

export type ClaudeFamily = 'haiku' | 'sonnet' | 'opus'

let modelAliases: Readonly<Partial<Record<ClaudeFamily, string>>> = {}

/** The person's mapping of Claude aliases to served models (Harness Forge's `modelAliases` config). */
export function setModelAliases(aliases: Readonly<Partial<Record<ClaudeFamily, string>>> | undefined): void {
  modelAliases = aliases ?? {}
}

async function findModel(llm: LlmLike, wanted: string, preferred: string | undefined): Promise<{ provider: string; model: string } | undefined> {
  const providers = llm.listProviders().map(provider => provider.id)
  const slash = wanted.indexOf('/')
  if (slash > 0 && providers.includes(wanted.slice(0, slash))) return { provider: wanted.slice(0, slash), model: wanted.slice(slash + 1) }
  const order = preferred !== undefined && providers.includes(preferred) ? [preferred, ...providers.filter(id => id !== preferred)] : providers
  const lower = wanted.toLowerCase()
  for (const provider of order) {
    const models = await llm.listModels(provider).catch(() => [])
    const match = models.find(model => model.id.toLowerCase() === lower || model.name.toLowerCase() === lower)
    if (match !== undefined) return { provider, model: match.id }
  }
  return undefined
}
