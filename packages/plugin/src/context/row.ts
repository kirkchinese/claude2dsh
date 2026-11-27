/**
 * The context row: Claude Code's instruction files (`~/.claude/CLAUDE.md`,
 * `.claude/CLAUDE.md`, `@path` imports) and Codex's global `AGENTS.md` in the
 * system prompt, for what DSH's own instruction loader does not read. It
 * yields entirely when the Recollect plugin runs.
 * @module @kirkchinese/harness-forge/context
 */
import type { Context } from '@deepseek-ai/cordis'
import { ContextInstructions } from './instructions.js'
import type { Disposer } from '../forge/contract.js'
import { FORGE_SERVICE, type HarnessForge } from '../forge/service.js'
import { Parts, rowEffect } from '../forge/row.js'

export const name = 'harness-forge-context'
export const inject = [FORGE_SERVICE]

/** The context row. */
export function apply(ctx: Context): void {
  rowEffect(ctx, 'context', forge => startContext(ctx, forge))
}

/** Start the context row on the shared service. Returns its teardown. */
export function startContext(ctx: Context, forge: HarnessForge): Disposer {
  const instructions = new ContextInstructions(ctx, forge)
  const parts = new Parts(ctx, forge, 'context')
  parts.add('prompt section', () => instructions.install())
  parts.add('api', () => forge.provide('context', instructions.api()))
  return () => parts.dispose()
}
