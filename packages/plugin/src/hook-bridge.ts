/**
 * Validated wrapper around the official DSH Claude Code hook bridge.
 *
 * The upstream bridge intentionally contains a malformed config and keeps
 * booting. This wrapper fails loud at load time with the exact path and
 * reason, which is the right behavior for an opt-in compatibility layer.
 * @module @claude2dsh/plugin
 */
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import * as upstream from '@deepseek-ai/dsh-hooks-claude-code'

export const name = 'claude2dsh-hooks'
export const inject = upstream.inject
export function validateHookConfig(configPath: string): void {
  let text: string
  try {
    text = readFileSync(configPath, 'utf8')
  } catch (error) {
    throw new Error(`claude2dsh hook bridge: cannot read hooks config at ${configPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`claude2dsh hook bridge: invalid JSON in ${configPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || !('hooks' in parsed) || typeof parsed.hooks !== 'object' || parsed.hooks === null) {
    throw new Error(`claude2dsh hook bridge: ${configPath} must contain a "hooks" object`)
  }
}

export function apply(ctx: Context, config: upstream.Config): void {
  validateHookConfig(config.configPath)
  upstream.apply(ctx, config)
}
