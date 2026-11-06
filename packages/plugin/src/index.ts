/**
 * DSH2Claude migration plugin for DeepSeek Harness.
 *
 * The plugin reads `$DSH_HOME` directly (session logs, skills, instructions and
 * MCP declarations) and writes only below `$DSH_HOME/dsh2claude/staging`.
 * `dsh2claude_install` is the one operation that copies staged artifacts into
 * Claude Code's directory, and it requires explicit confirmation.
 * @module @dsh2claude/plugin
 */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool, type ToolResult } from '@deepseek-ai/dsh-tools'
import { resolveClaudeHome, resolveDshHome } from './dsh-home.ts'
import { installStaged, summarizeStaging } from './install.ts'
import { listDshSessionInventory, migrateDsh } from './migrate.ts'
import { registerDsh2ClaudeRoutes } from './settings-routes.ts'
import { createSettingsRuntime, type Dsh2ClaudeSettings } from './settings-service.ts'
import { loadManifest, stagingRoot, type StagedKind } from './staging.ts'

export const name = 'dsh2claude-import'
export const inject = ['tools']

/** Bundle configuration; every value is also editable in Settings. */
export interface PluginConfig {
  readonly dshHome?: string
  readonly claudeHome?: string
  readonly includeSubagents?: boolean
}

function genericResult(title: string, summary: string): { card: 'generic'; title: string; content: { type: 'text'; text: string }[] } {
  return { card: 'generic', title, content: [{ type: 'text', text: summary }] }
}

function parseResultText(value: ToolResult): unknown {
  const raw = value.content.find((block) => block.type === 'text')?.text
  if (raw === undefined) return undefined
  try { return JSON.parse(raw) } catch { return undefined }
}

function jsonToolOutput(): { schema: { type: 'json' }; render: (args: unknown, value: unknown) => { type: 'text'; text: string }[] } {
  return {
    schema: { type: 'json' as const },
    render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  }
}

function splitList(value: unknown): string[] | undefined {
  if (typeof value !== 'string') return undefined
  const items = value.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
  return items.length > 0 ? items : undefined
}

const KINDS: readonly StagedKind[] = ['session', 'skill', 'instructions', 'mcp']

function splitKinds(value: unknown): StagedKind[] | undefined {
  const items = splitList(value)
  if (items === undefined) return undefined
  const kinds = items.filter((item): item is StagedKind => (KINDS as readonly string[]).includes(item))
  return kinds.length > 0 ? kinds : undefined
}

function resolvedPaths(settings: Dsh2ClaudeSettings): { dshHome: string; claudeHome: string; root: string } {
  const dshHome = settings.sessions.dshHome.trim().length > 0 ? settings.sessions.dshHome.trim() : resolveDshHome()
  const claudeHome = settings.install.claudeHome.trim().length > 0 ? settings.install.claudeHome.trim() : resolveClaudeHome()
  const root = settings.sessions.root.trim().length > 0 ? settings.sessions.root.trim() : join(dshHome, 'sessions')
  return { dshHome, claudeHome, root }
}

/**
 * Activate the plugin.
 * @param ctx - Cordis context of the profile that mounted this plugin.
 * @param config - optional bundle configuration.
 */
