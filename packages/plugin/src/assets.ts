/**
 * DSH skills, global instructions, and MCP declarations -> staged Claude assets.
 *
 * Nothing here writes below `~/.claude`; it only reads `$DSH_HOME` and fills
 * the staging tree. `install.ts` performs the second phase.
 * @module @dsh2claude/plugin
 */
import { cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { safeSegment } from './name-utils.ts'
import { hashBundle, stageBytes, upsertItem, type StagingManifest, type StagedItem } from './staging.ts'

export interface AssetStageReport {
  readonly kind: 'skills' | 'instructions' | 'mcp'
  readonly total: number
  readonly staged: number
  readonly skipped: number
  readonly failed: number
  readonly items: readonly { readonly id: string; readonly status: 'staged' | 'skipped' | 'failed'; readonly reason?: string }[]
}

function emptyReport(kind: AssetStageReport['kind']): { kind: AssetStageReport['kind']; total: number; staged: number; skipped: number; failed: number; items: { id: string; status: 'staged' | 'skipped' | 'failed'; reason?: string }[] } {
  return { kind, total: 0, staged: 0, skipped: 0, failed: 0, items: [] }
}

function record(report: ReturnType<typeof emptyReport>, id: string, status: 'staged' | 'skipped' | 'failed', reason?: string): void {
  report.total += 1
  if (status === 'staged') report.staged += 1
  else if (status === 'skipped') report.skipped += 1
  else report.failed += 1
  report.items.push({ id, status, ...(reason !== undefined ? { reason } : {}) })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function frontmatter(body: string): Record<string, unknown> {
  if (!body.startsWith('---')) return {}
  const end = body.indexOf('\n---', 3)
  if (end < 0) return {}
  try {
    const parsed: unknown = parseYaml(body.slice(3, end))
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

async function bundleStats(root: string): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) await walk(absolute)
      else if (entry.isFile()) {
        files += 1
        bytes += (await stat(absolute)).size
      }
    }
  }
  await walk(root)
  return { files, bytes }
}

async function stageSkillBundle(
  name: string,
  sourceDir: string,
  staging: string,
  manifest: StagingManifest,
  report: ReturnType<typeof emptyReport>,
  label: string,
): Promise<void> {
  const relativePath = join('skills', name)
  const stagedDir = join(staging, relativePath)
  await rm(stagedDir, { recursive: true, force: true })
  await mkdir(dirname(stagedDir), { recursive: true })
  await cp(sourceDir, stagedDir, { recursive: true, dereference: true })
  const digest = await hashBundle(stagedDir)
  const stats = await bundleStats(stagedDir)
  const item: StagedItem = {
    kind: 'skill',
    id: name,
    label,
    source: sourceDir,
    stagedPath: relativePath,
    targetPath: relativePath,
    sha256: digest,
    bytes: stats.bytes,
    stagedAt: Date.now(),
    status: 'staged',
  }
  upsertItem(manifest, item)
  record(report, name, 'staged')
}

