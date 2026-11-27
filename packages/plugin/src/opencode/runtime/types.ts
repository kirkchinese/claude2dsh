/**
 * The OpenCode runtime's types: what it needs from Harness Forge, what a
 * mount returns, and structural views of the DSH objects it touches.
 * @module @kirkchinese/harness-forge/opencode
 */
import type { ChildProcess } from 'node:child_process'
import type { CommandComponent } from '@kirkchinese/harness-forge-core'
import type { LoggedEvent } from '../convert.js'

/** What the runtime needs from Harness Forge. */
export interface OpenCodeRuntimeHost {
  readonly dataRoot: string
  /** Runtime evidence for a component. */
  observe(componentId: string, signal: string, ok: boolean, detail: string): void
  directory(agent: unknown, signal: AbortSignal): Promise<string>
  /** Replace a pending call's arguments (the hooks broker runs the tool with them). */
  rewrite(callId: string, args: Record<string, unknown>): void
  /** The foreign name of a DSH agent preset. */
  agentName(presetId: string): string | undefined
}

/** One running OpenCode plugin. */
export interface PluginHost {
  readonly key: string
  readonly componentId: string
  readonly pluginName: string
  readonly root: string
  url: string
  child: ChildProcess
  hooks: Set<string>
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  config: Record<string, unknown>
  /** Events wait for the previous one, so a plugin sees them in order. */
  events: Promise<void>
  log: string
  /** Being stopped (unloaded, or DSH exiting) once queued events had their time: what is cut off is not the plugin's failure. */
  stopping?: boolean
}

export interface Agent {
  readonly session: {
    readonly header: { readonly id: string; readonly cwd?: string; readonly parentSession?: string; readonly createdAt?: unknown; readonly delegationDepth?: number }
    readonly seq: number
    eventAt(seq: number): LoggedEvent | undefined
  }
  readonly options?: { readonly provider?: string; readonly model?: string }
  readonly ctx?: { get?(name: string): unknown }
  followup(message: unknown): void
  inject(message: unknown): void
  cancel(cause: { kind: string; reason?: string }, options?: { keepInbox?: boolean }): void
  whenIdle(): Promise<void>
}

export interface Agents {
  get(id: string): Agent | undefined
  list(): Agent[]
  roots(): Agent[]
  create(options: Record<string, unknown>): Promise<{ agent: Agent; dispose(): Promise<void> }>
}

export interface ToolRegistry {
  register(definition: Record<string, unknown>): () => void
}

export interface ToolExec {
  readonly name: string
  readonly arguments: unknown
  readonly callId?: string
  readonly agent?: Agent
  readonly signal: AbortSignal
}

export interface Message {
  readonly id?: string
  readonly source?: { readonly kind?: string }
  readonly content: ReadonlyArray<Record<string, unknown>>
}

/** A plugin's command (from its `config` hook) as Harness Forge registers it. */
export interface OpenCodeCommand {
  readonly component: CommandComponent
  readonly name: string
}

/** One mounted OpenCode plugin. */
export interface OpenCodeMount {
  readonly tools: readonly string[]
  readonly hooks: readonly string[]
  readonly commands: readonly OpenCodeCommand[]
  /** Top-level configuration keys the plugin's `config` hook changed; only `command` is applied in DSH. */
  readonly configChanged: readonly string[]
  readonly dispose: () => Promise<void>
}
