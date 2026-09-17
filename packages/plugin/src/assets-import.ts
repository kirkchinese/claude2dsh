/**
 * Claude Code agent, command and MCP-server migration.
 *
 * Three Claude Code assets have no DSH counterpart under the same name, so each
 * is translated rather than copied:
 *
 * - An **agent** (`~/.claude/agents/*.md`) is a delegated persona with its own
 *   system prompt and tool list. DSH expresses delegated composition through
 *   presets, which need a composed configuration file; the portable translation
 *   is a skill carrying the same instructions, marked with its origin so a
 *   reader knows it was a subagent definition.
 * - A **command** (`~/.claude/commands/**\/*.md`) is a human-invoked prompt. A
 *   DSH skill is invocable from both surfaces, so the translation declares
 *   `disable-model-invocation: true`: the text reaches a human, never the model
 *   catalog, exactly as a slash command does.
 * - An **MCP server** (`~/.claude.json` and `<project>/.mcp.json`) is a DSH
 *   `mcp-client` plugin instance. The import writes a patch layer beside the
 *   import registry and reports the exact command that applies it; it never
 *   edits a profile itself.
 *
 * Nothing is overwritten: an existing target with different content is reported
 * as a conflict, and identical content is skipped.
 * @module @claude2dsh/plugin
 */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { safeSegment, safeSkillName } from './name-utils.ts'
import { skillsRoot } from './registry.ts'

/** Outcome of one translated asset. */
export interface AssetImportItem {
  /** Source file or server identifier. */
  readonly source: string
  /** Target skill name, or the MCP server namespace. */
  readonly target?: string
  readonly status: 'imported' | 'skipped-identical' | 'skipped-conflict' | 'unsupported' | 'failed'
  readonly reason?: string
}

/** Result of importing one asset family. */
export interface AssetImportReport {
  readonly root: string
  readonly total: number
  readonly imported: number
  readonly skippedIdentical: number
  readonly skippedConflict: number
  readonly unsupported: number
  readonly failed: number
  readonly items: readonly AssetImportItem[]
}

/** Mutable accumulator behind {@link AssetImportReport}. */
interface AssetAccumulator {
  root: string
  total: number
  imported: number
  skippedIdentical: number
  skippedConflict: number
  unsupported: number
  failed: number
  items: AssetImportItem[]
}

function emptyReport(root: string): AssetAccumulator {
  return { root, total: 0, imported: 0, skippedIdentical: 0, skippedConflict: 0, unsupported: 0, failed: 0, items: [] }
}

function record(report: AssetAccumulator, item: AssetImportItem): void {
  report.total += 1
  if (item.status === 'imported') report.imported += 1
  else if (item.status === 'skipped-identical') report.skippedIdentical += 1
  else if (item.status === 'skipped-conflict') report.skippedConflict += 1
  else if (item.status === 'unsupported') report.unsupported += 1
  else report.failed += 1
  report.items.push(item)
}

/** File name without its `.md` suffix. */
function basenameOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path
  return name.replace(/\.md$/i, '')
}

/** Claude's home, honouring `CLAUDE_CONFIG_DIR`. */
export function claudeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR !== undefined && env.CLAUDE_CONFIG_DIR.length > 0
    ? env.CLAUDE_CONFIG_DIR
    : join(homedir(), '.claude')
}

/** One parsed Markdown asset with YAML frontmatter. */
interface MarkdownAsset {
  readonly path: string
  readonly data: Record<string, unknown>
  readonly body: string
}

/** Parse a Markdown file whose leading `---` block is YAML frontmatter. */
async function readMarkdownAsset(path: string): Promise<MarkdownAsset | undefined> {
  const text = await readFile(path, 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (match === null) return { path, data: {}, body: text }
  const parsed: unknown = parseYaml(match[1] ?? '')
  const data = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {}
  return { path, data, body: text.slice(match[0].length) }
}

/** Recursively collect `*.md` files below a directory. */
async function findMarkdown(root: string): Promise<string[]> {
  const out: string[] = []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const absolute = join(root, entry.name)
    if (entry.isDirectory()) out.push(...await findMarkdown(absolute))
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(absolute)
  }
  return out
}

