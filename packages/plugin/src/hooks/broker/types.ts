/**
 * The hook broker's types: what an imported hooks configuration, its host and
 * a permission verdict look like, and structural views of the DSH objects the
 * broker touches.
 * @module @kirkchinese/harness-forge
 */
import type { FSWatcher } from 'node:fs'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { McpToolCall, McpToolVerdict } from '../../forge/contract.js'
import type { HookHandler, HookTable } from '../config.js'
import type { Decoded } from '../output.js'
import type { PermissionRuleSet } from '../permissions.js'
import type { ModelVerdict } from '../runner.js'
import type { ForeignShell } from '../shell.js'
import type { HookDialect } from '../vocabulary.js'

/** One imported hooks configuration. */
export interface HookSource {
  readonly componentId: string
  readonly pluginId: string
  readonly dialect: HookDialect
  readonly pluginRoot: string
  readonly dataDir: string
  readonly table: HookTable
  /** Where the hooks are declared; only skill hooks honor `once`, only settings hooks deduplicate. */
  readonly origin?: 'plugin' | 'settings' | 'skill' | 'agent'
  /** Skill hooks: active in this session after the skill ran. */
  readonly sessionId?: string
  /** Agent hooks: active while this delegated session runs; their `Stop` runs as `SubagentStop`. */
  readonly agentSessionId?: string
  /** Plugin user-config values. */
  readonly options?: Readonly<Record<string, string>>
}

/** One handler run, reported to the evidence ledger. */
export interface HookObservation {
  readonly componentId: string
  readonly event: string
  readonly ok: boolean
  readonly detail: string
}

/** What the broker needs from its host. */
export interface HookBrokerHost {
  readonly shell: ForeignShell
  /** Variables other runtimes add to a shell call's environment (OpenCode's `shell.env`). */
  shellEnv?(exec: ToolExecutionLike): Promise<Record<string, string>>
  /** Profile-local writable directory: transcripts, env files, spilled output. */
  readonly dataRoot: string
  observe(observation: HookObservation): void
  /** The foreign agent name (`plugin:agent`) of an imported agent preset. */
  agentName(presetId: string): string | undefined
  /** The DSH preset of a foreign agent name. */
  presetOf?(foreignName: string): string | undefined
  /** Hooks declared in an imported skill's frontmatter, by DSH skill name. */
  skillHooks?(skillName: string): HookSource | undefined
  /** Hooks declared in an imported agent's frontmatter, by preset id. */
  agentHooks?(presetId: string): HookSource | undefined
  /** Re-scan imported skills (SessionStart `reloadSkills`). */
  reloadSkills?(): void
  /** Environment imported settings declare for a session, set for every hook process. */
  environment?(session?: { readonly id: string; readonly parentSession?: string }): Readonly<Record<string, string>>
  /** Imported Claude-syntax permission rules that gate a session's tool calls. */
  permissionRules?(session?: { readonly id: string; readonly parentSession?: string }): PermissionRuleSet
  /** True while the settings in effect say `disableAllHooks: true`. */
  hooksDisabled?(session?: { readonly id: string; readonly parentSession?: string }): boolean
  /** Load a new top-level session's project assets (its hooks among them) before SessionStart. */
  prepareSession?(agent: unknown, cwd: string): Promise<void>
  /** A session ended: withdraw what `prepareSession` loaded. */
  releaseSession?(sessionId: string): Promise<void>
  /**
   * Mods' `tool.check` over the verdict Claude Code would reach for a call
   * (PreToolUse hooks, permission rules, the mode); returns the decision.
   */
  check?(exec: unknown, verdict: ToolVerdict): Promise<ToolVerdict>
  /** Whether any mod hooks `tool.check` in the call's session. */
  checks?(exec: unknown): boolean
  /** The registered server an `mcp_tool` hook of a plugin names (see `McpApi.hookServer`). */
  mcpHookServer?(pluginId: string, server: string, sessionId?: string): string | undefined
  /** The MCP row's tool policy for a call an `mcp_tool` hook makes (see `McpApi.toolPolicy`). */
  mcpToolPolicy?(call: McpToolCall): McpToolVerdict | undefined
}

/** A permission verdict as Claude Code's `tool.check` carries it. */
export interface ToolVerdict {
  readonly decision: 'allow' | 'ask' | 'deny'
  readonly reason?: string
  readonly rule?: string
  readonly hook?: string
}

