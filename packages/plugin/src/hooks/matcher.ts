/**
 * Matcher-group selection, as each harness defines it.
 *
 * Claude Code: `*`, `""` or no matcher match everything; a matcher made only
 * of letters, digits, `_`, `-`, spaces, `,` and `|` is a list of exact
 * strings (`FileChanged` and `StopFailure` use the narrower `[A-Za-z0-9_|]`
 * set); anything else is an unanchored JavaScript regular expression. Events
 * without matcher support ignore the matcher.
 *
 * Codex: the matcher is always a regular expression, tested against the tool
 * name and its aliases.
 * @module @kirkchinese/harness-forge
 */
import type { HookDialect } from './vocabulary.js'

/** Claude Code events whose matcher is ignored. */
const CLAUDE_UNMATCHED = new Set([
  'UserPromptSubmit', 'PostToolBatch', 'Stop', 'TeammateIdle', 'TaskCreated', 'TaskCompleted',
  'WorktreeCreate', 'WorktreeRemove', 'MessageDisplay', 'CwdChanged',
])

/** Codex events whose matcher is ignored. */
const CODEX_UNMATCHED = new Set(['UserPromptSubmit', 'Stop', 'Interrupt', 'PreModelRequest', 'PostModelRequest'])

const NARROW_EXACT = new Set(['FileChanged', 'StopFailure'])

/**
 * Whether a matcher group runs for this occurrence.
 * @param subjects - the value the event matches on; tool events pass every
 *   name the tool answers to.
 */
export function matcherSelects(dialect: HookDialect, event: string, matcher: string | undefined, subjects: readonly string[]): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true
  if ((dialect === 'codex' ? CODEX_UNMATCHED : CLAUDE_UNMATCHED).has(event)) return true
  if (dialect === 'claude-code') {
    const exact = NARROW_EXACT.has(event) ? /^[A-Za-z0-9_|]+$/u : /^[A-Za-z0-9_\- ,|]+$/u
    if (exact.test(matcher)) {
      const options = matcher.split(NARROW_EXACT.has(event) ? /\|/u : /[|,]/u).map(item => item.trim()).filter(item => item.length > 0)
      return subjects.some(subject => options.includes(subject))
    }
  }
  let pattern: RegExp
  try {
    pattern = new RegExp(matcher, 'u')
  } catch {
    try {
      pattern = new RegExp(matcher)
    } catch {
      return false
    }
  }
  return subjects.some(subject => pattern.test(subject))
}
