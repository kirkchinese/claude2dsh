/** Shapes read from a DeepSeek Harness session log. */
import type { ForeignSessionView } from '@dsh2claude/core'

/** Header facts a DSH session log carries in its first record (format v3/v4). */
export interface DshSessionHeader {
  readonly id: string
  readonly version: number
  readonly createdAt: number
  readonly cwd?: string
  readonly title?: string
  readonly isSeeded?: boolean
  readonly delegationDepth?: number
  readonly origin?: 'subagent'
  readonly parentSession?: string
  readonly agentPreset?: string
}

/** One session artifact found below a DSH sessions root. */
export interface DiscoveredDshSession {
  /** Absolute path of the session log. */
  readonly ref: string
  /** DSH-side session id from the header, or the directory name. */
  readonly dshId: string
  /** On-disk log format version. */
  readonly version: number
  /** Creation time in Unix epoch milliseconds. */
  readonly createdAt: number
  readonly cwd?: string
  readonly title?: string
  /** True when this is a delegated child session. */
  readonly isAuxiliary: boolean
  readonly parentDshId?: string
}

/** Counters that explain what a read kept, dropped, or repaired. */
export interface DshReadStats {
  readonly records: number
  readonly malformed: number
  readonly ignored: number
  readonly injectedUserMessages: number
  readonly toolCalls: number
  readonly toolResults: number
  readonly droppedImages: number
  /** Surface `replace`/`remove` operations applied to the folded log. */
  readonly surfaceReplacements: number
  /** Bytes in an incomplete final Zstandard frame; never decoded. */
  readonly tornBytes: number
  readonly frames: number
}

/** Complete result of reading one DSH session. */
export interface ReadDshSessionResult {
  readonly ref: string
  readonly header: DshSessionHeader
  readonly view: ForeignSessionView
  readonly stats: DshReadStats
}

/** Discovery controls. */
export interface DshDiscoverOptions {
  /** Abort cooperative work. */
  readonly signal?: AbortSignal
  /** Recurse below the standard workspace/session layout. Defaults to true. */
  readonly recursive?: boolean
  /** Include delegated child sessions. Defaults to true. */
  readonly includeAuxiliary?: boolean
}

/** Read controls. */
export interface DshReadOptions {
  readonly signal?: AbortSignal
}
