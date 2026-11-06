/** DSH home resolution shared by every DSH2Claude module. */
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** `$DSH_HOME` with the harness's own precedence and default. */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DSH_HOME
  if (override !== undefined && override.trim().length > 0) return override.trim()
  return join(homedir(), '.dsh')
}

/** Claude Code's home directory, honoring `CLAUDE_CONFIG_DIR`. */
export function resolveClaudeHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLAUDE_CONFIG_DIR
  if (override !== undefined && override.trim().length > 0) return override.trim()
  return join(homedir(), '.claude')
}

/**
 * Claude Code's user-level JSON config.
 *
 * The default layout keeps `~/.claude.json` next to `~/.claude`; a custom
 * Claude home is treated as self-contained and gets `<home>/.claude.json`.
 */
export function claudeUserConfigPath(claudeHome: string): string {
  const resolved = resolve(claudeHome)
  return basename(resolved) === '.claude'
    ? join(dirname(resolved), '.claude.json')
    : join(resolved, '.claude.json')
}
