/**
 * The contract between Harness Forge's rows. The `harness-forge` row owns the
 * ledger and provides the shared service (`harnessForge`); every capability
 * row (skills, commands, agents, hooks, MCP, mods, OpenCode) mounts its kind
 * of component through a mounter it registers, and offers what other rows
 * may ask of it as an optional API. A row that is off simply is not there:
 * its components show as inactive and every lookup of it returns nothing.
 *
 * This module imports no row, so no row depends on another through it.
 * @module @kirkchinese/harness-forge
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ComponentOutcome, ForeignComponent, ForeignPlugin, Gap, PlanAction } from '@kirkchinese/harness-forge-core'
import type { HookConfigSource } from '../hooks/config.js'
import type { RemoteMcpHost } from '../mcp/mount.js'

/** What a row's start returns: its teardown. */
export type Disposer = () => unknown

/**
 * The kinds of mount, one per mounter. A planned action maps to one kind by
 * its action and component (see `mountKindOf`).
 */
export type MountKind =
  | 'skill'
  | 'command'
  | 'output-style'
  | 'mcp'
  | 'hooks'
  | 'codex-notify'
  | 'codex-instructions'
  | 'agent'
  | 'claude-mod'
  | 'opencode-plugin'
  | 'settings'

/** The row that mounts each kind, as the workbench names it when that row is off. */
export const ROW_OF_KIND: Readonly<Record<MountKind, string>> = {
  'skill': 'skills',
  'command': 'commands',
  'output-style': 'commands',
  'mcp': 'mcp',
  'hooks': 'hooks',
  'codex-notify': 'hooks',
  'codex-instructions': 'hooks',
  'agent': 'agents',
  'claude-mod': 'mods',
  'opencode-plugin': 'opencode',
  'settings': 'harness-forge',
}

/**
 * Where a mount lives: process-wide (an installed plugin), or one session's
 * project assets, in that session's agent context.
 */
export interface MountScope {
  /** The session's agent context; absent for a process-wide mount. */
  readonly ctx?: Context
  /** Limits hooks and settings to this session and its delegated agents. */
  readonly sessionId?: string
}

/** One planned action to mount. */
export interface MountRequest {
  readonly action: PlanAction
  readonly component: ForeignComponent
  readonly plugin: ForeignPlugin
  /** The plugin's writable data directory (`${CLAUDE_PLUGIN_DATA}`). */
  readonly dataDir: string
  readonly scope: MountScope
  /**
   * Command names of this apply, by component id: a command keeps its name
   * across restarts, and names given here are taken.
   */
  readonly commandNames: Map<string, string>
  /** Every command name in use outside this plugin. */
  takenNames(): Set<string>
}

/** A mount's outcome: `mounted` at most (only a runtime observation upgrades it), and its withdrawal. */
export interface Mounted {
  readonly outcome: ComponentOutcome
  readonly disposer?: () => Promise<void>
}

/** Mounts one kind of component; registered by the row that owns the kind. */
export interface Mounter {
  mount(request: MountRequest): Promise<Mounted>
  /** Every action of one apply in `scope` ran (the delegation tool restarts once, after all agents). */
  settle?(scope: MountScope): Promise<void>
  /** A session's project scope ended: release what `mount` kept for it. */
  release?(scope: MountScope): Promise<void>
}

/** A hook configuration a skill's or agent's frontmatter declares, as the hooks row runs it. */
export type FrontmatterHooks = HookConfigSource

/** A permission verdict as Claude Code's `tool.check` carries it. */
export interface ToolVerdict {
  readonly decision: 'allow' | 'ask' | 'deny'
  readonly reason?: string
  readonly rule?: string
  readonly hook?: string
}

/** What the hooks row offers. */
export interface HooksApi {
  /** A rewrite of a call's arguments (DSH vocabulary) the hooks and the tool see. */
  rewrite(callId: string, args: Record<string, unknown>): void
  /** `UserPromptExpansion` for a skill the user typed. */
  expandSkill(agent: unknown, skill: { readonly name: string; readonly foreignName: string; readonly args: string; readonly source: string }, signal: AbortSignal): Promise<{ blocked?: string; context: string[] }>
  /** `UserPromptSubmit` and `UserPromptExpansion` for an imported command the user typed. */
  expandCommand(agent: unknown, command: { readonly name: string; readonly foreignName: string; readonly args: string; readonly expanded: string }, signal: AbortSignal): Promise<{ blocked?: string; context: string[] }>
  /** Add a hook source (a command's frontmatter hooks); returns its removal. */
  add(source: FrontmatterHooks & { readonly sessionId?: string; readonly agentSessionId?: string }): () => void
  /** Mods' `tool.check` over the verdict the hooks reached; one checker at most. */
  setChecker(checker: { checks(exec: unknown): boolean; check(exec: unknown, verdict: ToolVerdict): Promise<ToolVerdict> }): Disposer
  /** Variables another runtime adds to a shell call's environment (OpenCode's `shell.env`). */
  addShellEnv(provider: (exec: unknown) => Promise<Record<string, string>>): Disposer
}

/** What the skills row offers. */
export interface SkillsApi {
  /** Hooks declared in an imported skill's frontmatter, by DSH skill name. */
  skillHooks(name: string): FrontmatterHooks | undefined
  /** Re-scan the imported skills. */
  reload(): void
  /** The configured skill roots and the directories of the mounted skills (only the mounted ones are served from those). */
  roots(): readonly string[]
}

/** What the agents row offers. */
export interface AgentsApi {
  /** The foreign name (`plugin:agent`) of an imported agent preset. */
  foreignName(presetId: string): string | undefined
  /** The DSH preset of a foreign agent name. */
  presetOf(foreignName: string): string | undefined
  /** Hooks declared in an imported agent's frontmatter, by preset id. */
  agentHooks(presetId: string): FrontmatterHooks | undefined
}

