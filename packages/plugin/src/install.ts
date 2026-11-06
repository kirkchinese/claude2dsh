/**
 * Second phase: copy staged artifacts into Claude Code's own directory.
 *
 * This is the only module that writes below `~/.claude` (or a configured
 * `CLAUDE_CONFIG_DIR`). Existing different content is a conflict unless
 * `force` is explicit, and even then the old copy is renamed to a timestamped
 * backup rather than deleted.
 * @module @dsh2claude/plugin
 */
import { copyFile, cp, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { claudeUserConfigPath } from './dsh-home.ts'
import { hashBundle, hashBytes, loadManifest, safeTarget, saveManifest, stagedFileIntact, type StagedItem, type StagedKind } from './staging.ts'

export interface InstallItemResult {
  readonly kind: StagedKind
  readonly id: string
  readonly label: string
  readonly status: 'installed' | 'would-install' | 'skipped-identical' | 'conflict' | 'missing-staged' | 'failed'
  readonly targetPath: string
  readonly reason?: string
}

export interface InstallMcpResult {
  readonly server: string
  readonly status: 'installed' | 'would-install' | 'skipped-identical' | 'conflict'
  readonly reason?: string
}

export interface InstallReport {
  readonly dryRun: boolean
  readonly claudeHome: string
  readonly total: number
  readonly installed: number
  readonly skippedIdentical: number
  readonly conflicts: number
  readonly failed: number
  readonly items: readonly InstallItemResult[]
  readonly mcp?: readonly InstallMcpResult[]
}

async function pathHash(path: string): Promise<string> {
  const info = await stat(path)
  if (info.isDirectory()) return await hashBundle(path)
  return hashBytes(await readFile(path))
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function backupPath(target: string): string {
  return `${target}.dsh2claude-backup-${Date.now()}`
}

async function copyStaged(staged: string, target: string): Promise<void> {
  const info = await stat(staged)
  if (info.isDirectory()) {
    await cp(staged, target, { recursive: true, dereference: true, force: true })
    return
  }
  await mkdir(dirname(target), { recursive: true })
  await copyFile(staged, target)
}

async function installMcp(
  item: StagedItem,
  claudeHome: string,
  options: { dryRun: boolean; force: boolean },
): Promise<InstallMcpResult[]> {
  const staged = JSON.parse(await readFile(item.stagedPath, 'utf8')) as { mcpServers?: Record<string, unknown> }
  const servers = staged.mcpServers ?? {}
  const configPath = claudeUserConfigPath(claudeHome)
  let document: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) document = parsed as Record<string, unknown>
  } catch {
    // A missing or unreadable user config starts from an empty object.
  }
  const existing = typeof document.mcpServers === 'object' && document.mcpServers !== null && !Array.isArray(document.mcpServers)
    ? { ...(document.mcpServers as Record<string, unknown>) }
    : {}
  const results: InstallMcpResult[] = []
  let changed = false
  for (const [name, server] of Object.entries(servers)) {
    const current = existing[name]
    if (current !== undefined) {
      if (JSON.stringify(current) === JSON.stringify(server)) {
        results.push({ server: name, status: 'skipped-identical' })
        continue
      }
      if (!options.force) {
        results.push({ server: name, status: 'conflict', reason: `${name} already exists with different configuration` })
        continue
      }
    }
    if (options.dryRun) {
      results.push({ server: name, status: 'would-install' })
      continue
    }
    existing[name] = server
    changed = true
    results.push({ server: name, status: 'installed' })
  }
  if (changed) {
    await mkdir(dirname(configPath), { recursive: true })
    const temp = `${configPath}.dsh2claude-${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify({ ...document, mcpServers: existing }, null, 2)}\n`)
    await rename(temp, configPath)
  }
  return results
}

/**
 * Install staged items into Claude Code.
 *
 * `dryRun` is the default; callers must opt into writes explicitly. `kinds`
 * and `ids` narrow the selection so a user can install one session at a time.
 */