/** Quote a YAML scalar so a multi-line description stays one frontmatter value. */
function frontmatterText(value: string): string {
  return JSON.stringify(value)
}

/** Serialize skill frontmatter in the field order the loader documents. */
function skillFrontmatter(fields: {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  metadata: Record<string, unknown>
}): string {
  const lines = [
    '---',
    `name: ${fields.name}`,
    `description: ${frontmatterText(fields.description)}`,
    ...(fields.whenToUse !== undefined ? [`whenToUse: ${frontmatterText(fields.whenToUse)}`] : []),
    ...(fields.modelInvocable ? [] : ['disable-model-invocation: true']),
  ]
  const metadata = stringifyYaml({ metadata: fields.metadata }).trimEnd().split('\n')
  return [...lines, ...metadata, '---', '', ''].join('\n')
}

/** Write one translated skill, never replacing different content. */
async function writeSkill(
  report: AssetAccumulator,
  root: string,
  targetName: string,
  source: string,
  content: string,
): Promise<void> {
  const target = join(root, targetName, 'SKILL.md')
  try {
    const existing = await stat(target).catch(() => undefined)
    if (existing !== undefined) {
      const same = createHash('sha256').update(await readFile(target)).digest('hex')
        === createHash('sha256').update(content).digest('hex')
      record(report, same
        ? { source, target: targetName, status: 'skipped-identical' }
        : { source, target: targetName, status: 'skipped-conflict', reason: `${target} already exists with different content` })
      return
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, { flag: constants.O_EXCL | constants.O_CREAT | constants.O_WRONLY })
    record(report, { source, target: targetName, status: 'imported' })
  } catch (error) {
    record(report, { source, target: targetName, status: 'failed', reason: error instanceof Error ? error.message : String(error) })
  }
}

/** Provenance note prepended to every translated body. */
function provenanceNote(origin: string, details: readonly string[]): string {
  return [
    `> Migrated from ${origin} by Claude2DSH.`,
    ...details.map((detail) => `> ${detail}`),
    '',
    '',
  ].join('\n')
}

/**
 * Translate Claude Code subagent definitions into DSH skills.
 *
 * @param args - `path` overrides the default `~/.claude/agents` root; `namespace`
 *   prefixes the target skill name so assets from different plugins cannot collide.
 * @param dshHome - DSH home whose `skills` root receives the bundles.
 * @returns one item per discovered definition.
 */
export async function importClaudeAgents(args: { readonly path?: string; readonly namespace?: string }, dshHome?: string): Promise<AssetImportReport> {
  const root = args.path !== undefined && args.path.length > 0 ? args.path : join(claudeHome(), 'agents')
  const skills = skillsRoot(dshHome)
  const report = emptyReport(root)
  for (const path of await findMarkdown(root)) {
    const asset = await readMarkdownAsset(path)
    if (asset === undefined) continue
    const rawName = typeof asset.data.name === 'string' && asset.data.name.length > 0 ? asset.data.name : basenameOf(path)
    const targetName = safeSkillName(args.namespace ?? 'cc-agent', rawName)
    if (targetName.length === 0) {
      record(report, { source: path, status: 'failed', reason: `unsafe agent name "${rawName}"` })
      continue
    }
    const description = typeof asset.data.description === 'string' && asset.data.description.trim().length > 0
      ? asset.data.description.trim()
      : `Claude Code subagent "${rawName}" migrated as a skill.`
    const tools = Array.isArray(asset.data.tools) ? asset.data.tools.filter((tool): tool is string => typeof tool === 'string') : []
    const details = [
      `Claude Code ran this as a delegated subagent${typeof asset.data.model === 'string' ? ` on model ${asset.data.model}` : ''}.`,
      ...(tools.length > 0 ? [`Its Claude tool list was: ${tools.join(', ')}.`] : []),
      'In DSH it is a skill: the instructions below load into the current agent, which keeps its own tools.',
    ]
    const content = skillFrontmatter({
      name: targetName,
      description,
      ...(typeof asset.data.whenToUse === 'string' ? { whenToUse: asset.data.whenToUse } : {}),
      modelInvocable: true,
      metadata: { source: 'claude-code-agent', originalName: rawName, ...(tools.length > 0 ? { claudeTools: tools } : {}) },
    }) + provenanceNote(`Claude Code subagent definition ${path}`, details) + asset.body
    await writeSkill(report, skills, targetName, path, content)
  }
  return report
}

