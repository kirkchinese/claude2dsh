/** Durable source marker for every imported DSH session (native/codex reserved). */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveDshHome } from './registry.ts'

export type SessionSourceKind = 'claude-main' | 'claude-subagent' | 'claude-merged' | 'codex-main' | 'native'

export interface SessionSourceRecord {
  readonly sessionId: string
  readonly kind: SessionSourceKind
  readonly sourcePath: string
  readonly parentSession?: string
  readonly recordedAt: number
}

export interface SessionSourceMap {
  readonly version: 1
  readonly sessions: Record<string, SessionSourceRecord>
}

export function sessionSourceMapPath(dshHome = resolveDshHome()): string {
  return join(dshHome, 'claude2dsh', 'session-sources.json')
}

export async function loadSessionSourceMap(dshHome = resolveDshHome()): Promise<SessionSourceMap> {
  try {
    const parsed: unknown = JSON.parse(await readFile(sessionSourceMapPath(dshHome), 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && (parsed as { version?: unknown }).version === 1) return parsed as SessionSourceMap
  } catch {
    // Missing/corrupt map starts fresh.
  }
  return { version: 1, sessions: {} }
}

export async function saveSessionSource(record: SessionSourceRecord, dshHome = resolveDshHome()): Promise<void> {
  const map = await loadSessionSourceMap(dshHome)
  map.sessions[record.sessionId] = record
  const path = sessionSourceMapPath(dshHome)
  await mkdir(dirname(path), { recursive: true })
  const temp = join(dirname(path), `.session-sources-${randomUUID()}.tmp`)
  await writeFile(temp, JSON.stringify(map, null, 2) + '\n')
  await rename(temp, path)
}
