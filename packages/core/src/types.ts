/**
 * Tool-independent normalized conversation model shared by every source adapter.
 *
 * A source adapter reduces its native transcript to this model. The DSH
 * synthesis layer and every native-format serializer consume the same model,
 * so adding a source never changes session-log generation.
 * @module @claude2dsh/core
 */

/** Identity of the source tool and the artifact a session was read from. */
export interface SourceRef {
  /** Adapter id, e.g. `claude-code`. */
  readonly tool: string
  /** Absolute path of the source artifact when one exists. */
  readonly path?: string
  /** Source-side session identifier. */
  readonly sessionId?: string
}

/** Plain text visible to the model. */
export interface NormalizedTextBlock {
  readonly type: 'text'
  readonly text: string
}

/** Reasoning/thinking content, kept in history but not replayed as visible text. */
export interface NormalizedReasoningBlock {
  readonly type: 'reasoning'
  readonly text: string
  /** Set when the source stored an encrypted/redacted thinking payload. */
  readonly redacted?: true
}

/** Durable image reference produced by the DSH attachment service. */
export interface NormalizedImageAttachment {
  readonly attachmentId: string
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
}

/** An image content block. Base64 blocks degrade to text until an attachment is resolved. */
export interface NormalizedImageBlock {
  readonly type: 'image'
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  readonly base64?: string
  readonly attachment?: NormalizedImageAttachment
  readonly forcePlaceholder?: true
  readonly name?: string
}

/** A tool invocation inside an assistant message. */
export interface NormalizedToolCallBlock {
  readonly type: 'tool-call'
  readonly id: string
  readonly name: string
  readonly arguments: unknown
}

/** Content block vocabulary of the normalized model. */
export type NormalizedContentBlock =
  | NormalizedTextBlock
  | NormalizedReasoningBlock
  | NormalizedToolCallBlock
  | NormalizedImageBlock

/** One completed tool result attached to the step that declared the call. */
export interface NormalizedToolResult {
  readonly toolCallId: string
  readonly content: readonly NormalizedContentBlock[]
  readonly isError?: boolean
  readonly timestamp?: number
}

/** One assistant step: one assistant message plus the results for its tool calls. */
export interface NormalizedStep {
  readonly number: number
  readonly timestamp?: number
  readonly model?: string
  readonly content: readonly NormalizedContentBlock[]
  readonly toolCalls: readonly { id: string; name: string; arguments: unknown }[]
  readonly toolResults: readonly NormalizedToolResult[]
}

/** One user turn. A turn may contain several assistant steps (tool-call rounds). */
export interface NormalizedTurn {
  readonly number: number
  readonly prompt: string
  readonly timestamp?: number
  /** Complete user content when the source prompt was not a plain string. */
  readonly promptBlocks?: readonly NormalizedContentBlock[]
  readonly steps: readonly NormalizedStep[]
}

/** Complete normalized session produced by a source adapter. */
export interface NormalizedSession {
  /** Target DSH session id chosen by the adapter. */
  readonly id: string
  readonly source: SourceRef
  readonly createdAt: number
  readonly cwd?: string
  readonly title?: string
  readonly model?: string
  readonly origin?: 'subagent'
  /** DSH session id of the parent session, when this is a subagent transcript. */
  readonly parentSession?: string
  readonly turns: readonly NormalizedTurn[]
}

/** Statistics a parser reports beside the normalized model. */
export interface NormalizeStats {
  readonly records: number
  readonly skipped: number
  readonly malformed: number
  readonly droppedToolResults: number
  readonly synthesizedToolResults: number
  readonly droppedUserRecords: number
  readonly auxiliaryBranches: number
  readonly reasons: readonly string[]
}