/**
 * Translate Claude Code slash commands into DSH user-invocable skills.
 *
 * A command under `commands/<namespace>/<name>.md` becomes `cc-cmd-<namespace>-<name>`,
 * mirroring Claude's own `/<namespace>:<name>` shape without the colon.
 *
 * @param args - `path` overrides the default `~/.claude/commands` root; `namespace`
 *   prefixes the target skill name so assets from different plugins cannot collide.
 * @param dshHome - DSH home whose `skills` root receives the bundles.
 * @returns one item per discovered command.
 */
export async function importClaudeCommands(args: { readonly path?: string; readonly namespace?: string }, dshHome?: string): Promise<AssetImportReport> {
  const root = args.path !== undefined && args.path.length > 0 ? args.path : join(claudeHome(), 'commands')
  const skills = skillsRoot(dshHome)
  const report = emptyReport(root)
  for (const path of await findMarkdown(root)) {
    const asset = await readMarkdownAsset(path)
    if (asset === undefined) continue
    const rel = relative(root, path).replace(/\.md$/i, '')
    const segments = rel.split(/[\\/]/).filter((segment) => segment.length > 0)
    const commandName = segments.join('-')
    const targetName = safeSkillName(args.namespace ?? 'cc-cmd', commandName)
    if (targetName.length === 0) {
      record(report, { source: path, status: 'failed', reason: `unsafe command name "${commandName}"` })
      continue
    }
    const description = typeof asset.data.description === 'string' && asset.data.description.trim().length > 0
      ? asset.data.description.trim()
      : typeof asset.data['argument-hint'] === 'string'
        ? `Claude Code command /${segments.join(':')}. Arguments: ${asset.data['argument-hint']}`
        : `Claude Code command /${segments.join(':')} migrated as a user-invocable skill.`
    const content = skillFrontmatter({
      name: targetName,
      description,
      modelInvocable: false,
      metadata: {
        source: 'claude-code-command',
        originalName: segments.join(':'),
        ...(typeof asset.data['argument-hint'] === 'string' ? { argumentHint: asset.data['argument-hint'] } : {}),
      },
    }) + provenanceNote(`Claude Code command /${segments.join(':')} (${path})`, [
      'Claude Code invoked this from the prompt as a slash command.',
      'The translation stays human-invocable and is excluded from the model catalog.',
      ...(typeof asset.data['allowed-tools'] === 'string' || Array.isArray(asset.data['allowed-tools'])
        ? ['Its Claude allowed-tools restriction does not carry over; the invoking agent keeps its own permissions.']
        : []),
    ]) + asset.body
    await writeSkill(report, skills, targetName, path, content)
  }
  return report
}

/** One MCP server declaration found in a Claude Code configuration file. */
export interface McpServerDeclaration {
  /** Where the declaration was found. */
  readonly source: string
  /** Server key in the configuration file. */
  readonly key: string
  /** Working directory a project-scoped declaration implies. */
  readonly projectDir?: string
  readonly transport: 'stdio' | 'streamable-http' | 'unsupported'
  readonly reason?: string
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Record<string, string>
  readonly url?: string
  readonly headers?: Record<string, string>
}