/** Stage every discoverable DSH skill bundle or flat Markdown skill. */
export async function stageDshSkills(dshHome: string, staging: string, manifest: StagingManifest): Promise<AssetStageReport> {
  const report = emptyReport('skills')
  const root = join(dshHome, 'skills')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return report
  }
  entries.sort((left, right) => left.name.localeCompare(right.name))
  const claimed = new Set<string>()
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const absolute = join(root, entry.name)
    if (entry.isDirectory()) {
      const skillFile = join(absolute, 'SKILL.md')
      let body: string
      try {
        body = await readFile(skillFile, 'utf8')
      } catch {
        continue
      }
      const meta = frontmatter(body)
      const rawName = typeof meta.name === 'string' && meta.name.trim().length > 0 ? meta.name.trim() : entry.name
      const name = safeSegment(rawName)
      const description = typeof meta.description === 'string' ? meta.description.trim() : ''
      if (name.length === 0 || description.length === 0) {
        record(report, entry.name, 'failed', 'SKILL.md requires a kebab-case name and a non-empty description')
        continue
      }
      if (claimed.has(name)) {
        record(report, entry.name, 'skipped', `skill ${name} was already staged from another directory`)
        continue
      }
      claimed.add(name)
      try {
        await stageSkillBundle(name, absolute, staging, manifest, report, description)
      } catch (error) {
        record(report, entry.name, 'failed', error instanceof Error ? error.message : String(error))
      }
      continue
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      const body = await readFile(absolute, 'utf8')
      const meta = frontmatter(body)
      const rawName = typeof meta.name === 'string' && meta.name.trim().length > 0 ? meta.name.trim() : basename(entry.name, '.md')
      const name = safeSegment(rawName)
      const description = typeof meta.description === 'string' ? meta.description.trim() : ''
      if (name.length === 0 || description.length === 0) {
        record(report, entry.name, 'failed', 'flat skill requires a kebab-case name and a non-empty description')
        continue
      }
      if (claimed.has(name)) {
        record(report, entry.name, 'skipped', `skill ${name} was already staged`)
        continue
      }
      claimed.add(name)
      const relativePath = join('skills', name, 'SKILL.md')
      const staged = await stageBytes(staging, relativePath, Buffer.from(body, 'utf8'))
      const item: StagedItem = {
        kind: 'skill',
        id: name,
        label: description,
        source: absolute,
        stagedPath: join('skills', name),
        targetPath: join('skills', name),
        sha256: staged.sha256,
        bytes: staged.bytes,
        stagedAt: Date.now(),
        status: 'staged',
      }
      upsertItem(manifest, item)
      record(report, name, 'staged')
    }
  }
  return report
}

/** Stage `$DSH_HOME/AGENTS.md` as Claude's user-global `CLAUDE.md`. */
export async function stageDshInstructions(dshHome: string, staging: string, manifest: StagingManifest): Promise<AssetStageReport> {
  const report = emptyReport('instructions')
  const source = join(dshHome, 'AGENTS.md')
  let bytes: Buffer
  try {
    bytes = await readFile(source)
  } catch {
    return report
  }
  const staged = await stageBytes(staging, 'CLAUDE.md', bytes)
  upsertItem(manifest, {
    kind: 'instructions',
    id: 'AGENTS.md',
    label: 'Global AGENTS.md',
    source,
    stagedPath: 'CLAUDE.md',
    targetPath: 'CLAUDE.md',
    sha256: staged.sha256,
    bytes: staged.bytes,
    stagedAt: Date.now(),
    status: 'staged',
  })
  record(report, 'AGENTS.md', 'staged')
  return report
}

export interface ClaudeMcpServer {
  readonly type: 'stdio' | 'http' | 'sse'
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Record<string, string>
  readonly url?: string
  readonly headers?: Record<string, string>
}

