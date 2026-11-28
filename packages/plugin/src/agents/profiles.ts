/**
 * What an imported agent's frontmatter asks of each run of that agent,
 * beyond its persona and tool list (see `presets.ts`), as Claude Code's
 * sub-agents reference defines it:
 *
 * - `model` / `effort`: the agent's requests run on that route when DSH
 *   serves the model; otherwise the parent's model is kept and the session
 *   records why.
 * - `skills`: the full content of each listed model-invocable skill (first 32
 *   distinct names) enters the agent's context when it starts.
 * - `mcpServers`: inline definitions connect when the agent starts, for that
 *   agent only, and disconnect when it ends; names reuse configured servers.
 * - `maxTurns`: the agent stops after that many model calls and its answer
 *   so far is returned, marked partial.
 * - `memory`: `user` (`~/.claude/agent-memory/<name>/`), `project`
 *   (`.claude/agent-memory/<name>/`) or `local`
 *   (`.claude/agent-memory-local/<name>/`); the agent starts with the memory
 *   instructions and the first 200 lines or 25 KB of `MEMORY.md`.
 * - `isolation: worktree`: the agent runs in a fresh git worktree of the
 *   repository, removed afterwards when the agent changed nothing.
 * - `initialPrompt`: submitted as the first message when the agent's preset
 *   is the session's own (the Web preset picker, Claude's `--agent`).
 * @module @kirkchinese/harness-forge
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { renderSkillContent } from '@deepseek-ai/dsh-skill'
import { kebabCase, leadsToShare, toolList, type McpComponent } from '@kirkchinese/harness-forge-core'
import { appendNotice } from '../hooks/notice.js'
import type { ForeignShell } from '../hooks/shell.js'
import { resolveRoute, type RouteResolution } from '../shared/invocation.js'
import { selectRoute } from '../dsh/model-route.js'
import { mcpServerName, mountMcp, type McpVariables, type RemoteMcpHost } from '../mcp/mount.js'
import { dshService, onDsh, presetOfSession, type DshEvent } from '../dsh/host.js'

/** An imported agent's run-time frontmatter. */
export interface AgentProfile {
  readonly presetId: string
  /** The agent's own name (memory directories use it). */
  readonly name: string
  readonly pluginId: string
  readonly frontmatter: Readonly<Record<string, unknown>>
  readonly vars: McpVariables
}

/** The parsed run-time fields of an agent's frontmatter. */
export interface AgentRuntimeFields {
  readonly model?: string
  readonly effort?: string
  readonly skills: readonly string[]
  readonly mcpServers: ReadonlyArray<{ readonly name: string; readonly config?: Readonly<Record<string, unknown>> }>
  readonly maxTurns?: number
  readonly memory?: 'user' | 'project' | 'local'
  readonly isolation?: 'worktree'
  readonly initialPrompt?: string
}

/** Read the run-time fields of an agent's frontmatter. */
export function agentRuntimeFields(frontmatter: Readonly<Record<string, unknown>>): AgentRuntimeFields {
  const string = (key: string): string | undefined => typeof frontmatter[key] === 'string' && (frontmatter[key] as string).trim().length > 0 ? (frontmatter[key] as string).trim() : undefined
  const model = string('model')
  const effort = string('effort')
  const memory = string('memory')
  const maxTurns = typeof frontmatter['maxTurns'] === 'number' ? frontmatter['maxTurns'] : Number(string('maxTurns') ?? Number.NaN)
  const initialPrompt = string('initialPrompt')
  const servers: Array<{ name: string; config?: Record<string, unknown> }> = []
  const raw = frontmatter['mcpServers']
  const entries = Array.isArray(raw) ? raw : raw !== null && typeof raw === 'object' ? [raw] : typeof raw === 'string' ? toolList(raw) ?? [] : []
  for (const entry of entries) {
    if (typeof entry === 'string') servers.push({ name: entry })
    else if (entry !== null && typeof entry === 'object') {
      for (const [name, config] of Object.entries(entry as Record<string, unknown>)) {
        if (config !== null && typeof config === 'object') servers.push({ name, config: config as Record<string, unknown> })
      }
    }
  }
  return {
    ...(model !== undefined && model !== 'inherit' ? { model } : {}),
    ...(effort !== undefined ? { effort: effort.toLowerCase() } : {}),
    skills: [...new Set(toolList(frontmatter['skills']) ?? [])].slice(0, 32),
    mcpServers: servers,
    ...(Number.isInteger(maxTurns) && maxTurns > 0 ? { maxTurns } : {}),
    ...(memory === 'user' || memory === 'project' || memory === 'local' ? { memory } : {}),
    ...(string('isolation') === 'worktree' ? { isolation: 'worktree' as const } : {}),
    ...(initialPrompt !== undefined ? { initialPrompt } : {}),
  }
}