/** Result of the MCP import. */
export interface McpImportReport {
  readonly scannedFiles: readonly string[]
  readonly servers: number
  readonly supported: number
  readonly unsupported: number
  readonly patchPath?: string
  readonly applyCommand?: string
  readonly items: readonly { readonly server: string; readonly transport: string; readonly status: string; readonly reason?: string }[]
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry
  }
  return out
}

/** Read `mcpServers` from one JSON file, or nothing when the file or key is absent. */
async function readMcpServers(path: string): Promise<{ path: string; servers: Record<string, unknown>; projects?: Record<string, unknown> } | undefined> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  const servers = typeof document.mcpServers === 'object' && document.mcpServers !== null && !Array.isArray(document.mcpServers)
    ? document.mcpServers as Record<string, unknown>
    : {}
  const projects = typeof document.projects === 'object' && document.projects !== null && !Array.isArray(document.projects)
    ? document.projects as Record<string, unknown>
    : undefined
  return { path, servers, ...(projects !== undefined ? { projects } : {}) }
}

/** Normalize one Claude MCP entry into a declaration. */
function toDeclaration(source: string, key: string, value: unknown, projectDir?: string): McpServerDeclaration {
  const base = { source, key, ...(projectDir !== undefined ? { projectDir } : {}) }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ...base, transport: 'unsupported', reason: 'server entry is not an object' }
  }
  const entry = value as Record<string, unknown>
  const declared = typeof entry.type === 'string' ? entry.type : undefined
  if (typeof entry.command === 'string') {
    const args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === 'string') : []
    const env = stringRecord(entry.env)
    return {
      ...base,
      transport: 'stdio',
      command: entry.command,
      args,
      ...(env !== undefined ? { env } : {}),
    }
  }
  if (typeof entry.url === 'string') {
    const headers = stringRecord(entry.headers)
    if (declared === 'sse') {
      return { ...base, transport: 'unsupported', reason: 'the SSE transport has no DSH equivalent; re-declare the server over streamable HTTP to migrate it' }
    }
    return {
      ...base,
      transport: 'streamable-http',
      url: entry.url,
      ...(headers !== undefined ? { headers } : {}),
    }
  }
  return { ...base, transport: 'unsupported', reason: 'entry declares neither a command nor a url' }
}

/** Bound a server key to DSH's `[A-Za-z0-9_-]{1,32}` server namespace. */
function serverNamespace(key: string): string {
  const cleaned = key.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned.slice(0, 32)
}

/**
 * Discover every MCP server Claude Code would load.
 *
 * @param args - `path` overrides the default scan of `~/.claude.json` plus a project `.mcp.json`.
 * @param projectDir - project root whose `.mcp.json` is also scanned.
 * @returns declarations in scan order.
 */
export async function discoverClaudeMcpServers(args: { readonly path?: string; readonly projectDir?: string } = {}): Promise<{ scanned: string[]; declarations: McpServerDeclaration[] }> {
  const scanned: string[] = []
  const declarations: McpServerDeclaration[] = []
  const candidates = args.path !== undefined && args.path.length > 0
    ? [args.path]
    : [join(homedir(), '.claude.json'), ...(args.projectDir !== undefined && args.projectDir.length > 0 ? [join(args.projectDir, '.mcp.json')] : [])]
  for (const candidate of candidates) {
    const document = await readMcpServers(candidate)
    if (document === undefined) continue
    scanned.push(candidate)
    for (const [key, value] of Object.entries(document.servers)) {
      declarations.push(toDeclaration(candidate, key, value))
    }
    for (const [projectPath, projectValue] of Object.entries(document.projects ?? {})) {
      if (typeof projectValue !== 'object' || projectValue === null || Array.isArray(projectValue)) continue
      const servers = (projectValue as Record<string, unknown>).mcpServers
      if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) continue
      for (const [key, value] of Object.entries(servers as Record<string, unknown>)) {
        declarations.push(toDeclaration(candidate, key, value, projectPath))
      }
    }
  }
  return { scanned, declarations }
}

