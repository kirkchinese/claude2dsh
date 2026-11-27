/**
 * The hook contract between assessment and the runtime broker: which foreign
 * hook events the broker serves on DSH, and which handler types it executes.
 * Anything outside these sets is reported as a gap, never silently dropped.
 * @module @kirkchinese/harness-forge-core
 */

/**
 * Events the broker serves. PreCompact, PostCompact, Notification and
 * StopFailure are observed after DSH commits them, so their hooks run but
 * cannot block.
 */
export const SERVED_HOOK_EVENTS: ReadonlySet<string> = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'StopFailure',
  'PreCompact',
  'PostCompact',
  'SessionEnd',
])

/** Events whose hooks run but whose blocking decisions DSH cannot honor. */
export const OBSERVED_ONLY_HOOK_EVENTS: ReadonlySet<string> = new Set(['PreCompact', 'Notification', 'StopFailure', 'PostCompact'])

/**
 * Handler types the broker executes (on the events Claude Code runs them on:
 * model handlers where Claude Code allows them, none at SessionStart).
 */
export const EXECUTED_HOOK_HANDLERS: ReadonlySet<string> = new Set(['command', 'http', 'mcp_tool', 'prompt', 'agent'])
