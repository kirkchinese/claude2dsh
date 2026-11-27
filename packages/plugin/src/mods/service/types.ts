/**
 * The mods service's types: imported mods, the host it needs, one root
 * session's mods and structural views of the DSH objects it touches.
 * @module @kirkchinese/harness-forge/mods
 */
import type { ForeignShell } from '../../hooks/shell.js'
import type { PluginTier } from '../chain.js'
import type { ModsEngine } from '../engine.js'
import type { SessionAgent, SessionHost } from '../host.js'
import type { Bundle } from '../loader.js'
import type { SessionSurfaces } from '../surfaces.js'

export type { ModEventRecord } from '../../dsh/session-records.js'

/** One imported mod, bundled once and loaded into each session. */
export interface ModSource {
  /** The Harness Forge component the mod was installed as. */
  readonly componentId: string
  readonly name: string
  readonly tier: PluginTier
  readonly root: string
  readonly bundle: Bundle
  readonly options: Readonly<Record<string, unknown>>
  readonly uses: Readonly<Record<string, unknown>>
  readonly provenance: string
  readonly version?: string
  readonly refusal?: string
}

/** A Claude permission verdict, as `tool.check` answers it. */
export interface ClaudeVerdict {
  readonly decision: 'allow' | 'ask' | 'deny'
  readonly reason?: string
  readonly rule?: string
  readonly hook?: string
  readonly setting?: string
}

/** What the service needs from Harness Forge's runtime. */
export interface ModsServiceHost {
  readonly shell: ForeignShell
  readonly storeRoot: string
  /** Where each mod's unload is recorded, one JSON line each: the record of an uninstalled plugin is gone from the ledger. */
  readonly disposedLog?: string
  directory(agent: unknown, signal: AbortSignal): Promise<string>
  settings(session: { id: string; parentSession?: string } | undefined, source: string | undefined): Record<string, unknown>
  /** Carry a rewrite of a call's arguments to the tool (the hooks broker applies it). */
  rewrite(callId: string, args: Record<string, unknown>): void
  agentName(presetId: string): string | undefined
  presetOf(name: string): string | undefined
  /** A mod's hook ran for an event: runtime evidence of its component. */
  observe(componentId: string, event: string): void
}

export interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

/** One DSH tool call the `tool.call` hooks are wrapped around. */
export interface PendingCall {
  readonly input: Record<string, unknown>
  readonly reached: Deferred<Record<string, unknown>>
  readonly beneath: Deferred<Record<string, unknown>>
  chain?: Promise<Record<string, unknown>>
  answered?: Record<string, unknown>
  isBeneathSettled: boolean
}

export interface ToolExec {
  readonly name: string
  readonly arguments: unknown
  readonly callId?: string
  readonly agent?: SessionAgent & { readonly session: SessionAgent['session'] & { readonly header: { readonly delegationDepth?: number } } }
  readonly signal: AbortSignal
}

export interface ToolResult {
  readonly isError: boolean
  readonly value?: unknown
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>
  readonly error?: { readonly message?: string }
}

/** One root session's mods. */
export interface SessionMods {
  readonly agent: SessionAgent
  readonly engine: ModsEngine
  readonly host: SessionHost
  readonly calls: Map<string, PendingCall>
  readonly checks: Map<string, ClaudeVerdict>
  readonly turns: Map<number, { startedAt: number; answer: string; started: boolean }>
  readonly commands: Map<string, () => void>
  /** The mod that registered each command, so unloading a mod withdraws its commands. */
  readonly commandOwners: Map<string, string>
  /** DSH's own run of the command a `command.run` dispatch is about, innermost last. */
  readonly nativeCommands: Array<(command: string, args: string) => Promise<{ text?: string }>>
  /** The band and panes the session's mods draw. */
  readonly surfaces: SessionSurfaces
  /** (mod, event) pairs already recorded in the session. */
  readonly recorded: Set<string>
  /** Whether `prompt.context` has run for the conversation. */
  isContextRaised: boolean
  ready: Promise<void>
}

export type CommandsExecute = (agent: unknown, line: string, attachments: unknown[], signal: AbortSignal) => Promise<{ commandId: string; result: { kind: string; text?: string } } | undefined>

export interface PreStep {
  readonly agent: ToolExec['agent']
  readonly messages: ReadonlyArray<{ readonly source?: { readonly kind?: string }; readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }> }>
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
}

export interface PreStepDecision {
  readonly kind: string
  readonly messages?: unknown[]
}

export interface PostDecision {
  readonly kind: 'accept' | 'block'
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>
  readonly additionalContexts?: unknown[]
  readonly reason?: string
}