/** The memory directory of an agent for a scope. */
export function agentMemoryDir(scope: 'user' | 'project' | 'local', name: string, projectDir: string, home = homedir()): string {
  if (scope === 'user') return join(home, '.claude', 'agent-memory', name)
  return join(projectDir, '.claude', scope === 'project' ? 'agent-memory' : 'agent-memory-local', name)
}

const MEMORY_LINES = 200
const MEMORY_BYTES = 25 * 1024

/** The memory instructions an agent starts with. */
export function memoryInstructions(dir: string): string {
  const path = join(dir, 'MEMORY.md')
  let excerpt = ''
  let cut = false
  // A project's memory file on a link to a network share it is not on is left unread (see `leadsToShare`).
  if (!leadsToShare(path) && existsSync(path)) {
    const text = readFileSync(path, 'utf8')
    const lines = text.split(/\r?\n/u)
    excerpt = lines.slice(0, MEMORY_LINES).join('\n')
    if (Buffer.byteLength(excerpt) > MEMORY_BYTES) excerpt = Buffer.from(excerpt).subarray(0, MEMORY_BYTES).toString('utf8')
    cut = lines.length > MEMORY_LINES || excerpt.length < text.length
  }
  return [
    '# Agent memory',
    '',
    `You have a persistent memory directory at ${dir}. It survives across conversations: read it before you start, and save what you learn there (codebase patterns, debugging insights, decisions and where things live) with the Read, Write and Edit tools.`,
    '`MEMORY.md` is the index: keep it short, one line per topic, with details in other files of the directory.',
    '',
    excerpt.length > 0 ? `Current MEMORY.md:\n\n${excerpt}` : 'MEMORY.md does not exist yet.',
    ...(cut ? ['', `MEMORY.md is longer than ${String(MEMORY_LINES)} lines or 25 KB; curate it so the index fits.`] : []),
  ].join('\n')
}

interface AgentLike {
  readonly ctx?: unknown
  readonly options?: { readonly provider?: string; readonly model?: string }
  readonly session: { readonly header: { readonly id: string; readonly cwd?: string; readonly delegationDepth?: number; readonly parentSession?: string } }
  inject(message: unknown): void
  followup(message: unknown): void
}

interface RunState {
  readonly presetId: string
  route?: RouteResolution['route']
  steps: number
  readonly disposers: Array<() => Promise<void>>
}

/** Run-time effects of imported agents' frontmatter. */
export class AgentProfiles {
  private readonly profiles = new Map<string, AgentProfile>()
  private readonly runs = new Map<string, RunState>()
  /** Worktrees created for isolated agents, by path. */
  private readonly worktrees = new Map<string, { readonly repo: string; readonly branch: string; readonly base: string }>()

  constructor(
    private readonly ctx: Context,
    private readonly shell: ForeignShell,
    private readonly dataRoot: string,
    private readonly remoteHost: (componentId: string) => RemoteMcpHost,
  ) {}

  register(profile: AgentProfile): () => void {
    this.profiles.set(profile.presetId, profile)
    return () => { if (this.profiles.get(profile.presetId) === profile) this.profiles.delete(profile.presetId) }
  }

  /** The preset of an `agent` tool call that runs an isolated agent, for its worktree. */
  isolated(presetId: unknown): boolean {
    return typeof presetId === 'string' && this.profiles.has(presetId) && agentRuntimeFields(this.profiles.get(presetId)!.frontmatter).isolation === 'worktree'
  }

