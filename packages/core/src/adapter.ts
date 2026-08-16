/**
 * Session-source adapter contract.
 *
 * `discover` + `readSession` cover the source -> DSH direction.
 * `serializeAppend` covers the reverse direction for adapters that support
 * native write-back. An adapter that cannot write back simply omits it; the
 * migration layer then reports that reverse direction as unavailable.
 * @module @claude2dsh/core
 */
import type { NormalizedSession, NormalizeStats } from './types.ts'

/** A discovered session before its full transcript is read. */
export interface DiscoveredSession {
  /** Adapter-local handle; for Claude Code this is the absolute JSONL path. */
  readonly ref: string
  /** Source-side session id when the artifact names one. */
  readonly sourceId?: string
  /** Working directory recorded in the source, if available. */
  readonly cwd?: string
  /** Presentation title, if the source has one without reading all records. */
  readonly title?: string
  /** Creation time in Unix epoch milliseconds. */
  readonly createdAt?: number
  /** Product origin when the adapter knows the artifact is a subagent child. */
  readonly origin?: 'subagent'
  /** Source-side parent session id when the artifact sits below one. */
  readonly parentSourceId?: string
}

/** A batch of source-native records serialized from DSH events. */
export interface SourceAppend {
  /** Source-native text to append. */
  readonly content: string
  /** Number of source-native records serialized. */
  readonly recordCount: number
  /** Source-side anchor required to verify the next append (file tail id etc.). */
  readonly anchor?: string
  /** Whether the destination file existed and was accepted. */
  readonly requiresExisting?: boolean
}

/** Events accepted by the reverse serializer (structurally DSH `SessionEvent`). */
export interface ForeignSessionEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: Record<string, unknown>
}

/** A DSH session projection accepted by the reverse serializer. */
export interface ForeignSessionView {
  readonly id: string
  readonly createdAt: number
  readonly cwd?: string
  readonly title?: string
  readonly events: readonly ForeignSessionEvent[]
}

/** Options common to every source adapter. */
export interface AdapterOptions {
  /** Abort discovery/read work cooperatively. */
  readonly signal?: AbortSignal
  /** Whether directory discovery may recurse below the first project level. */
  readonly recursive?: boolean
  /** Whether auxiliary subagent/workflow transcripts are discovered too. */
  readonly includeAuxiliary?: boolean
}

/** The extension point every future tool (Codex/Gemini/OpenClaw) implements. */
export interface SessionSourceAdapter {
  /** Stable id, used in registry keys and reports. */
  readonly id: string
  /** Human-readable source name. */
  readonly label: string
  /** Whether this adapter can serialize DSH events back to its native format. */
  readonly supportsWriteback: boolean
  /** Discover sessions below a root directory. */
  discover(root: string, options?: AdapterOptions): AsyncIterable<DiscoveredSession>
  /** Read and normalize one discovered session. */
  readSession(ref: DiscoveredSession, options?: AdapterOptions): Promise<{ session: NormalizedSession; stats: NormalizeStats }>
  /** Serialize DSH events to a source-native append batch. */
  serializeAppend?(session: ForeignSessionView, fromSeq: number, options?: AdapterOptions): Promise<SourceAppend>
}
