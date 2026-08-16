/** Tool-result .txt sidecars: copy next to DSH home and keep a durable path map. */
import { constants } from 'node:fs'
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { NormalizedSession } from '@claude2dsh/core'
import { resolveDshHome } from './registry.ts'

export interface SidecarReference {
  readonly text: string
  readonly filename: string
}

export interface SidecarCopyItem {
  readonly filename: string
  readonly sourcePath: string
  readonly targetPath: string
  readonly status: 'copied' | 'reused' | 'missing' | 'too-large' | 'failed'
  readonly bytes: number
  readonly reason?: string
}

export interface SidecarCopyResult {
  readonly sessionId: string
  readonly referenced: number
  readonly copied: number
  readonly reused: number
  readonly missing: number
  readonly tooLarge: number
  readonly failed: number
  readonly items: SidecarCopyItem[]
}

export interface SidecarMap {
  readonly version: 1
  readonly sessions: Record<string, SidecarCopyItem[]>
}

export const DEFAULT_SIDECAR_MAX_BYTES = 64 * 1024 * 1024

const FILENAME = /tool-results\/([A-Za-z0-9_-]+\.txt)/g

export function sidecarMapPath(dshHome = resolveDshHome()): string {
  return join(dshHome, 'claude2dsh', 'sidecar-map.json')
}

export function sidecarRoot(dshHome = resolveDshHome()): string {
  return join(dshHome, 'claude2dsh', 'sidecars')
}

/** Find every tool-result sidecar path mentioned in one normalized session. */
export function findSidecarReferences(session: NormalizedSession, sourcePath: string): SidecarReference[] {
  const unique = new Map<string, SidecarReference>()
  const texts: string[] = []
  for (const turn of session.turns) {
    if (turn.prompt !== undefined) texts.push(turn.prompt)
    for (const block of turn.promptBlocks ?? []) if (block.type === 'text') texts.push(block.text)
    for (const step of turn.steps) {
      for (const block of step.content) if (block.type === 'text') texts.push(block.text)
      for (const result of step.toolResults) {
        for (const block of result.content) if (block.type === 'text') texts.push(block.text)
      }
    }
  }
  for (const text of texts) {
    for (const match of text.matchAll(FILENAME)) {
      const filename = match[1]
      if (filename === undefined) continue
      unique.set(filename, { text: match[0], filename })
    }
  }
  void sourcePath
  return [...unique.values()].sort((a, b) => a.filename.localeCompare(b.filename))
}

function sourceSessionDir(sourcePath: string): string {
  const fileDir = dirname(resolve(sourcePath))
  const parent = basename(fileDir)
  if (parent === 'subagents' || parent === 'workflows') return dirname(fileDir)
  const stem = basename(sourcePath).replace(/\.jsonl$/i, '')
  return join(fileDir, stem)
}

async function writeMap(map: SidecarMap, path: string): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  const temp = join(dir, `.sidecar-map-${randomUUID()}.tmp`)
  await writeFile(temp, JSON.stringify(map, null, 2) + '\n')
  await rename(temp, path)
}

export async function loadSidecarMap(dshHome = resolveDshHome()): Promise<SidecarMap> {
  try {
    const parsed: unknown = JSON.parse(await readFile(sidecarMapPath(dshHome), 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && (parsed as { version?: unknown }).version === 1) return parsed as SidecarMap
  } catch {
    // Missing or malformed maps start empty; the next successful copy rewrites them.
  }
  return { version: 1, sessions: {} }
}

/**
 * Copy every referenced sidecar under the size cap into
 * `$DSH_HOME/claude2dsh/sidecars/<sessionId>/` and persist the source/target
 * mapping. Original tool-result text keeps its original path reference; the
 * map is the durable translation layer for later tools.
 */
export async function copySessionSidecars(
  session: NormalizedSession,
  sourcePath: string,
  sessionId: string,
  dshHome = resolveDshHome(),
  maxBytes = DEFAULT_SIDECAR_MAX_BYTES,
): Promise<SidecarCopyResult> {
  const references = findSidecarReferences(session, sourcePath)
  const sourceDir = sourceSessionDir(sourcePath)
  const targetDir = join(sidecarRoot(dshHome), sessionId)
  const items: SidecarCopyItem[] = []
  let copied = 0
  let reused = 0
  let missing = 0
  let tooLarge = 0
  let failed = 0

  for (const ref of references) {
    const source = join(sourceDir, 'tool-results', ref.filename)
    const target = join(targetDir, ref.filename)
    try {
      const info = await stat(source)
      if (!info.isFile()) {
        missing += 1
        items.push({ filename: ref.filename, sourcePath: source, targetPath: target, status: 'missing', bytes: 0, reason: 'referenced file is not a regular file' })
        continue
      }
      if (info.size > maxBytes) {
        tooLarge += 1
        items.push({ filename: ref.filename, sourcePath: source, targetPath: target, status: 'too-large', bytes: info.size, reason: `size ${info.size} exceeds configured cap ${maxBytes}` })
        continue
      }
      const existing = await stat(target).catch(() => undefined)
      if (existing?.isFile() === true) {
        reused += 1
        items.push({ filename: ref.filename, sourcePath: source, targetPath: target, status: 'reused', bytes: info.size })
        continue
      }
      await mkdir(targetDir, { recursive: true })
      await copyFile(source, target, constants.COPYFILE_EXCL)
      copied += 1
      items.push({ filename: ref.filename, sourcePath: source, targetPath: target, status: 'copied', bytes: info.size })
    } catch (error) {
      failed += 1
      items.push({ filename: ref.filename, sourcePath: source, targetPath: target, status: 'failed', bytes: 0, reason: error instanceof Error ? error.message : String(error) })
    }
  }

  if (items.length > 0) {
    const map = await loadSidecarMap(dshHome)
    map.sessions[sessionId] = items
    await writeMap(map, sidecarMapPath(dshHome))
  }
  return { sessionId, referenced: references.length, copied, reused, missing, tooLarge, failed, items }
}
