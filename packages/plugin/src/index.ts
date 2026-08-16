/**
 * Claude2DSH migration plugin for DeepSeek Harness.
 *
 * The plugin consumes only host services (`sessionPersistence`, `tools`) and
 * writes session data through the host persistence service. Skill files and
 * the import registry are written below `$DSH_HOME`; `~/.claude` is opened
 * read-only and is never a write target.
 * @module @claude2dsh/plugin
 */
import { writeFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolResult } from '@deepseek-ai/dsh-tools'
import { claudeCodeAdapter } from '@claude2dsh/adapter-claude-code'
import { importClaudeSessions } from './session-import.ts'
import { exportClaudeSession } from './export-claude.ts'
import { syncClaudeSession } from './sync-claude.ts'
import { importClaudeSkills } from './skills-import.ts'
import { resolveDshHome } from './registry.ts'
import { assertDshCompatibility } from './compat.ts'
import { activateAutoSync, getAutoSyncState, resumeAutoSync, type AutoSyncConfig } from './auto-sync.ts'
import { registerImageReprojection } from './image-reproject.ts'
import { importGlobalClaudeContext } from './context-import.ts'
import { importClaudeMemory } from './memory-import.ts'
import { loadSidecarMap } from './sidecar.ts'
import { loadSessionSourceMap, saveSessionSource } from './session-sources.ts'
import { mergeClaudeSession } from './merge-session.ts'
import { createSettingsRuntime } from './settings-service.ts'
import { registerClaude2dshSettingsRoutes } from './settings-routes.ts'
import { inventoryClaudePlugins } from './plugin-inventory.ts'

export const name = 'claude2dsh-import'
export const inject = ['sessionPersistence', 'sessions', 'tools', 'attachments', 'llm']

/** Plugin configuration. `autoSync` defaults to disabled. */
export interface PluginConfig {
  readonly autoSync?: AutoSyncConfig
}

const SESSION_IMPORT_DESCRIPTION = [
  'Import Claude Code conversation transcripts into DeepSeek Harness as native resumable sessions.',
  'Reads the given ~/.claude/projects path (or a single <sessionId>.jsonl file) read-only and writes only DSH-native session logs.',
  'Re-importing an unchanged source is idempotent; a changed source requires force:true in this version.',
  'Set preview:true for a zero-side-effect conversion report.',
].join('\n')

const SKILLS_IMPORT_DESCRIPTION = [
  'Copy Claude Code skills from ~/.claude/skills into the DSH-native skills root ($DSH_HOME/skills).',
  'Only kebab-case skills with a non-empty description are copied; existing identical skills are skipped and conflicts are reported, never overwritten.',
  'Source skills are symlinks in real Claude layouts, so files are dereferenced and copied.',
].join('\n')

function genericResult(title: string, summary: string): { card: 'generic'; title: string; content: { type: 'text'; text: string }[] } {
  return { card: 'generic', title, content: [{ type: 'text', text: summary }] }
}

function parseResultText(value: ToolResult): unknown {
  const raw = value.content.find((block) => block.type === 'text')?.text
  if (raw === undefined) return undefined
  try { return JSON.parse(raw) } catch { return undefined }
}

function importResultView(_args: unknown, value: ToolResult): { card: 'generic'; title: string; content: { type: 'text'; text: string }[] } {
  const report = (parseResultText(value) ?? {}) as { imported?: number; alreadyImported?: number; appended?: number; skipped?: number; failed?: number }
  return genericResult('Claude Code import', `imported=${report.imported ?? 0} already=${report.alreadyImported ?? 0} appended=${report.appended ?? 0} skipped=${report.skipped ?? 0} failed=${report.failed ?? 0}`)
}

function jsonToolOutput(): { schema: { type: 'json' }; render: (args: unknown, value: unknown) => { type: 'text'; text: string }[] } {
  return {
    schema: { type: 'json' as const },
    render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  }
}

/**
 * Activate the plugin.
 *
 * @param ctx - Cordis context of the profile that mounted this plugin.
 * @param config - optional plugin configuration.
 */
