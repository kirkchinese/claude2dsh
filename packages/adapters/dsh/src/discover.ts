/** Discovery of DSH session logs below `$DSH_HOME/sessions`. */
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import type { DshDiscoverOptions, DiscoveredDshSession, DshSessionHeader } from './types.ts'
import { isZstdBuffer, scanZstdFrames } from './zstd.ts'

const PROBE_BYTES = 256 * 1024
const SESSION_FILE = /^session\.v(\d+)\.jsonl(?:\.zstd)?$/
const HEADER_FILES = ['header.json', 'session.json', 'session-header.json', 'meta.json']

/** `$DSH_HOME` with the harness's own precedence and default. */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DSH_HOME
  if (override !== undefined && override.trim().length > 0) return override.trim()
  return join(homedir(), '.dsh')
}

/** Default root that holds one directory per workspace and session. */
export function dshSessionsRoot(dshHome = resolveDshHome()): string {
  return join(dshHome, 'sessions')
}

/** True for a DSH session log name, compressed or plain. */
export function isDshSessionFile(path: string): boolean {
  return SESSION_FILE.test(basename(path))
}

function versionFromName(path: string): number {
  const match = SESSION_FILE.exec(basename(path))
  return match?.[1] === undefined ? 0 : Number(match[1])
}

function firstJsonObject(text: string): Record<string, unknown> | undefined {
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      return undefined
    }
  }
  return undefined
}

interface Probe {
  readonly record?: Record<string, unknown>
  readonly version: number
}

async function readProbe(path: string): Promise<Probe> {
  const version = versionFromName(path)
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    const length = Math.min(info.size, PROBE_BYTES)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    const head = buffer.subarray(0, bytesRead)
    if (isZstdBuffer(head)) {
      const scan = scanZstdFrames(head)
      const first = scan.frames[0]
      if (first !== undefined) {
        const text = zstdDecompressSync(head.subarray(first.start, first.end)).toString('utf8')
        const record = firstJsonObject(text)
        if (record !== undefined) return { record, version }
      }
    } else {
      const record = firstJsonObject(head.toString('utf8'))
      if (record !== undefined) return { record, version }
    }
  } finally {
    await handle.close()
  }
  return { version }
}

async function readSiblingHeader(path: string): Promise<Record<string, unknown> | undefined> {
  for (const name of HEADER_FILES) {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(dirname(path), name), 'utf8'))
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      // Try the next conventional header name.
    }
  }
  return undefined
}

function headerRecord(record: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (record === undefined) return undefined
  return record.type === 'session' ? record : undefined
}

function textField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function mapHeader(record: Record<string, unknown> | undefined, fallbackId: string, fallbackCreatedAt: number, fallbackVersion: number): DshSessionHeader {
  const id = textField(record, 'id') ?? textField(record, 'sessionId') ?? fallbackId
  const createdAt = numberField(record, 'createdAt') ?? fallbackCreatedAt
  const version = numberField(record, 'version') ?? fallbackVersion
  const cwd = textField(record, 'cwd')
  const title = textField(record, 'title')
  const parent = textField(record, 'parentSession') ?? textField(record, 'parentId')
  const depth = numberField(record, 'delegationDepth')
  const origin = record?.origin === 'subagent' ? 'subagent' as const : undefined
  const agentPreset = textField(record, 'agentPreset')
  return {
    id,
    version,
    createdAt,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(record?.isSeeded === true ? { isSeeded: true } : {}),
    ...(depth !== undefined ? { delegationDepth: depth } : {}),
    ...(origin !== undefined ? { origin } : {}),
    ...(parent !== undefined ? { parentSession: parent } : {}),
    ...(agentPreset !== undefined ? { agentPreset } : {}),
  }
}

async function describeSession(path: string): Promise<DiscoveredDshSession> {
  const probe = await readProbe(path)
  let record = headerRecord(probe.record)
  if (record === undefined) record = await readSiblingHeader(path)
  const info = await stat(path)
  const fallbackId = basename(dirname(path)).replace(/^session-/, '') || basename(path)
  const header = mapHeader(record, fallbackId, info.mtimeMs, probe.version)
  const auxiliary = (header.delegationDepth ?? 0) > 0 || header.origin === 'subagent' || header.parentSession !== undefined
  return {
    ref: resolve(path),
    dshId: header.id,
    version: header.version,
    createdAt: header.createdAt,
    ...(header.cwd !== undefined ? { cwd: header.cwd } : {}),
    ...(header.title !== undefined ? { title: header.title } : {}),
    isAuxiliary: auxiliary,
    ...(header.parentSession !== undefined ? { parentDshId: header.parentSession } : {}),
  }
}

async function walk(root: string, depth: number, maxDepth: number, out: string[]): Promise<void> {
  if (depth > maxDepth) return
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const absolute = join(root, entry.name)
    if (entry.isDirectory()) {
      await walk(absolute, depth + 1, maxDepth, out)
    } else if (entry.isFile() && isDshSessionFile(entry.name)) {
      out.push(absolute)
    }
  }
}

/** Discover DSH sessions below a sessions directory or a single log file. */
export async function* discoverDshSessions(root: string, options: DshDiscoverOptions = {}): AsyncGenerator<DiscoveredDshSession> {
  options.signal?.throwIfAborted()
  const absolute = resolve(root)
  let info
  try {
    info = await stat(absolute)
  } catch {
    return
  }
  const paths: string[] = []
  if (info.isFile()) {
    if (isDshSessionFile(absolute)) paths.push(absolute)
  } else if (info.isDirectory()) {
    await walk(absolute, 0, options.recursive === false ? 3 : 6, paths)
  }
  const found: DiscoveredDshSession[] = []
  for (const path of paths) {
    options.signal?.throwIfAborted()
    try {
      found.push(await describeSession(path))
    } catch {
      // A single unreadable artifact must not hide the rest of the corpus.
    }
  }
  found.sort((left, right) => left.createdAt - right.createdAt || left.ref.localeCompare(right.ref))
  for (const item of found) {
    if (item.isAuxiliary && options.includeAuxiliary === false) continue
    yield item
  }
}