export function apply(ctx: Context, config: PluginConfig = {}): void {
  const settings = createSettingsRuntime(ctx, config)
  registerDsh2ClaudeRoutes(ctx, settings)

  ctx.tools.register(defineTool({
    name: 'dsh2claude_migrate',
    description: [
      'Stage DeepSeek Harness sessions, skills, global AGENTS.md and MCP servers for Claude Code.',
      'Reads $DSH_HOME only and writes under $DSH_HOME/dsh2claude/staging; it never touches ~/.claude.',
      'preview:true renders the conversion report without writing. Use dsh2claude_install to copy staged artifacts into Claude Code.',
    ].join('\n'),
    parameters: {
      path: { type: 'string', description: 'Sessions directory or one session.v*.jsonl[.zstd] file. Defaults to the configured sessions root.' },
      includeSubagents: { type: 'boolean', description: 'Also migrate delegated child sessions (default from Settings).' },
      skills: { type: 'boolean', description: 'Stage $DSH_HOME/skills (default from Settings).' },
      instructions: { type: 'boolean', description: 'Stage $DSH_HOME/AGENTS.md as Claude CLAUDE.md (default from Settings).' },
      mcp: { type: 'boolean', description: 'Stage MCP servers found in DSH profiles/storage (default from Settings).' },
      only: { type: 'string', description: 'Comma-separated DSH session ids to migrate.' },
      preview: { type: 'boolean', description: 'Report the conversion without writing anything.' },
    },
    output: jsonToolOutput(),
    presentCall: (args) => ({ card: 'generic', title: 'Stage DSH data for Claude Code', kind: 'other', rawInput: (args as { path?: unknown }).path }),
    presentResult: (_args, value: ToolResult) => {
      const report = (parseResultText(value) ?? {}) as { sessions?: { staged?: number; updated?: number; skippedIdentical?: number; failed?: number }; skills?: { staged?: number }; instructions?: { staged?: number }; mcp?: { servers?: unknown[] } }
      const sessions = report.sessions ?? {}
      return genericResult('DSH2Claude stage', `sessions staged=${sessions.staged ?? 0} updated=${sessions.updated ?? 0} identical=${sessions.skippedIdentical ?? 0} failed=${sessions.failed ?? 0}; skills=${report.skills?.staged ?? 0} instructions=${report.instructions?.staged ?? 0} mcp=${report.mcp?.servers?.length ?? 0}`)
    },
    async execute(args) {
      const current = settings.get()
      const paths = resolvedPaths(current)
      const only = splitList(args.only)
      const report = await migrateDsh({
        dshHome: paths.dshHome,
        path: typeof args.path === 'string' && args.path.trim().length > 0 ? args.path.trim() : paths.root,
        recursive: current.sessions.recursive,
        includeSubagents: typeof args.includeSubagents === 'boolean' ? args.includeSubagents : current.sessions.includeSubagents,
        skills: typeof args.skills === 'boolean' ? args.skills : current.assets.skills,
        instructions: typeof args.instructions === 'boolean' ? args.instructions : current.assets.instructions,
        mcp: typeof args.mcp === 'boolean' ? args.mcp : current.assets.mcp,
        preview: args.preview === true,
        ...(only !== undefined ? { only } : {}),
      })
      return report as unknown as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dsh2claude_install',
    description: [
      'Copy staged DSH2Claude artifacts into Claude Code (~/.claude or CLAUDE_CONFIG_DIR).',
      'Dry-run unless confirm:true is passed. Existing different content is a conflict; force:true renames the old copy to a timestamped backup first.',
      'MCP servers are merged into ~/.claude.json without touching unrelated entries.',
    ].join('\n'),
    parameters: {
      confirm: { type: 'boolean', description: 'Required to perform writes. Without it the call only previews.' },
      dryRun: { type: 'boolean', description: 'Preview the install even when confirm is true.' },
      force: { type: 'boolean', description: 'Replace conflicting targets after renaming the old copy to a backup.' },
      kinds: { type: 'string', description: 'Comma-separated subset: session,skill,instructions,mcp.' },
      ids: { type: 'string', description: 'Comma-separated staged item ids (DSH session id, skill name, or asset id).' },
    },
    output: jsonToolOutput(),
    presentCall: (args) => ({ card: 'generic', title: 'Install staged data into Claude Code', kind: 'other', rawInput: (args as { kinds?: unknown }).kinds }),
    presentResult: (_args, value: ToolResult) => {
      const report = (parseResultText(value) ?? {}) as { dryRun?: boolean; installed?: number; skippedIdentical?: number; conflicts?: number; failed?: number }
      return genericResult('DSH2Claude install', `${report.dryRun === true ? 'preview ' : ''}installed=${report.installed ?? 0} identical=${report.skippedIdentical ?? 0} conflicts=${report.conflicts ?? 0} failed=${report.failed ?? 0}`)
    },
    async execute(args) {
      const current = settings.get()
      const paths = resolvedPaths(current)
      const kinds = splitKinds(args.kinds)
      const ids = splitList(args.ids)
      const report = await installStaged({
        dshHome: paths.dshHome,
        staging: stagingRoot(paths.dshHome),
        claudeHome: paths.claudeHome,
        ...(kinds !== undefined ? { kinds } : {}),
        ...(ids !== undefined ? { ids } : {}),
        force: args.force === true || current.install.overwrite,
        dryRun: args.confirm !== true || args.dryRun === true,
      })
      return report as unknown as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dsh2claude_status',
    description: [
      'Show the staged DSH2Claude manifest: sessions and assets, their install state, and the resolved DSH/Claude paths.',
    ].join('\n'),
    parameters: {},
    output: jsonToolOutput(),
    async execute() {
      const current = settings.get()
      const paths = resolvedPaths(current)
      const manifest = await loadManifest(paths.dshHome)
      return {
        settings: current,
        dshHome: paths.dshHome,
        claudeHome: paths.claudeHome,
        sessionsRoot: paths.root,
        stagingRoot: stagingRoot(paths.dshHome),
        summary: summarizeStaging(manifest),
        items: manifest.items,
      } as unknown as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dsh2claude_sessions',
    description: [
      'List DSH sessions found under $DSH_HOME/sessions without reading their full event logs.',
      'Each row shows the DSH id, title, cwd, log version and whether it is already staged or installed.',
    ].join('\n'),
    parameters: {
      path: { type: 'string', description: 'Sessions directory to scan. Defaults to the configured sessions root.' },
      includeSubagents: { type: 'boolean', description: 'Include delegated child sessions.' },
    },
    output: jsonToolOutput(),
    async execute(args) {
      const current = settings.get()
      const paths = resolvedPaths(current)
      return await listDshSessionInventory({
        dshHome: paths.dshHome,
        path: typeof args.path === 'string' && args.path.trim().length > 0 ? args.path.trim() : paths.root,
        includeSubagents: typeof args.includeSubagents === 'boolean' ? args.includeSubagents : current.sessions.includeSubagents,
      }) as unknown as JsonValue
    },
  }))

  // Optional multi-tool registry entry. Profiles without the root bundle simply
  // never invoke this callback.
  ctx.inject(['sessionSources'], (ready) => {
    const registry = (ready as unknown as {
      sessionSources: { register(adapter: { id: string; displayName: string }): () => unknown }
    }).sessionSources
    registry.register({ id: 'deepseek-harness', displayName: 'DeepSeek Harness' })
  })

  // Headless integration-test seam: stage a corpus and write a JSON report.
  const testPath = process.env.DSH2CLAUDE_TEST_PATH
  const testReport = process.env.DSH2CLAUDE_TEST_REPORT
  if (testPath !== undefined && testPath.length > 0) {
    void (async () => {
      try {
        const current = settings.get()
        const paths = resolvedPaths(current)
        const report = await migrateDsh({
          dshHome: paths.dshHome,
          path: testPath,
          includeSubagents: process.env.DSH2CLAUDE_TEST_SUBAGENTS === '1',
          skills: process.env.DSH2CLAUDE_TEST_SKILLS !== '0',
          instructions: process.env.DSH2CLAUDE_TEST_INSTRUCTIONS !== '0',
          mcp: process.env.DSH2CLAUDE_TEST_MCP !== '0',
          preview: process.env.DSH2CLAUDE_TEST_PREVIEW === '1',
        })
        const install = process.env.DSH2CLAUDE_TEST_INSTALL === '1'
          ? await installStaged({
              dshHome: paths.dshHome,
              staging: stagingRoot(paths.dshHome),
              claudeHome: paths.claudeHome,
              dryRun: process.env.DSH2CLAUDE_TEST_INSTALL_DRY === '1',
            })
          : undefined
        if (testReport !== undefined) {
          const { writeFile } = await import('node:fs/promises')
          await writeFile(testReport, `${JSON.stringify({ report, install }, null, 2)}\n`)
        }
        const code = report.sessions.failed > 0 ? 1 : 0
        process.exitCode = code
        setTimeout(() => process.exit(code), 200)
      } catch (error) {
        console.error('[dsh2claude] integration run failed:', error)
        process.exitCode = 1
        setTimeout(() => process.exit(1), 200)
      }
    })()
  }
}

export type { Dsh2ClaudeSettings }
