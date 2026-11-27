/**
 * Preset row standing in for DSH's `tool-fs-search` when an agent's tool list
 * keeps only one of `glob` and `grep`: DSH's row registers both and has no
 * switch, and `tools.restrict` cannot hide a tool a preset row registers. This
 * row registers the listed one with DSH's own implementation and caps.
 * @module @kirkchinese/harness-forge/preset-fs-search
 */
import type { Context } from '@deepseek-ai/cordis'

/** The listed tools, and DSH's `tool-fs-search` config of the row this one replaces. */
export interface Config {
  tools: Array<'glob' | 'grep'>
  sampleOverCapGlobResults?: boolean
  globMaxResults?: number
  grepMaxMatches?: number
  grepMaxLineBytes?: number
  searchMetaMaxBytes?: number
  rawOutputMaxBytes?: number
  graceMs?: number
  stderrMaxBytes?: number
  timeoutMs?: number
}

export const name = 'harness-forge-fs-search'

/** What DSH's search tools need. */
export const inject = ['tools', 'systemPrompt', 'subprocess', 'workingDirectory']

interface FsSearch {
  readonly GLOB_MAX_RESULTS: number
  readonly GREP_MAX_MATCHES: number
  readonly GREP_MAX_LINE_BYTES: number
  readonly SEARCH_META_MAX_BYTES: number
  readonly RAW_OUTPUT_MAX_BYTES: number
  readonly SEARCH_GRACE_MS: number
  readonly SEARCH_STDERR_MAX_BYTES: number
  readonly SEARCH_TIMEOUT_MS: number
  applyGlobTool(ctx: Context, caps: Record<string, unknown>): void
  applyGrepTool(ctx: Context, caps: Record<string, unknown>): void
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const search = await import('@deepseek-ai/dsh-tool-fs-search' as string) as FsSearch
  const shared = {
    maxMetaBytes: config.searchMetaMaxBytes ?? search.SEARCH_META_MAX_BYTES,
    rawOutputMaxBytes: config.rawOutputMaxBytes ?? search.RAW_OUTPUT_MAX_BYTES,
    graceMs: config.graceMs ?? search.SEARCH_GRACE_MS,
    stderrMaxBytes: config.stderrMaxBytes ?? search.SEARCH_STDERR_MAX_BYTES,
    timeoutMs: config.timeoutMs ?? search.SEARCH_TIMEOUT_MS,
  }
  if (config.tools.includes('glob')) search.applyGlobTool(ctx, { ...shared, sampleOverCapGlobResults: config.sampleOverCapGlobResults ?? false, maxResults: config.globMaxResults ?? search.GLOB_MAX_RESULTS })
  if (config.tools.includes('grep')) search.applyGrepTool(ctx, { ...shared, maxMatches: config.grepMaxMatches ?? search.GREP_MAX_MATCHES, maxLineBytes: config.grepMaxLineBytes ?? search.GREP_MAX_LINE_BYTES })
}