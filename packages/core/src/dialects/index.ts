/**
 * Dialects: one folder per harness, behind one interface and a registry.
 * @module @kirkchinese/harness-forge-core
 */
export * from './types.js'
export * from './registry.js'
export { claudeCodeDialect } from './claude-code/index.js'
export { codexDialect } from './codex/index.js'
export { openCodeDialect } from './opencode/index.js'
export { agentPluginsDialect } from './agent-plugins/index.js'
export { agentSkillsDialect, skillFolders } from './agent-skills/index.js'
