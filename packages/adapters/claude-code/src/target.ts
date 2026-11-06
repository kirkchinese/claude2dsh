/** Claude Code target helpers: deterministic ids, project paths, validation. */
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ForeignSessionView } from '@dsh2claude/core'
import { serializeClaudeJsonl, slugifyClaudeCwd, type ClaudeSerializeResult } from './serialize.ts'

/**
 * Claude Code addresses a transcript by the UUID in its file name and in every
 * record's `sessionId`. A DSH id that is already a UUID is reused; anything
 * else is hashed into a stable RFC-4122-shaped UUID so re-running a migration
 * updates one file instead of creating a new copy each time.
 */
export function claudeSessionUuid(dshId: string): string {
  const stripped = dshId.replace(/^session-/, '')
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stripped)) return stripped.toLowerCase()
  const hex = createHash('sha256').update(dshId).digest('hex')
  const variant = ((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`
}

/** Claude project directory for one working directory. */
export function claudeProjectDir(claudeHome: string, cwd: string | undefined): string {
  return join(claudeHome, 'projects', slugifyClaudeCwd(cwd ?? process.cwd()))
}

/** Staged transcript path, relative to the staging root. */
export function claudeTranscriptRelativePath(cwd: string | undefined, sessionUuid: string): string {
  return join('projects', slugifyClaudeCwd(cwd ?? process.cwd()), `${sessionUuid}.jsonl`)
}

/**
 * Validate that a Claude transcript is a well-formed append-only chain:
 * every line parses, uuids are unique, and every parent appears earlier.
 */
export function verifyClaudeJsonl(content: string): boolean {
  const lines = content.split('\n')
  const seen = new Set<string>()
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line === undefined || line.trim() === '') {
      if (index === lines.length - 1) continue
      return false
    }
    let record: { uuid?: unknown; parentUuid?: unknown }
    try {
      record = JSON.parse(line) as { uuid?: unknown; parentUuid?: unknown }
    } catch {
      return false
    }
    if (typeof record.uuid === 'string') {
      if (seen.has(record.uuid)) return false
      seen.add(record.uuid)
      if (typeof record.parentUuid === 'string' && !seen.has(record.parentUuid)) return false
    }
  }
  return true
}

export interface RenderedClaudeTranscript extends ClaudeSerializeResult {
  readonly sessionUuid: string
  readonly relativePath: string
}

/** Serialize one DSH view into a validated Claude Code transcript. */
export function renderClaudeTranscript(view: ForeignSessionView, dshId: string): RenderedClaudeTranscript {
  const sessionUuid = claudeSessionUuid(dshId)
  const out = serializeClaudeJsonl(view, { sessionUuid })
  if (!verifyClaudeJsonl(out.jsonl)) throw new Error(`serialized transcript for ${dshId} is not a valid Claude JSONL chain`)
  return { ...out, sessionUuid, relativePath: claudeTranscriptRelativePath(view.cwd, sessionUuid) }
}

/** Write a rendered transcript below one root; `wx` unless overwrite is explicit. */
export async function writeClaudeTranscript(root: string, rendered: RenderedClaudeTranscript, options: { readonly overwrite?: boolean } = {}): Promise<string> {
  const path = join(root, rendered.relativePath)
  await mkdir(dirname(path), { recursive: true })
  if (options.overwrite === true) {
    await writeFile(path, rendered.jsonl)
  } else {
    await writeFile(path, rendered.jsonl, { flag: 'wx' })
  }
  return path
}

/** Read an existing transcript, if present. */
export async function readClaudeTranscript(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}
