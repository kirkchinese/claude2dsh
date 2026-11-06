/**
 * Durable staging area for everything DSH2Claude produces.
 *
 * Migration is two-phase on purpose: `stage` writes only below `$DSH_HOME`
 * (never `~/.claude`), and `install` is the one operation that touches Claude
 * Code's directory. A manifest carries the source, staged path, target path and
 * content hash so a second run can report `skipped-identical` instead of
 * overwriting, and a partial install can resume.
 * @module @dsh2claude/plugin
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { resolveDshHome } from './dsh-home.ts'

export const STAGING_VERSION = 1

export type StagedKind = 'session' | 'skill' | 'instructions' | 'mcp'

export interface StagedItem {
  readonly kind: StagedKind
  /** DSH session id, skill name, or asset id. */
  readonly id: string
  readonly label: string
  /** Absolute source path below `$DSH_HOME`. */
  readonly source: string
  /** Path relative to the staging root. */
  readonly stagedPath: string
  /** Path relative to the Claude home. */
  readonly targetPath: string
  readonly sha256: string
  readonly bytes: number
  readonly stagedAt: number
  status: 'staged' | 'installed' | 'skipped-identical' | 'conflict' | 'failed'
  installedAt?: number
  readonly reason?: string
}

export interface StagingManifest {
  readonly version: typeof STAGING_VERSION
  readonly createdAt: number
  updatedAt: number
  items: StagedItem[]
}

export function stagingRoot(dshHome = resolveDshHome()): string {
  return join(dshHome, 'dsh2claude', 'staging')
}

export function manifestPath(dshHome = resolveDshHome()): string {
  return join(stagingRoot(dshHome), 'manifest.json')
}

export function emptyManifest(now = Date.now()): StagingManifest {
  return { version: STAGING_VERSION, createdAt: now, updatedAt: now, items: [] }
}

export async function loadManifest(dshHome = resolveDshHome()): Promise<StagingManifest> {
  try {
    const parsed: unknown = JSON.parse(await readFile(manifestPath(dshHome), 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && (parsed as { version?: unknown }).version === STAGING_VERSION && Array.isArray((parsed as { items?: unknown }).items)) {
      return parsed as StagingManifest
    }
  } catch {
    // Missing or corrupt manifests start empty; the next stage rewrites them.
  }
  return emptyManifest()
}

export async function saveManifest(manifest: StagingManifest, dshHome = resolveDshHome()): Promise<void> {
  const path = manifestPath(dshHome)
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, `${JSON.stringify({ ...manifest, updatedAt: Date.now() }, null, 2)}\n`)
  await rename(temp, path)
}

export function itemKey(kind: StagedKind, id: string): string {
  return `${kind}:${id}`
}

/** Insert or replace one item, preserving an existing install timestamp. */
export function upsertItem(manifest: StagingManifest, item: StagedItem): void {
  const index = manifest.items.findIndex((candidate) => itemKey(candidate.kind, candidate.id) === itemKey(item.kind, item.id))
  const previous = index >= 0 ? manifest.items[index] : undefined
  const next: StagedItem = previous?.installedAt !== undefined && previous.sha256 === item.sha256
    ? { ...item, status: 'installed', installedAt: previous.installedAt }
    : item
  if (index >= 0) manifest.items[index] = next
  else manifest.items.push(next)
}

export function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Stable hash of a directory tree: relative names plus file bytes. */
export async function hashBundle(root: string): Promise<string> {
  const hash = createHash('sha256')
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute)
      } else if (entry.isFile()) {
        hash.update(relative(root, absolute).split('\\').join('/'))
        hash.update(await readFile(absolute))
      }
    }
  }
  await walk(root)
  return hash.digest('hex')
}

/** Copy a buffer into the staging tree and return its hash. */
export async function stageBytes(root: string, relativePath: string, bytes: Buffer): Promise<{ path: string; sha256: string; bytes: number }> {
  const path = join(root, relativePath)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
  return { path, sha256: hashBytes(bytes), bytes: bytes.byteLength }
}

/** Ensure a manifest target path cannot escape the Claude home. */
export function safeTarget(claudeHome: string, targetPath: string): string {
  const home = resolve(claudeHome)
  const target = resolve(home, targetPath)
  const rel = relative(home, target)
  if (rel.startsWith('..') || resolve(home, rel) !== target) throw new Error(`refusing target outside Claude home: ${targetPath}`)
  return target
}

/** True when a path exists. */
export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Verify a staged directory or file still matches the hash recorded in the manifest. */
export async function stagedFileIntact(staging: string, item: StagedItem): Promise<boolean> {
  const path = join(staging, item.stagedPath)
  try {
    const info = await stat(path)
    if (info.isDirectory()) return (await hashBundle(path)) === item.sha256
    return hashBytes(await readFile(path)) === item.sha256
  } catch {
    return false
  }
}