export async function installStaged(
  options: {
    readonly dshHome?: string
    readonly staging: string
    readonly claudeHome: string
    readonly kinds?: readonly StagedKind[]
    readonly ids?: readonly string[]
    readonly force?: boolean
    readonly dryRun?: boolean
  },
): Promise<InstallReport> {
  const dryRun = options.dryRun !== false
  const force = options.force === true
  const manifest = await loadManifest(options.dshHome)
  const kinds = options.kinds === undefined ? undefined : new Set(options.kinds)
  const ids = options.ids === undefined ? undefined : new Set(options.ids)
  const items = manifest.items.filter((item) => (kinds === undefined || kinds.has(item.kind)) && (ids === undefined || ids.has(item.id)))
  const results: InstallItemResult[] = []
  let mcp: InstallMcpResult[] | undefined

  for (const item of items) {
    const base = { kind: item.kind, id: item.id, label: item.label }
    if (!(await stagedFileIntact(options.staging, item))) {
      results.push({ ...base, status: 'missing-staged', targetPath: item.targetPath, reason: 'staged content is missing or was modified' })
      continue
    }
    if (item.kind === 'mcp') {
      if (dryRun) {
        mcp = await installMcp({ ...item, stagedPath: join(options.staging, item.stagedPath) }, options.claudeHome, { dryRun: true, force })
        results.push({ ...base, status: 'would-install', targetPath: claudeUserConfigPath(options.claudeHome) })
      } else {
        mcp = await installMcp({ ...item, stagedPath: join(options.staging, item.stagedPath) }, options.claudeHome, { dryRun: false, force })
        const changed = mcp.some((entry) => entry.status === 'installed')
        results.push({ ...base, status: changed ? 'installed' : mcp.some((entry) => entry.status === 'conflict') ? 'conflict' : 'skipped-identical', targetPath: claudeUserConfigPath(options.claudeHome) })
        if (changed || force) {
          item.status = 'installed'
          item.installedAt = Date.now()
        }
      }
      continue
    }

    let target: string
    try {
      target = safeTarget(options.claudeHome, item.targetPath)
    } catch (error) {
      results.push({ ...base, status: 'failed', targetPath: item.targetPath, reason: error instanceof Error ? error.message : String(error) })
      continue
    }
    const present = await exists(target)
    if (present) {
      const same = (await pathHash(target)) === item.sha256
      if (same) {
        results.push({ ...base, status: 'skipped-identical', targetPath: item.targetPath })
        if (!dryRun) {
          item.status = 'installed'
          item.installedAt ??= Date.now()
        }
        continue
      }
      if (!force) {
        results.push({ ...base, status: 'conflict', targetPath: item.targetPath, reason: 'target exists with different content' })
        continue
      }
    }
    if (dryRun) {
      results.push({ ...base, status: 'would-install', targetPath: item.targetPath })
      continue
    }
    try {
      if (present) await rename(target, backupPath(target))
      await copyStaged(join(options.staging, item.stagedPath), target)
      item.status = 'installed'
      item.installedAt = Date.now()
      results.push({ ...base, status: 'installed', targetPath: item.targetPath })
    } catch (error) {
      results.push({ ...base, status: 'failed', targetPath: item.targetPath, reason: error instanceof Error ? error.message : String(error) })
    }
  }

  if (!dryRun) await saveManifest(manifest, options.dshHome)
  return {
    dryRun,
    claudeHome: options.claudeHome,
    total: results.length,
    installed: results.filter((entry) => entry.status === 'installed').length,
    skippedIdentical: results.filter((entry) => entry.status === 'skipped-identical').length,
    conflicts: results.filter((entry) => entry.status === 'conflict').length,
    failed: results.filter((entry) => entry.status === 'failed' || entry.status === 'missing-staged').length,
    items: results,
    ...(mcp !== undefined ? { mcp } : {}),
  }
}

/** Summarize the manifest for the status tool and settings page. */
export function summarizeStaging(manifest: Awaited<ReturnType<typeof loadManifest>>): { total: number; staged: number; installed: number; kinds: Record<string, number> } {
  const kinds: Record<string, number> = {}
  for (const item of manifest.items) kinds[item.kind] = (kinds[item.kind] ?? 0) + 1
  return {
    total: manifest.items.length,
    staged: manifest.items.filter((item) => item.status === 'staged').length,
    installed: manifest.items.filter((item) => item.status === 'installed' || item.installedAt !== undefined).length,
    kinds,
  }
}