/** Render one `mcp-client` plugin row for the patch layer. */
function mcpPatchRow(declaration: McpServerDeclaration): { id: string; name: string; config: Record<string, unknown> } | undefined {
  const serverName = serverNamespace(declaration.key)
  if (serverName.length === 0) return undefined
  if (declaration.transport === 'stdio') {
    return {
      id: `claude2dsh-mcp-${serverName}`,
      name: '@deepseek-ai/dsh-mcp-client',
      config: {
        transport: 'stdio',
        serverName,
        command: declaration.command,
        args: [...(declaration.args ?? [])],
        env: { ...(declaration.env ?? {}) },
        ...(declaration.projectDir !== undefined ? { cwd: declaration.projectDir } : {}),
      },
    }
  }
  if (declaration.transport === 'streamable-http') {
    return {
      id: `claude2dsh-mcp-${serverName}`,
      name: '@deepseek-ai/dsh-mcp-client',
      config: {
        transport: 'streamable-http',
        serverName,
        url: declaration.url,
        headers: { ...(declaration.headers ?? {}) },
      },
    }
  }
  return undefined
}

/**
 * Translate Claude Code MCP servers into a DSH patch layer.
 *
 * The layer is written below `$DSH_HOME/claude2dsh/` and never applied to a
 * profile here: the report carries the exact `dsh --patch` command instead, so a
 * server can be inspected before it is ever connected.
 *
 * @param args - `path` overrides the Claude configuration file; `apply` writes the layer.
 * @param dshHome - DSH home that receives the patch layer.
 * @returns what was found, what translated, and where the layer landed.
 */
export async function importClaudeMcpServers(
  args: { readonly path?: string; readonly projectDir?: string; readonly apply?: boolean },
  dshHome?: string,
): Promise<McpImportReport> {
  const { scanned, declarations } = await discoverClaudeMcpServers(args)
  // DSH reserves one live server namespace per instance, so a second server
  // claiming the same name would fail at profile load; report the collision here
  // instead of emitting a layer that cannot boot.
  const claimed = new Set<string>()
  const rows = declarations.map((declaration) => {
    const row = mcpPatchRow(declaration)
    const serverName = row?.config['serverName']
    if (row === undefined || typeof serverName !== 'string') return { declaration, row: undefined }
    if (claimed.has(serverName)) {
      return {
        declaration: { ...declaration, transport: 'unsupported' as const, reason: `server namespace "${serverName}" is already claimed by an earlier declaration` },
        row: undefined,
      }
    }
    claimed.add(serverName)
    return { declaration, row }
  })
  const supported = rows.filter((entry) => entry.row !== undefined)
  const home = dshHome ?? join(homedir(), '.dsh')
  const patchPath = join(home, 'claude2dsh', 'mcp.patch.yml')
  const wrote = args.apply === true && supported.length > 0
  if (wrote) {
    await mkdir(dirname(patchPath), { recursive: true })
    const layer = supported.map((entry) => ({ insert: [entry.row] }))
    await writeFile(patchPath, stringifyYaml(layer))
  }
  return {
    scannedFiles: scanned,
    servers: declarations.length,
    supported: supported.length,
    unsupported: declarations.length - supported.length,
    ...(wrote ? { patchPath, applyCommand: `dsh --profile <profile> --patch ${patchPath}` } : {}),
    items: rows.map((entry) => ({
      server: entry.declaration.key,
      transport: entry.declaration.transport,
      status: entry.row === undefined ? 'unsupported' : args.apply === true ? 'written' : 'supported',
      ...(entry.declaration.reason !== undefined ? { reason: entry.declaration.reason } : {}),
    })),
  }
}
