/**
 * Harness Forge's records in a DSH session log, in one place.
 *
 * DSH stores a plugin's own facts in the session log as plugin records
 * (`appendPluginRecord`, `@deepseek-ai/dsh-session`; typed by augmenting its
 * `PluginRecordMap`), and hook runs as `hook/invoked` / `hook/result` events
 * (`@deepseek-ai/dsh-hook-protocol`, the same records DSH's own hook bridges
 * write, so DSH's session views show imported hooks like its own). Both are
 * pre-1.0 DSH API: every record Harness Forge writes is declared and written
 * here, the only module that names these functions.
 * Checked against DSH 0.2.2-rc.3 and 0.2.2-rc.5.
 * @module @kirkchinese/harness-forge
 */
import type { appendHookInvoked, appendHookResult } from '@deepseek-ai/dsh-hook-protocol'
import { appendPluginRecord, type Session } from '@deepseek-ai/dsh-session'
import type { ComponentOutcome } from '@kirkchinese/harness-forge-core'

/** What one hook handler answered. */
export interface HookOutputRecord {
  readonly handlerId: string
  readonly event: string
  readonly callId?: string
  readonly block?: string
  readonly json?: Readonly<Record<string, unknown>>
  readonly plain?: string
}

/** One user-facing hook message. */
export interface HookNotice {
  /** `system-message`, `hook-error`, `blocked`, `stopped`, `terminal`, `feedback`. */
  readonly kind: 'system-message' | 'hook-error' | 'blocked' | 'stopped' | 'terminal' | 'feedback'
  /** The hook event, such as `PreToolUse`. */
  readonly event: string
  /** What the event matched on, such as the tool name. */
  readonly subject?: string
  /** Plugin id of the hook's source. */
  readonly plugin: string
  readonly text: string
}

/** A mod's hook ran for an event in a session: the lab's and the workbench's evidence. */
export interface ModEventRecord {
  readonly mod: string
  readonly event: string
}

/** What a session records about the project assets it loaded. */
export interface ProjectRecord {
  readonly root: string
  readonly pluginId: string
  readonly components: ReadonlyArray<{ readonly id: string; readonly kind: string; readonly name: string }>
  readonly outcomes: readonly ComponentOutcome[]
}

/** Every plugin record Harness Forge writes, by record type. */
export interface HarnessRecords {
  /** A hook's message for the user (Claude Code's `systemMessage`, a blocked call, a failed handler). */
  'plugin:harness-forge/notice': HookNotice
  /** What one hook handler answered (its block, JSON or plain output), keyed by its `hook/invoked` id. */
  'plugin:harness-forge/hook-output': HookOutputRecord
  /** A Claude Code mod event that ran in the session. */
  'plugin:harness-forge/mod-event': ModEventRecord
  /** The project assets (CLAUDE.md, settings, hooks…) a session loaded. */
  'plugin:harness-forge/project': ProjectRecord
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap extends HarnessRecords {}
}

/** Append one of Harness Forge's records to a session's log. Throws when the session no longer accepts records. */
export function appendRecord<K extends keyof HarnessRecords>(session: unknown, type: K, data: HarnessRecords[K]): void {
  appendPluginRecord(session as Session, type, data as never)
}

/** The session events DSH's hook bridges append, as Harness Forge appends them. */
interface HookEventSession {
  append(type: 'hook/invoked' | 'hook/result', data: Record<string, unknown>): void
}

/**
 * Record that a hook handler starts (DSH's `hook/invoked`), as `appendHookInvoked` of
 * `@deepseek-ai/dsh-hook-protocol` writes it. Written here rather than imported: that package requires
 * `dsh-session` and `dsh-shell` of its own exact release as peers, which a profile install would put beside
 * DSH's own and so break a DSH of another release.
 */
export function recordHookInvoked(session: unknown, invocation: Parameters<typeof appendHookInvoked>[1]): void {
  ;(session as HookEventSession).append('hook/invoked', {
    turn: invocation.turn,
    point: invocation.point,
    dialect: invocation.dialect,
    handlerId: invocation.handlerId,
    ...(invocation.matcher !== undefined ? { matcher: invocation.matcher } : {}),
  })
}

/** Record a hook handler's result (DSH's `hook/result`), as `appendHookResult` writes it. */
export function recordHookResult(session: unknown, record: Parameters<typeof appendHookResult>[1]): void {
  const { output } = record
  const stderr = output.stderr.trim()
  const stderrSummary = stderr.length === 0 ? undefined : stderr.length > record.stderrSummaryMaxChars ? `${stderr.slice(0, record.stderrSummaryMaxChars)}…` : stderr
  ;(session as HookEventSession).append('hook/result', {
    turn: record.turn,
    point: record.point,
    handlerId: record.handlerId,
    decision: output.decision ?? (output.continue === false ? 'stop' : 'pass'),
    ...(output.exitCode !== undefined ? { exitCode: output.exitCode } : {}),
    ...(stderrSummary !== undefined ? { stderrSummary } : {}),
    durationMs: record.durationMs,
  })
}
