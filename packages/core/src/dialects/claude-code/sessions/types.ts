/** Loose raw record shapes read from Claude Code JSONL. */
export type RawJson = Record<string, unknown>

export interface RawMessage {
  readonly role?: unknown
  readonly content?: unknown
  readonly model?: unknown
  readonly id?: unknown
  readonly usage?: unknown
}

export interface RawRecord {
  readonly type?: unknown
  readonly uuid?: unknown
  readonly parentUuid?: unknown
  readonly sessionId?: unknown
  readonly cwd?: unknown
  readonly timestamp?: unknown
  readonly isSidechain?: unknown
  readonly isMeta?: unknown
  readonly message?: RawMessage
  readonly aiTitle?: unknown
  readonly summary?: unknown
  readonly title?: unknown
  readonly model?: unknown
}

/** A parsed line with its physical position. */
export interface RawLine {
  readonly line: number
  readonly record: RawRecord
}

/** Metadata read from the head of a file without loading the whole artifact. */
export interface ClaudeFileProbe {
  readonly sourceId: string
  readonly sessionId?: string
  readonly cwd?: string
  readonly title?: string
  readonly createdAt?: number
}

/** Frontmatter fields this adapter understands. */
export interface ClaudeSkillFrontmatter {
  readonly name?: unknown
  readonly description?: unknown
  readonly whenToUse?: unknown
  readonly allowedTools?: unknown
  readonly metadata?: unknown
  readonly [key: string]: unknown
}

/** One migratable Claude Code skill. */
export interface ClaudeSkill {
  readonly name: string
  readonly description: string
  /** Real directory containing SKILL.md plus resource files. */
  readonly sourceDir: string
  /** Relative paths of files to copy below the destination bundle directory. */
  readonly files: readonly { readonly relPath: string; readonly sourcePath: string }[]
}
