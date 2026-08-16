/** Claude Code adapter implementing the multi-tool session-source contract. */
import type {
  AdapterOptions,
  DiscoveredSession,
  ForeignSessionView,
  NormalizedSession,
  SessionSourceAdapter,
  SourceAppend,
} from '@claude2dsh/core'
import { discoverClaudeCodeSessions } from './discover.ts'
import { readClaudeSession } from './parse.ts'

/** The first adapter of the migration layer. */
export const claudeCodeAdapter: SessionSourceAdapter = {
  id: 'claude-code',
  label: 'Claude Code',
  supportsWriteback: false,
  async *discover(root: string, options?: AdapterOptions) {
    yield* discoverClaudeCodeSessions(root, options ?? {})
  },
  async readSession(ref: DiscoveredSession, options?: AdapterOptions) {
    return readClaudeSession(ref, options ?? {})
  },
}

/** Re-exported for direct library consumers. */
export type { NormalizedSession, ForeignSessionView, SourceAppend }