export interface McpStageReport extends AssetStageReport {
  readonly servers: readonly string[]
  readonly conflicts: readonly { readonly server: string; readonly reason: string }[]
  readonly sources: readonly string[]
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function toClaudeServer(config: Record<string, unknown>): { server?: ClaudeMcpServer; reason?: string; name?: string } {
  const name = typeof config.serverName === 'string' && config.serverName.trim().length > 0 ? config.serverName.trim() : undefined
  const transport = typeof config.transport === 'string' ? config.transport : undefined
  if (name === undefined) return { reason: 'server row has no serverName' }
  if (transport === 'stdio' || typeof config.command === 'string') {
    if (typeof config.command !== 'string') return { reason: 'stdio server has no command' }
    const args = stringArray(config.args)
    const env = stringRecord(config.env)
    return {
      name,
      server: {
        type: 'stdio',
        command: config.command,
        ...(args !== undefined ? { args } : {}),
        ...(env !== undefined ? { env } : {}),
      },
    }
  }
  if (typeof config.url === 'string') {
    const type = transport === 'sse' ? 'sse' as const : 'http' as const
    const headers = stringRecord(config.headers)
    return {
      name,
      server: {
        type,
        url: config.url,
        ...(headers !== undefined ? { headers } : {}),
      },
    }
  }
  return { name, reason: 'server row declares neither a command nor a url' }
}

function collectPatchRows(value: unknown, out: Record<string, unknown>[], source: string): void {
  if (!Array.isArray(value)) return
  for (const entry of value) {
    if (!isRecord(entry)) continue
    if (typeof entry.name === 'string' && entry.name.includes('dsh-mcp-client') && isRecord(entry.config)) {
      out.push({ ...entry.config, __source: source })
    }
    if (Array.isArray(entry.insert)) collectPatchRows(entry.insert, out, source)
    if (Array.isArray(entry.replace)) collectPatchRows(entry.replace, out, source)
  }
}

function collectStorageRows(value: unknown, out: Record<string, unknown>[], source: string): void {
  if (!isRecord(value)) return
  const tables = isRecord(value.tables) ? value.tables : undefined
  const connections = tables !== undefined && isRecord(tables.connections) ? tables.connections : undefined
  if (connections === undefined) return
  for (const [key, connection] of Object.entries(connections)) {
    if (!isRecord(connection)) continue
    out.push({
      serverName: typeof connection.serverName === 'string' ? connection.serverName : key,
      transport: connection.transport,
      command: connection.command,
      args: connection.args,
      env: connection.env,
      url: connection.url,
      headers: connection.headers,
      __source: source,
    })
  }
}

/** Read every MCP declaration DSH knows about, from profiles and its storage. */
export async function discoverDshMcp(dshHome: string): Promise<{ rows: Record<string, unknown>[]; sources: string[] }> {
  const rows: Record<string, unknown>[] = []
  const sources: string[] = []
  const profiles = join(dshHome, 'profiles')
  let entries: import('node:fs').Dirent[] = []
  try {
    entries = await readdir(profiles, { withFileTypes: true })
  } catch {
    // No profiles directory is a valid empty state.
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    for (const name of ['cordis.patch.yml', 'cordis.yml']) {
      const file = join(profiles, entry.name, name)
      try {
        const parsed: unknown = parseYaml(await readFile(file, 'utf8'))
        collectPatchRows(parsed, rows, file)
        if (!sources.includes(file)) sources.push(file)
      } catch {
        // Missing or unparsable profile files contribute nothing.
      }
    }
  }
  const legacy = join(dshHome, 'claude2dsh', 'mcp.patch.yml')
  try {
    collectPatchRows(parseYaml(await readFile(legacy, 'utf8')), rows, legacy)
    sources.push(legacy)
  } catch {
    // The retired importer may not have created a layer.
  }
  const storage = join(dshHome, 'storages', 'mcp_connector.json')
  try {
    collectStorageRows(JSON.parse(await readFile(storage, 'utf8')), rows, storage)
    sources.push(storage)
  } catch {
    // No connector storage is normal on a fresh profile.
  }
  return { rows, sources }
}

/** Stage DSH MCP servers as a Claude merge payload. */
export async function stageDshMcp(dshHome: string, staging: string, manifest: StagingManifest): Promise<McpStageReport> {
  const base = emptyReport('mcp')
  const { rows, sources } = await discoverDshMcp(dshHome)
  const servers: Record<string, ClaudeMcpServer> = {}
  const conflicts: { server: string; reason: string }[] = []
  for (const row of rows) {
    const result = toClaudeServer(row)
    if (result.name === undefined) {
      record(base, String(row.__source ?? 'unknown'), 'failed', result.reason ?? 'unnamed MCP server')
      continue
    }
    if (result.server === undefined) {
      record(base, result.name, 'failed', result.reason ?? 'unsupported MCP server')
      continue
    }
    const existing = servers[result.name]
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(result.server)) {
        conflicts.push({ server: result.name, reason: 'the same server name is declared with different configuration' })
      }
      continue
    }
    servers[result.name] = result.server
  }
  const names = Object.keys(servers).sort()
  if (names.length > 0) {
    const payload = { version: 1, mcpServers: servers, sources, conflicts }
    const staged = await stageBytes(staging, 'mcp-servers.json', Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8'))
    upsertItem(manifest, {
      kind: 'mcp',
      id: 'mcp-servers',
      label: `${names.length} MCP server${names.length === 1 ? '' : 's'}`,
      source: sources.join(', ') || join(dshHome, 'profiles'),
      stagedPath: 'mcp-servers.json',
      targetPath: '.claude.json',
      sha256: staged.sha256,
      bytes: staged.bytes,
      stagedAt: Date.now(),
      status: 'staged',
    })
    record(base, 'mcp-servers', 'staged')
  }
  return { ...base, servers: names, conflicts, sources }
}