/** Structural view of the DSH objects the broker touches. */
export interface AgentLike {
  readonly id?: string
  readonly ctx?: unknown
  readonly options?: { readonly provider?: string; readonly model?: string; readonly reasoningEffort?: string }
  readonly status?: unknown
  readonly session: SessionLike
  inject(message: unknown): void
  steer(message: unknown): void
  followup(message: unknown): void
  cancel?(cause: { kind: 'hook'; reason: string }): void
}

export interface SessionLike {
  readonly header: { readonly id: string; readonly cwd?: string; readonly delegationDepth?: number; readonly parentSession?: string }
  readonly seq: number
  snapshotEvents(): ReadonlyArray<{ readonly type: string; readonly time: number; readonly data: unknown }>
}

export interface ToolExecutionLike {
  readonly name: string
  readonly arguments: unknown
  readonly callId?: string
  readonly agent?: AgentLike
  readonly signal: AbortSignal
}

export interface ToolResultLike {
  readonly isError: boolean
  readonly content: readonly ContentBlock[]
  readonly value?: unknown
  readonly error?: { readonly message?: string; readonly info?: { readonly code?: string } }
}

export interface WorkingDirectoryLike {
  ensure(agent: AgentLike, signal: AbortSignal): Promise<string>
  get(session: unknown): string | undefined
}

/** One occurrence of a foreign event. */
export interface Occurrence {
  readonly event: string
  /** The agent the event happens in. */
  readonly agent?: AgentLike
  readonly signal: AbortSignal
  /** What a non-tool event matches on. */
  readonly subject?: string
  readonly tool?: { readonly dshName: string; readonly args: unknown; readonly callId?: string }
  /** Event-specific payload fields. */
  readonly fields?: Readonly<Record<string, unknown>>
  /** The command of a slash-command event, matched in both spellings. */
  readonly subjects?: readonly string[]
  readonly cwd?: string
  /** Fixed per-hook timeout default, when the event has its own. */
  readonly defaultTimeoutMs?: number
}

/** One handler's decoded outcome. */
export interface Ran {
  readonly source: HookSource
  readonly handler: Exclude<HookHandler, { type: 'invalid' }>
  readonly decoded: Decoded
  readonly verdict?: ModelVerdict
  /** The block produced by `onFailure: "block"` or a suspect capture. */
  readonly failureBlock?: string
  /** What the handler ran, for messages (`[cmd]`). */
  readonly label: string
  /** The tool name the handler saw. */
  readonly toolName?: string
}

/** Per-session state. */
export interface SessionState {
  lastTurn?: number
  promptId?: string
  stopActive: boolean
  stopContinuations: number
  /** Tool calls of the current step, for PostToolBatch. */
  batch: Array<{ tool_name: string; tool_input: unknown; tool_use_id?: string; tool_response: unknown }>
  /** Expanded command prompts already checked by UserPromptSubmit. */
  expanded: Set<string>
  /** Last async SessionStart text per handler, to skip unchanged repeats. */
  asyncSessionStart: Map<string, string>
  watchers: FSWatcher[]
  watchPaths: string[]
}

export interface PreStepPayload {
  readonly agent: AgentLike
  readonly messages: ReadonlyArray<{ readonly content: readonly ContentBlock[]; readonly source?: { readonly kind?: string } }>
  readonly turn: number
  readonly signal: AbortSignal
}

export type PreStepDecision = { readonly kind: string; readonly messages?: readonly unknown[] }
export type PostDecision = { readonly kind: string; readonly additionalContexts?: readonly unknown[]; readonly [key: string]: unknown }

/** DSH's question to the person (`user-questions/request`). */
export interface QuestionRequest {
  readonly questions: ReadonlyArray<{ readonly id: string; readonly question: string; readonly header?: string; readonly options?: ReadonlyArray<{ readonly label: string; readonly description?: string }>; readonly multiSelect?: boolean }>
  readonly agent?: AgentLike
  signal?: AbortSignal
  readonly wait?: { readonly callId: string }
}

export interface QuestionAnswer {
  readonly answers: ReadonlyArray<{ readonly id: string; readonly selected: readonly string[]; readonly custom?: string }>
}

export interface ApprovalRequest {
  readonly agent: AgentLike
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

export interface ToolDefinitionLike {
  execute(args: unknown, exec: unknown): Promise<unknown>
  readonly output: { render(args: unknown, value: unknown): ContentBlock[] }
}
