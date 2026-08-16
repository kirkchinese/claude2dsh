/** Main and auxiliary transcript discovery for the Claude Code projects layout. */
import { open, readdir, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { AdapterOptions, DiscoveredSession } from '@claude2dsh/core'
import type { ClaudeFileProbe, RawJson } from './types.ts'
import { parseTimestamp } from './time.ts'

const PROBE_BYTES = 256 * 1024

async function probeHead(filePath: string, auxiliary: boolean): Promise<ClaudeFileProbe> {
  const handle = await open(filePath, 'r')
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, PROBE_BYTES)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    const head = buffer.toString('utf8', 0, bytesRead)
    return parseProbe(head, basename(filePath).replace(/\.jsonl$/i, ''), auxiliary)
  } finally {
    await handle.close()
  }
}

function parseProbe(head: string, fileStem: string, auxiliary: boolean): ClaudeFileProbe {
  const lines = head.split('\n')
  let sessionId: string | undefined
  let agentId: string | undefined
  let cwd: string | undefined
  let title: string | undefined
  let createdAt: number | undefined
  for (const raw of lines) {
    if (raw.length === 0) continue
    let record: RawJson
    try {
      record = JSON.parse(raw) as RawJson
    } catch {
      continue
    }
    if (sessionId === undefined && typeof record.sessionId === 'string' && record.sessionId.length > 0) sessionId = record.sessionId
    if (agentId === undefined && typeof record.agentId === 'string' && record.agentId.length > 0) agentId = record.agentId
    if (cwd === undefined && typeof record.cwd === 'string' && record.cwd.length > 0) cwd = record.cwd
    if (createdAt === undefined && record.timestamp !== undefined) createdAt = parseTimestamp(record.timestamp, createdAt)
    if (title === undefined && record.type === 'ai-title' && typeof record.aiTitle === 'string' && record.aiTitle.trim().length > 0) {
      title = record.aiTitle.trim()
    }
    if (cwd !== undefined && createdAt !== undefined && title !== undefined) break
  }
  return {
    sourceId: auxiliary ? (agentId ?? fileStem) : (sessionId ?? fileStem),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  }
}

/** True for direct main-transcript candidates (excludes sidecars/subagents). */
export function isMainTranscriptPath(filePath: string): boolean {
  const parts = filePath.split(/[\\/]/)
  return extname(filePath).toLowerCase() === '.jsonl'
    && !parts.includes('subagents')
    && !parts.includes('workflows')
    && !parts.includes('tool-results')
    && !/^journal\.jsonl$/i.test(basename(filePath))
}

/** True for subagent/workflow agent transcripts that can be imported separately. */
export function isAuxiliaryTranscriptPath(filePath: string): boolean {
  const parts = filePath.split(/[\\/]/)
  return extname(filePath).toLowerCase() === '.jsonl'
    && (parts.includes('subagents') || parts.includes('workflows'))
    && !/^journal\.jsonl$/i.test(basename(filePath))
}

function pushDiscovered(out: DiscoveredSession[], absolute: string, probe: ClaudeFileProbe, auxiliary: boolean): void {
  out.push({
    ref: absolute,
    sourceId: probe.sourceId,
    ...(probe.cwd !== undefined ? { cwd: probe.cwd } : {}),
    ...(probe.title !== undefined ? { title: probe.title } : {}),
    ...(probe.createdAt !== undefined ? { createdAt: probe.createdAt } : {}),
    ...(auxiliary ? { origin: 'subagent' as const } : {}),
    ...(auxiliary && probe.sessionId !== undefined ? { parentSourceId: probe.sessionId } : {}),
  })
}

async function discoverDirectory(dirPath: string, maxDepth: number, currentDepth: number, out: DiscoveredSession[]): Promise<void> {
  const entries = await readdir(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'subagents' || entry.name === 'workflows' || entry.name === 'tool-results') continue
    const absolute = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      if (currentDepth < maxDepth) await discoverDirectory(absolute, maxDepth, currentDepth + 1, out)
      continue
    }
    if (!entry.isFile() || !isMainTranscriptPath(absolute)) continue
    const probe = await probeHead(absolute, false)
    pushDiscovered(out, absolute, probe, false)
  }
}

async function discoverAuxiliary(dirPath: string, out: DiscoveredSession[]): Promise<void> {
  const entries = await readdir(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'tool-results') continue
    const absolute = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      await discoverAuxiliary(absolute, out)
      continue
    }
    if (!entry.isFile() || !isAuxiliaryTranscriptPath(absolute)) continue
    const probe = await probeHead(absolute, true)
    pushDiscovered(out, absolute, probe, true)
  }
}

/** Discover Claude Code transcripts below `root`. */
export async function* discoverClaudeCodeSessions(root: string, options: AdapterOptions = {}): AsyncGenerator<DiscoveredSession> {
  options.signal?.throwIfAborted()
  let info
  try {
    info = await stat(root)
  } catch {
    return
  }
  if (info.isFile()) {
    const auxiliary = isAuxiliaryTranscriptPath(root)
    if (isMainTranscriptPath(root) || auxiliary) {
      const probe = await probeHead(root, auxiliary)
      const item: DiscoveredSession = {
        ref: root,
        sourceId: probe.sourceId,
        ...(probe.cwd !== undefined ? { cwd: probe.cwd } : {}),
        ...(probe.title !== undefined ? { title: probe.title } : {}),
        ...(probe.createdAt !== undefined ? { createdAt: probe.createdAt } : {}),
        ...(auxiliary ? { origin: 'subagent' as const } : {}),
        ...(auxiliary && probe.sessionId !== undefined ? { parentSourceId: probe.sessionId } : {}),
      }
      yield item
    }
    return
  }
  if (!info.isDirectory()) return

  const found: DiscoveredSession[] = []
  const direct = await readdir(root, { withFileTypes: true })
  const hasDirectTranscripts = direct.some((entry) => entry.isFile() && isMainTranscriptPath(join(root, entry.name)))
  if (hasDirectTranscripts) {
    for (const entry of direct) {
      if (!entry.isFile() || !isMainTranscriptPath(join(root, entry.name))) continue
      const absolute = join(root, entry.name)
      const probe = await probeHead(absolute, false)
      pushDiscovered(found, absolute, probe, false)
    }
  } else {
    await discoverDirectory(root, options.recursive === true ? Number.POSITIVE_INFINITY : 1, 0, found)
  }
  if (options.includeAuxiliary === true) {
    await discoverAuxiliary(root, found)
  }
  found.sort((a, b) => a.ref.localeCompare(b.ref))
  for (const item of found) yield item
}