  /** Listen on the host. Returns the disposer. */
  install(): () => void {
    const on = (name: DshEvent, listener: unknown, options?: { prepend?: boolean }): (() => void) => onDsh(this.ctx, name, listener as never, { ...options, owner: 'agents' })
    const disposers = [
      on('agent/created', ((payload: { agent: AgentLike; signal?: AbortSignal }) => this.created(payload.agent, payload.signal ?? new AbortController().signal)) as never),
      on('agent/pre-step', (async (payload: { agent: AgentLike }, next: () => Promise<{ kind: string }>) => {
        const run = this.runs.get(payload.agent.session.header.id)
        const profile = run === undefined ? undefined : this.profiles.get(run.presetId)
        const maxTurns = profile === undefined ? undefined : agentRuntimeFields(profile.frontmatter).maxTurns
        if (run === undefined || maxTurns === undefined) return next()
        run.steps++
        if (run.steps > maxTurns) {
          appendNotice(payload.agent.session, { kind: 'stopped', event: 'SubagentStop', subject: profile!.name, plugin: profile!.pluginId, text: `${profile!.name} reached maxTurns (${String(maxTurns)}); its output so far is partial` })
          return { kind: 'reject' }
        }
        return next()
      }) as never),
      on('agent/disposed', ((payload: { agent: AgentLike }) => { void this.disposed(payload.agent) }) as never),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }

  private presetOf(agent: AgentLike): string | undefined {
    const value = presetOfSession(this.ctx, agent.session)
    if (value !== undefined) return value
    // Fall back to the composed preset.
    const presets = dshService(this.ctx, 'agentPresets') as { composedPreset?(ctx: unknown): string | undefined } | undefined
    try {
      return presets?.composedPreset?.(agent.ctx)
    } catch {
      return undefined
    }
  }

  private async created(agent: AgentLike, signal: AbortSignal): Promise<void> {
    const presetId = this.presetOf(agent)
    const profile = presetId === undefined ? undefined : this.profiles.get(presetId)
    if (profile === undefined || presetId === undefined) return
    const fields = agentRuntimeFields(profile.frontmatter)
    const depth = agent.session.header.delegationDepth ?? 0
    if (depth === 0) {
      // The session's own agent: Claude's `--agent`.
      if (fields.initialPrompt !== undefined) agent.followup(createUserMessage({ content: [{ type: 'text', text: fields.initialPrompt }], source: { kind: 'user' } }))
      return
    }
    const run: RunState = { presetId, steps: 0, disposers: [] }
    this.runs.set(agent.session.header.id, run)
    const cwd = agent.session.header.cwd ?? process.cwd()
    if (fields.model !== undefined || fields.effort !== undefined) {
      const resolved = await resolveRoute(this.ctx, agent.options ?? {}, fields.model, fields.effort, signal)
      if (resolved.route !== undefined) {
        run.route = resolved.route
        selectRoute(agent, resolved.route)
      }
      if (resolved.note !== undefined) appendNotice(agent.session, { kind: 'feedback', event: 'SubagentStart', subject: profile.name, plugin: profile.pluginId, text: resolved.note })
    }
    for (const server of fields.mcpServers) {
      if (server.config === undefined) continue
      try {
        const component = inlineServer(profile, server.name, server.config)
        const mount = await mountMcp(agent.ctx as Context, component, mcpServerName(server.name), profile.vars, this.remoteHost(component.id), { catalog: false })
        run.disposers.push(mount.dispose)
      } catch (error: unknown) {
        appendNotice(agent.session, { kind: 'hook-error', event: 'SubagentStart', subject: profile.name, plugin: profile.pluginId, text: `MCP server ${server.name} of ${profile.name} did not start: ${error instanceof Error ? error.message : String(error)}` })
      }
    }
    const skills = dshService(this.ctx, 'skills') as { get(name: string, options: Record<string, unknown>): Promise<{ name: string; provider: string; content: string; invocation?: { modelInvocable?: boolean } } | undefined> } | undefined
    for (const name of fields.skills) {
      const skill = await skills?.get(kebabCase(name), { cwd, scope: agent, signal }).catch(() => undefined)
      if (skill === undefined || skill.invocation?.modelInvocable === false) {
        appendNotice(agent.session, { kind: 'feedback', event: 'SubagentStart', subject: profile.name, plugin: profile.pluginId, text: `skill ${name} listed by ${profile.name} is missing or user-only; not preloaded` })
        continue
      }
      agent.inject(createUserMessage({ content: [{ type: 'text', text: renderSkillContent(skill as never) }], source: { kind: 'skill-invocation', name: skill.name, form: 'instructions' } as never }))
    }
    if (fields.memory !== undefined) {
      const dir = agentMemoryDir(fields.memory, profile.name, cwd)
      mkdirSync(dir, { recursive: true })
      agent.inject(createUserMessage({ content: [{ type: 'text', text: memoryInstructions(dir) }], source: { kind: 'user' } }))
    }
  }

  private async disposed(agent: AgentLike): Promise<void> {
    const run = this.runs.get(agent.session.header.id)
    this.runs.delete(agent.session.header.id)
    for (const dispose of run?.disposers ?? []) await dispose().catch(() => undefined)
    const cwd = agent.session.header.cwd
    const worktree = cwd === undefined ? undefined : this.worktrees.get(cwd)
    if (cwd === undefined || worktree === undefined) return
    // Claude Code removes an isolated agent's worktree when the agent changed nothing.
    const status = await this.shell.runExec('git', ['status', '--porcelain'], { cwd })
    if (status.exitCode === 0 && status.stdout.trim().length === 0) {
      const ahead = await this.shell.runExec('git', ['log', '--oneline', `${worktree.base}..HEAD`], { cwd })
      if (ahead.exitCode === 0 && ahead.stdout.trim().length === 0) {
        await this.shell.runExec('git', ['worktree', 'remove', '--force', cwd], { cwd: worktree.repo })
        await this.shell.runExec('git', ['branch', '-D', worktree.branch], { cwd: worktree.repo })
        this.worktrees.delete(cwd)
      }
    }
  }

  /**
   * Create the worktree an isolated agent runs in, branched from the
   * repository's current HEAD.
   * @returns the worktree directory, or undefined outside a git repository.
   */
  async worktree(cwd: string): Promise<string | undefined> {
    const top = await this.shell.runExec('git', ['rev-parse', '--show-toplevel'], { cwd })
    if (top.exitCode !== 0) return undefined
    const repo = top.stdout.trim()
    const base = (await this.shell.runExec('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim()
    const id = randomUUID().slice(0, 8)
    const path = join(this.dataRoot, 'worktrees', id)
    const branch = `harness-forge/agent-${id}`
    mkdirSync(join(this.dataRoot, 'worktrees'), { recursive: true })
    const added = await this.shell.runExec('git', ['worktree', 'add', '-b', branch, path, base], { cwd: repo })
    if (added.exitCode !== 0) throw new Error(`git worktree add failed: ${added.stderr.trim()}`)
    this.worktrees.set(path, { repo, branch, base })
    return path
  }
}

function inlineServer(profile: AgentProfile, name: string, config: Readonly<Record<string, unknown>>): McpComponent {
  const type = typeof config['type'] === 'string' ? config['type'] : undefined
  const transport: McpComponent['transport'] = type === 'sse' ? 'sse'
    : type === 'http' || type === 'streamable-http' ? 'streamable-http'
      : typeof config['command'] === 'string' ? 'stdio'
        : typeof config['url'] === 'string' ? 'streamable-http' : 'unknown'
  const strings = (value: unknown): Record<string, string> | undefined => value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : undefined
  const env = strings(config['env'])
  const headers = strings(config['headers'])
  return {
    id: `${profile.pluginId}:mcp:${profile.name}-${name}`,
    kind: 'mcp',
    name,
    transport,
    ...(typeof config['command'] === 'string' ? { command: config['command'] } : {}),
    ...(Array.isArray(config['args']) ? { args: config['args'].map(String) } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(typeof config['cwd'] === 'string' ? { cwd: config['cwd'] } : {}),
    ...(typeof config['url'] === 'string' ? { url: config['url'] } : {}),
    ...(headers !== undefined ? { headers } : {}),
  }
}
