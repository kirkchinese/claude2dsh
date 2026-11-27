/**
 * Session migration: a normalized session model, the Claude Code transcript
 * reader, and the synthesizer that turns a normalized session into DSH v4
 * session events.
 * Codex and OpenCode readers live in the plugin package because they read
 * their own stores.
 * @module @kirkchinese/harness-forge-core
 */
export * from './model.js'
export * from './adapter.js'
export * from './synthesize.js'
export { claudeCodeAdapter } from '../dialects/claude-code/sessions/adapter.js'
export { readClaudeSession, type ClaudeReadOptions } from '../dialects/claude-code/sessions/parse.js'
export { discoverClaudeCodeSessions } from '../dialects/claude-code/sessions/discover.js'
