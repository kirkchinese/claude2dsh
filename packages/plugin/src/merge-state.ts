/** Durable record of every three-way merge performed by explicit tools. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveDshHome } from './registry.ts'

export interface MergeConflictRecord {
  readonly turn: number
  readonly claudeEvents: number
  readonly dshEvents: number
}

export interface MergeRecord {
  readonly direction: 'claude-to-dsh' | 'dsh-to-claude'
  readonly originalSessionId: string
  readonly resultSessionId: string
  readonly filePath: string
  readonly mergedAt: number
  readonly baseEvents: number
  readonly claudeTurns: number[]
  readonly dshTurns: number[]
  readonly conflicts: MergeConflictRecord[]
}

export interface MergeMap {
  readonly version: 1
  readonly records: MergeRecord[]
}

export function mergeMapPath(dshHome = resolveDshHome()): string {
  return join(dshHome, 'claude2dsh', 'merge-map.json')
}

export async function loadMergeMap(dshHome = resolveDshHome()): Promise<MergeMap> {
  try {
    const parsed: unknown = JSON.parse(await readFile(mergeMapPath(dshHome), 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && (parsed as { version?: unknown }).version === 1) return parsed as MergeMap
  } catch {
    // Missing/corrupt map starts fresh.
  }
  return { version: 1, records: [] }
}

export async function saveMergeRecord(record: MergeRecord, dshHome = resolveDshHome()): Promise<void> {
  const map = await loadMergeMap(dshHome)
  map.records.push(record)
  const path = mergeMapPath(dshHome)
  await mkdir(dirname(path), { recursive: true })
  const temp = join(dirname(path), `.merge-map-${randomUUID()}.tmp`)
  await writeFile(temp, JSON.stringify(map, null, 2) + '\n')
  await rename(temp, path)
}