export function apply(ctx: Context, config: PluginConfig = {}): void {
  assertDshCompatibility()
  const settings = createSettingsRuntime(ctx, config)
  registerClaude2dshSettingsRoutes(ctx, settings)
  let autoSyncDispose: (() => void) | undefined
  const syncAutoSync = (next: ReturnType<typeof settings.get>): void => {
    autoSyncDispose?.()
    autoSyncDispose = undefined
    if (next.autoSync.enabled) autoSyncDispose = activateAutoSync(ctx, next.autoSync)
  }
  syncAutoSync(settings.get())
  ctx.inject(['settings'], () => {
    syncAutoSync(settings.get())
    settings.scope?.watch((next) => syncAutoSync(next))
  })
  ctx.tools.register(defineTool({
    name: 'claude2dsh_import',
    description: SESSION_IMPORT_DESCRIPTION,
    parameters: {
      path: { type: 'string', required: true, description: 'Path to ~/.claude/projects, a project directory, or one <sessionId>.jsonl transcript.' },
      recursive: { type: 'boolean', description: 'Recurse into project subdirectories when the root has no direct transcripts.' },
      includeSubagents: { type: 'boolean', description: 'Also import subagent and workflow agent transcripts as child DSH sessions.' },
      imageMode: { type: 'string', enum: ['auto', 'placeholder', 'native'], description: 'Image policy: auto probes model inputModalities (default), placeholder always degrades safely, native forces attachment blocks.' },
      imageProvider: { type: 'string', description: 'Provider route probed by imageMode auto/native.' },
      imageModel: { type: 'string', description: 'Model id probed by imageMode auto/native.' },
      sidecarMaxBytes: { type: 'number', description: 'Per-file byte cap for tool-result .txt sidecars; larger files are mapped but not copied.' },
      force: { type: 'boolean', description: 'Create a fresh DSH session copy under a new id when the source changed or already exists.' },
      preview: { type: 'boolean', description: 'Convert and report without persisting anything.' },
      sessionId: { type: 'string', description: 'Override the target DSH session id for a single-file import.' },
    },
    output: jsonToolOutput(),
    presentCall: (args) => ({ card: 'generic', title: 'Import Claude Code sessions', kind: 'other', rawInput: (args as { path?: unknown }).path }),
    presentResult: importResultView,
    async execute(args) {
      const defaults = settings.get().importDefaults
      const report = await importClaudeSessions(ctx, {
        ...args,
        ...(args.includeSubagents === undefined ? { includeSubagents: defaults.includeSubagents } : {}),
        ...(args.imageMode === undefined ? { imageMode: defaults.imageMode } : {}),
        ...(args.imageProvider === undefined ? { imageProvider: defaults.imageProvider } : {}),
        ...(args.imageModel === undefined ? { imageModel: defaults.imageModel } : {}),
        ...(args.sidecarMaxBytes === undefined ? { sidecarMaxBytes: defaults.sidecarMaxBytes } : {}),
      })
      return report as unknown as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'claude2dsh_export',
    description: [
      'Export one DSH session (native or imported) as a Claude Code JSONL transcript that Claude Code can load with --resume.',
      'The default destination is $DSH_HOME/claude2dsh/exports; writing into the real ~/.claude directory is refused unless allowOriginalClaudeDir:true is explicit.',
      'Existing files are never overwritten unless force:true.',
    ].join('\n'),
    parameters: {
      sessionId: { type: 'string', required: true, description: 'DSH session id to export.' },
      outputDir: { type: 'string', description: 'Destination directory. Defaults to $DSH_HOME/claude2dsh/exports.' },
      allowOriginalClaudeDir: { type: 'boolean', description: 'Explicitly allow writing below ~/.claude (default false).' },
      force: { type: 'boolean', description: 'Replace an existing export file.' },
    },
    output: jsonToolOutput(),
    async execute(args) {
      const writeback = settings.get().writeback
      const result = await exportClaudeSession(ctx, {
        ...args,
        ...(args.outputDir === undefined && writeback.exportDir.length > 0 ? { outputDir: writeback.exportDir } : {}),
        ...(args.allowOriginalClaudeDir === undefined ? { allowOriginalClaudeDir: writeback.allowOriginalClaudeDir } : {}),
      }, resolveDshHome())
      return result as unknown as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'claude2dsh_sync',
    description: [
      'Append DSH-side turns newer than the last export watermark to the exported Claude Code JSONL copy.',
      'The default target is the safe export copy under $DSH_HOME/claude2dsh/exports; writing the original ~/.claude transcript requires target:"source" plus allowOriginalClaudeDir:true.',
      'Guards refuse an externally modified or shrunken file unless force:true re-anchors the watermark.',
    ].join('\n'),
    parameters: {
      sessionId: { type: 'string', required: true, description: 'DSH session id whose new turns should be written back.' },
      target: { type: 'string', enum: ['copy', 'source'], description: 'Write the last export copy (default) or the original Claude source transcript.' },
      allowOriginalClaudeDir: { type: 'boolean', description: 'Explicitly allow writing the original ~/.claude transcript.' },
      force: { type: 'boolean', description: 'Re-anchor a moved or externally modified target.' },
      dryRun: { type: 'boolean', description: 'Compute and validate the append without writing.' },
    },
    output: jsonToolOutput(),
    presentCall: (args) => ({ card: 'generic', title: 'Sync DSH session to Claude Code', kind: 'other', rawInput: (args as { sessionId?: unknown }).sessionId }),
    presentResult: (_args, value: ToolResult) => {
      const v = (parseResultText(value) ?? {}) as { status?: string; appendedRecords?: number; appendedEvents?: number; reason?: string }
      return genericResult('Sync to Claude Code', `status=${v.status ?? 'unknown'} records=${v.appendedRecords ?? 0} events=${v.appendedEvents ?? 0}${v.reason ? ` reason=${v.reason}` : ''}`)
    },
    async execute(args) {
      const writeback = settings.get().writeback
      const result = await syncClaudeSession(ctx, {
        ...args,
        ...(args.target === undefined ? { target: writeback.target } : {}),
        ...(args.allowOriginalClaudeDir === undefined ? { allowOriginalClaudeDir: writeback.allowOriginalClaudeDir } : {}),
      }, resolveDshHome())
      return result as unknown as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'claude2dsh_autosync',
    description: [
      'Inspect or resume the Claude2DSH auto-mirror without editing state files by hand.',
      'status: show whether mirroring is paused, the pause reason, recent conflicts and the pending work queue.',
      'resume: clear a conflict pause after the two sides were reconciled with explicit import/sync/force tools.',
    ].join('\n'),
    parameters: {
      action: { type: 'string', required: true, enum: ['status', 'resume'], description: 'status to inspect mirror state, resume to clear a conflict pause.' },
    },
    output: jsonToolOutput(),
    presentCall: (args) => ({ card: 'generic', title: 'Claude2DSH auto-mirror', kind: 'other', rawInput: (args as { action?: unknown }).action }),
    presentResult: (_args, value: ToolResult) => {
      const state = (parseResultText(value) ?? {}) as { paused?: boolean; reason?: string; conflicts?: unknown[]; pending?: unknown[] }
      return genericResult('Claude2DSH auto-mirror', `paused=${state.paused ?? false} reason=${state.reason ?? 'none'} conflicts=${state.conflicts?.length ?? 0} pending=${state.pending?.length ?? 0}`)
    },
    async execute(args) {
      const action = (args as { action: string }).action
      const state = action === 'resume' ? await resumeAutoSync(resolveDshHome()) : await getAutoSyncState(resolveDshHome())
      return state as unknown as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'claude2dsh_session_sources',
    description: [
      'Inspect the source marker of DSH sessions migrated by Claude2DSH.',
      'action list: return every recorded source marker (claude-main, claude-subagent, claude-merged; codex/native reserved).',
      'action resolve: return the marker for one session id.',
    ].join('\n'),
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'resolve'], description: 'list all markers or resolve one session.' },
      sessionId: { type: 'string', description: 'DSH session id (resolve only).' },
    },
    output: jsonToolOutput(),
    async execute(args) {
      const map = await loadSessionSourceMap(resolveDshHome())
      if (args.action === 'resolve') {
        const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
        return (map.sessions[sessionId] ?? { status: 'missing', sessionId }) as unknown as JsonValue
      }
      return { sessions: map.sessions } as unknown as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'claude2dsh_merge',
    description: [
      'Explicit three-way merge for a session that grew on both sides after the sync watermark.',
      'Complete turns are ordered by timestamp; a turn edited on both sides keeps both versions and a log-only conflict marker.',
      'The original DSH session and Claude JSONL are never mutated: the result is a new DSH session id (<sessionId>-merged).',
      'dryRun:true computes the merged copy without writing.',
    ].join('\n'),
    parameters: {
      sessionId: { type: 'string', required: true, description: 'DSH session id owned by a claude2dsh import record.' },
      path: { type: 'string', description: 'Optional explicit Claude source path; defaults to the import record.' },
      dryRun: { type: 'boolean', description: 'Compute and report without creating the merged session.' },
    },
    output: jsonToolOutput(),
    async execute(args) {
      const result = await mergeClaudeSession(ctx, args, resolveDshHome())
      return result as unknown as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'claude2dsh_sidecars',
    description: [
      'Inspect the durable tool-result sidecar map created by claude2dsh_import.',
      'action list: return every session whose referenced .txt files were copied, skipped or mapped.',
      'action resolve: return the DSH-side path for one session filename (the original Claude path reference stays intact).',
    ].join('\n'),
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'resolve'], description: 'list session maps or resolve one filename.' },
      sessionId: { type: 'string', description: 'Target DSH session id; defaults to all sessions for list, required for resolve.' },
      filename: { type: 'string', description: 'Sidecar basename such as b37elc3ww.txt (resolve only).' },
    },
    output: jsonToolOutput(),
    async execute(args) {
      const map = await loadSidecarMap(resolveDshHome())
      if (args.action === 'resolve') {
        const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
        const filename = typeof args.filename === 'string' ? args.filename : ''
        const item = map.sessions[sessionId]?.find((candidate) => candidate.filename === filename)
        if (item === undefined) return { status: 'missing', sessionId, filename } as unknown as JsonValue
        return item as unknown as JsonValue
      }
      return { sessions: map.sessions } as unknown as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'claude2dsh_import_context',
    description: [
      'Import the user-global ~/.claude/CLAUDE.md into $DSH_HOME/AGENTS.md read-only.',
      'Never overwrites an existing target: identical content is skipped and different content is reported as a conflict.',
      'Project-level CLAUDE.md is not migrated because DeepSeek Harness reads AGENTS.md/CLAUDE.md natively.',
      'preview:true computes the result without writing.',
    ].join('\n'),
    parameters: {
      path: { type: 'string', description: 'Source CLAUDE.md. Defaults to $CLAUDE_CONFIG_DIR/CLAUDE.md or ~/.claude/CLAUDE.md.' },
      preview: { type: 'boolean', description: 'Do not write; report what would happen.' },
    },
    output: jsonToolOutput(),
    async execute(args) {
      const result = await importGlobalClaudeContext(args, resolveDshHome())
      return result as unknown as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'claude2dsh_import_memory',
    description: [
      'Package one Claude Code project memory (MEMORY.md and memory/*.md) as a DSH-native skill bundle under $DSH_HOME/skills.',
      'Never overwrites an existing skill: identical content is skipped and different content is reported as a conflict.',
      'preview:true computes the result without writing.',
    ].join('\n'),
    parameters: {
      path: { type: 'string', required: true, description: 'Claude Code project root containing MEMORY.md and/or memory/*.md.' },
      preview: { type: 'boolean', description: 'Do not write; report what would happen.' },
    },
    output: jsonToolOutput(),
    async execute(args) {
      const result = await importClaudeMemory(args, resolveDshHome())
      return result as unknown as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'claude2dsh_plugin_inventory',
    description: [
      'Inventory installed Claude Code plugins (read-only) and optionally migrate their declarative skill assets into DSH.',
      'Dry-run is the default: apply:true copies only SKILL.md assets; hooks, app-server scripts and runtime code are never executed or copied.',
    ].join('\n'),
    parameters: {
      path: { type: 'string', description: 'Claude plugins root; defaults to $CLAUDE_CONFIG_DIR/plugins or ~/.claude/plugins.' },
      apply: { type: 'boolean', description: 'Actually copy plugin SKILL.md assets into $DSH_HOME/skills (default false).' },
    },
    output: jsonToolOutput(),
    async execute(args) {
      const result = await inventoryClaudePlugins(args, resolveDshHome())
      return result as unknown as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'claude2dsh_import_skills',
    description: SKILLS_IMPORT_DESCRIPTION,
    parameters: {
      path: { type: 'string', required: true, description: 'Claude skills root, normally ~/.claude/skills.' },
    },
    output: jsonToolOutput(),
    async execute(args) {
      const results = await importClaudeSkills(args.path, resolveDshHome())
      return { source: args.path, destination: resolveDshHome() + '/skills', results } as unknown as JsonValue
    },
  }))

  registerImageReprojection(ctx)

  if (config.autoSync?.enabled === true) {
    activateAutoSync(ctx, config.autoSync)
  }

  // Optional multi-tool extension point. The root `claude2dsh` bundle owns the
  // in-memory registry; profiles that do not mount it simply never invoke this
  // callback, and the import tools remain fully functional.
  ctx.inject(['sessionSources'], (ready) => {
    const registry = (ready as unknown as {
      sessionSources: { register(adapter: { id: string; displayName: string }): () => unknown }
    }).sessionSources
    registry.register({ id: claudeCodeAdapter.id, displayName: claudeCodeAdapter.label })
  })

  // Integration-test seam: boot a profile with this plugin and import without
  // a model round-trip. Production profiles never set the environment variable.
  const testPath = process.env.CLAUDE2DSH_TEST_IMPORT
  const testReport = process.env.CLAUDE2DSH_TEST_REPORT
  if (testPath !== undefined && testPath.length > 0) {
    ctx.inject(['sessionPersistence', 'sessions', 'skills', 'agents'], async (ready) => {
      const report = await importClaudeSessions(ready, {
        path: testPath,
        recursive: process.env.CLAUDE2DSH_TEST_RECURSIVE === '1',
        includeSubagents: process.env.CLAUDE2DSH_TEST_INCLUDE_SUBAGENTS === '1',
        preview: process.env.CLAUDE2DSH_TEST_PREVIEW === '1',
        force: process.env.CLAUDE2DSH_TEST_FORCE === '1',
      }, resolveDshHome())
      const skillsReport = process.env.CLAUDE2DSH_TEST_SKILLS === '1'
        ? await importClaudeSkills(process.env.CLAUDE2DSH_TEST_SKILLS_ROOT ?? testPath, resolveDshHome())
        : undefined
      const headers = await ready.sessionPersistence.list()
      const inspected: Record<string, { header: unknown; eventCount: number; error?: string }> = {}
      for (const item of report.items) {
        if (item.sessionId !== undefined && item.status !== 'preview' && item.status !== 'failed') {
          try {
            const view = await ready.sessionPersistence.inspect(item.sessionId as SessionId)
            inspected[item.sessionId] = { header: view.meta, eventCount: view.events.length }
          } catch (error) {
            inspected[item.sessionId] = { header: null, eventCount: -1, error: error instanceof Error ? error.message : String(error) }
          }
        }
      }
      let preparedSessions: Record<string, number> | undefined
      if (process.env.CLAUDE2DSH_TEST_PREPARE === '1') {
        preparedSessions = {}
        for (const item of report.items) {
          if (item.sessionId === undefined || item.status === 'preview' || item.status === 'failed') continue
          try {
            const preparation = await ready.sessionPersistence.prepare(item.sessionId as SessionId)
            preparedSessions[item.sessionId] = preparation.session.deriveMessages().length
            preparation[Symbol.dispose]()
          } catch {
            preparedSessions[item.sessionId] = -1
          }
        }
      }
      let skillsSnapshot: string[] | undefined
      let skillsSnapshotError: string | undefined
      if (skillsReport !== undefined) {
        try {
          skillsSnapshot = (await (ready as unknown as { skills: { snapshot(options: { cwd?: string }): Promise<{ skills: { name: string }[]; complete: boolean }> } }).skills.snapshot({ cwd: process.cwd() })).skills.map((skill) => skill.name).sort()
        } catch (error) {
          skillsSnapshotError = error instanceof Error ? error.message : String(error)
        }
      }
      let contextReport: Awaited<ReturnType<typeof importGlobalClaudeContext>> | undefined
      if (process.env.CLAUDE2DSH_TEST_CONTEXT === '1') {
        contextReport = await importGlobalClaudeContext({
          ...(process.env.CLAUDE2DSH_TEST_CONTEXT_PATH !== undefined ? { path: process.env.CLAUDE2DSH_TEST_CONTEXT_PATH } : {}),
          preview: process.env.CLAUDE2DSH_TEST_CONTEXT_PREVIEW === '1',
        }, resolveDshHome())
      }
      let memoryReport: Awaited<ReturnType<typeof importClaudeMemory>> | undefined
      if (process.env.CLAUDE2DSH_TEST_MEMORY !== undefined && process.env.CLAUDE2DSH_TEST_MEMORY.length > 0) {
        memoryReport = await importClaudeMemory({ path: process.env.CLAUDE2DSH_TEST_MEMORY, preview: process.env.CLAUDE2DSH_TEST_MEMORY_PREVIEW === '1' }, resolveDshHome())
      }
      let exportReport: Awaited<ReturnType<typeof exportClaudeSession>> | undefined
      let syncReport: Awaited<ReturnType<typeof syncClaudeSession>> | undefined
      const exportTarget = process.env.CLAUDE2DSH_TEST_EXPORT
      if (exportTarget !== undefined && exportTarget.length > 0) {
        exportReport = await exportClaudeSession(ready, {
          sessionId: exportTarget,
          ...(process.env.CLAUDE2DSH_TEST_EXPORT_DIR !== undefined ? { outputDir: process.env.CLAUDE2DSH_TEST_EXPORT_DIR } : {}),
          allowOriginalClaudeDir: process.env.CLAUDE2DSH_TEST_ALLOW_ORIGINAL_CLAUDE === '1',
          force: process.env.CLAUDE2DSH_TEST_FORCE === '1',
        }, resolveDshHome())
      }
      const appendEventsPath = process.env.CLAUDE2DSH_TEST_APPEND_EVENTS
      const appendSyntheticTurn = async (): Promise<string> => {
        const { readFile } = await import('node:fs/promises')
        if (appendEventsPath === undefined) throw new Error('append events path is missing')
        const raw = JSON.parse(await readFile(appendEventsPath, 'utf8')) as Array<{ type: string; time: number; data: Record<string, unknown>; surfaceOp?: 'append'; sourceEventSeqs?: number[] }>
        const sessionId = process.env.CLAUDE2DSH_TEST_APPEND_SESSION ?? exportReport?.sessionId ?? report.items.find((item) => item.status === 'imported')?.sessionId
        if (sessionId === undefined) throw new Error('CLAUDE2DSH_TEST_APPEND_EVENTS requires an imported session')
        const stored = await ready.sessionPersistence.readFrom(sessionId as SessionId, 0)
        const events = raw.map((event, index) => ({ ...event, seq: stored.events.length + index }))
        await ready.sessionPersistence.append(sessionId as SessionId, events as never)
        return sessionId
      }
      if (appendEventsPath !== undefined && appendEventsPath.length > 0 && process.env.CLAUDE2DSH_TEST_APPEND_AFTER_EXPORT !== '1') {
        await appendSyntheticTurn()
      }
      let resumeReport: { sessionId: string; prompt: string; events: number; messages: number; status: string; error?: string } | undefined
      if (process.env.CLAUDE2DSH_TEST_RESUME === '1') {
        const resumeId = process.env.CLAUDE2DSH_TEST_RESUME_SESSION ?? exportReport?.sessionId ?? report.items.find((item) => item.status === 'imported')?.sessionId
        if (resumeId === undefined) throw new Error('CLAUDE2DSH_TEST_RESUME requires an imported session')
        const prompt = process.env.CLAUDE2DSH_TEST_PROMPT ?? 'Continue this conversation with exactly: dsh-pong'
        try {
          const handle = await ready.agents.resume({
            resumeSessionId: resumeId as SessionId,
            agentOptions: {
              provider: process.env.CLAUDE2DSH_TEST_PROVIDER ?? 'deepseek-official',
              model: process.env.CLAUDE2DSH_TEST_MODEL ?? 'deepseek-v4-flash',
            },
          })
          const message = {
            id: `claude2dsh:live:${Date.now()}`,
            role: 'user' as const,
            content: [{ type: 'text' as const, text: prompt }],
            source: { kind: 'user' as const },
          }
          handle.agent.followup(message as UserMessage)
          await handle.agent.whenIdle()
          resumeReport = {
            sessionId: resumeId,
            prompt,
            events: handle.agent.session.events.length,
            messages: handle.agent.session.deriveMessages().length,
            status: handle.agent.status,
          }
          await handle.dispose()
        } catch (error) {
          resumeReport = { sessionId: resumeId, prompt, events: -1, messages: -1, status: 'error', error: error instanceof Error ? error.message : String(error) }
        }
      }
      if (appendEventsPath !== undefined && appendEventsPath.length > 0 && process.env.CLAUDE2DSH_TEST_APPEND_AFTER_EXPORT === '1') {
        await appendSyntheticTurn()
      }
      if (exportReport?.status === 'exported' && process.env.CLAUDE2DSH_TEST_SYNC === '1') {
        syncReport = await syncClaudeSession(ready, {
          sessionId: exportReport.sessionId,
          target: process.env.CLAUDE2DSH_TEST_SYNC_TARGET === 'source' ? 'source' : 'copy',
          allowOriginalClaudeDir: process.env.CLAUDE2DSH_TEST_ALLOW_ORIGINAL_CLAUDE === '1',
          force: process.env.CLAUDE2DSH_TEST_FORCE === '1',
          dryRun: process.env.CLAUDE2DSH_TEST_SYNC_DRY_RUN === '1',
        }, resolveDshHome())
      }
      let presenters: Record<string, unknown> | undefined
      if (process.env.CLAUDE2DSH_TEST_PRESENTERS === '1') {
        const importDef = ready.tools.get('claude2dsh_import')
        const autoSyncDef = ready.tools.get('claude2dsh_autosync')
        const probeArgs = { path: process.env.CLAUDE2DSH_TEST_IMPORT ?? '/tmp/sample.jsonl' }
        const probeResult: ToolResult = { content: [{ type: 'text', text: JSON.stringify({ imported: report.imported, alreadyImported: report.alreadyImported, appended: report.appended, skipped: report.skipped, failed: report.failed }) }], isError: false }
        const autoSyncProbeResult: ToolResult = { content: [{ type: 'text', text: JSON.stringify({ paused: true, reason: 'probe', conflicts: [], pending: [] }) }], isError: false }
        presenters = {
          importCall: importDef?.presentCall?.(probeArgs),
          importResult: importDef?.presentResult?.(probeArgs, probeResult),
          autoSyncCall: autoSyncDef?.presentCall?.({ action: 'status' }),
          autoSyncResult: autoSyncDef?.presentResult?.({ action: 'status' }, autoSyncProbeResult),
        }
      }
      if (testReport !== undefined) {
        await writeFile(testReport, JSON.stringify({ report, skillsReport, contextReport, memoryReport, exportReport, syncReport, resumeReport, preparedSessions, presenters, persistedSessions: headers.map((header) => ({ id: String(header.id), cwd: header.cwd, createdAt: header.createdAt })), inspected, skillsSnapshot, skillsSnapshotError }, null, 2) + '\n')
      }
      const holdMs = Number(process.env.CLAUDE2DSH_TEST_HOLD_MS ?? '0')
      const failed = report.failed + (skillsReport?.filter((item) => item.status === 'failed').length ?? 0)
      process.exitCode = failed > 0 || exportReport?.status === 'refused' ? 1 : 0
      setTimeout(() => process.exit(process.exitCode), holdMs > 0 ? holdMs : 50)
    })
  }
}