/** A command an imported plugin's code added (OpenCode's `config` hook). */
export interface ForeignCommand {
  readonly component: ForeignComponent
  readonly name: string
  readonly foreignName: string
  readonly pluginId: string
  readonly pluginRoot: string
  readonly dataDir: string
}

/** What the commands row offers. */
export interface CommandsApi {
  /** Register an added command under a free name; returns the name and the removal. */
  registerAdded(command: ForeignCommand, scope: MountScope, takenNames: Set<string>): { readonly name: string; readonly dispose: () => void } | undefined
  /** OpenCode's `command.execute.before` for imported OpenCode commands; one provider at most. */
  setBeforeSubmit(hook: (agent: unknown, command: { name: string; args: string }, prompt: string) => Promise<string[] | { stopped: string }>): Disposer
}

/** What the MCP row offers. */
export interface McpApi {
  /** Remote MCP servers that wait for the user to sign in: those a session sees (its project's and process-wide ones), or all. */
  pendingSignIns(sessionId?: string): string[]
  /**
   * Start one server's sign-in in the background; returns the page to sign in on. With a session, its own
   * project server of that name is preferred to the process-wide one.
   */
  startSignIn(serverName: string, sessionId?: string): string
  /** The remote-MCP host a component's servers use: its sign-in state becomes the component's evidence. */
  remoteHost(componentId: string, scope?: MountScope): RemoteMcpHost
}

/** What the mods row offers. */
export interface ModsApi {
  watch(sessionId: string, listener: (snapshot: unknown) => void): (() => void) | undefined
  act(sessionId: string, generation: number, actionId: string, value?: unknown): Promise<unknown>
  closePane(sessionId: string, id: string): Promise<unknown>
  move(sessionId: string, kind: 'focus' | 'scroll', target: Readonly<Record<string, unknown>>): Promise<unknown>
}

/** A harness whose sessions can be imported. */
export type SessionSource = 'claude-code' | 'codex' | 'opencode'

/** What the sessions row offers. */
export interface SessionsApi {
  /** The sessions of one harness available for import. */
  sessions(root: string | undefined, source: SessionSource): Promise<readonly unknown[]>
  /** Import one session into DSH. */
  importSession(path: string, targetId: string | undefined, source: SessionSource, sourceId: string | undefined): Promise<unknown>
}

/** What the instruction files of a workspace are, for the workbench. */
export interface ContextStatus {
  /** Whether Harness Forge adds instruction files: false while the row is off or yielding. */
  readonly active: boolean
  /** The plugin that owns instruction injection instead, when it runs. */
  readonly yieldingTo?: string
  /** The files Harness Forge adds. */
  readonly files: readonly { readonly path: string; readonly bytes: number }[]
  /** The files DSH injects itself (`CLAUDE.md`, `CLAUDE.local.md`); only their imports come from here. */
  readonly hostFiles?: readonly { readonly path: string; readonly bytes: number }[]
}

/** What the context row offers. */
export interface ContextApi {
  /** The instruction files of a workspace; the default workspace without `cwd`. */
  status(cwd?: string): ContextStatus
}

/** What the porter row offers: a gap described as a brief, handed to DSH's creation mode. */
export interface PorterApi {
  /** The brief for one part of a plugin, as Markdown. */
  brief(plugin: ForeignPlugin, gaps: readonly Gap[], componentId: string): string
  /** The first message of its port session: the working protocol, then the brief; `language` is the user's interface language. */
  task(plugin: ForeignPlugin, gaps: readonly Gap[], componentId: string, language?: string): string
  /** Start a creation-mode session working on the part's task, and record it as the part's port session. */
  port(plugin: ForeignPlugin, gaps: readonly Gap[], componentId: string, location: { readonly workspaceId?: string; readonly cwd?: string }, language?: string): Promise<{ readonly sessionId: string }>
}

/** The optional APIs, by row. */
export interface RowApis {
  context: ContextApi
  hooks: HooksApi
  skills: SkillsApi
  agents: AgentsApi
  commands: CommandsApi
  mcp: McpApi
  mods: ModsApi
  sessions: SessionsApi
  porter: PorterApi
}

/** A plugin component's planned action, as the kind of mount it needs; `undefined` when DSH has nothing for it. */
export function mountKindOf(action: PlanAction, component: ForeignComponent): MountKind | { readonly skipped: string } {
  switch (action.kind) {
    case 'link-skill-root': return 'skill'
    case 'register-command': return 'command'
    case 'mount-mcp': return 'mcp'
    case 'mount-hooks': return 'hooks'
    case 'register-agent': return 'agent'
    case 'apply-settings': return 'settings'
    case 'report-ui':
      return component.kind === 'ui' && component.surface === 'output-style' && component.specPath !== undefined
        ? 'output-style'
        : { skipped: 'UI surface has no DSH adapter yet' }
    case 'report-code':
      if (component.kind === 'other' && component.originalKind === 'codex-notify') return 'codex-notify'
      if (component.kind === 'other' && component.originalKind === 'codex-instructions' && component.path !== undefined) return 'codex-instructions'
      if (component.kind === 'other') return { skipped: `${component.originalKind} is not mapped to DSH` }
      if (component.kind === 'code' && component.runtime === 'claude-mod') return 'claude-mod'
      if (component.kind === 'code' && component.runtime === 'opencode-plugin') return 'opencode-plugin'
      return { skipped: component.kind === 'code' ? `no runtime for ${component.runtime}` : `unsupported action ${action.kind} for ${component.kind}` }
    default:
      return { skipped: `unsupported action ${String(action.kind)}` }
  }
}
