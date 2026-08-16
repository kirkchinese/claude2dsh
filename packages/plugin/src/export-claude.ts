/** DSH -> Claude Code export with a default-off safety boundary. */
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { serializeClaudeJsonl, slugifyClaudeCwd } from '@claude2dsh/adapter-claude-code'
import type { ForeignSessionView } from '@claude2dsh/core'
import { resolveDshHome, saveExportMapping } from './registry.ts'

export interface ExportClaudeArgs {
  readonly sessionId: string
  /** Destination directory. Defaults to `$DSH_HOME/claude2dsh/exports`. */
  readonly outputDir?: string
  /** Required when outputDir points at (or below) the real ~/.claude directory. */
  readonly allowOriginalClaudeDir?: boolean
  /** Required when an export for the same session already exists and should be replaced. */
  readonly force?: boolean
}

export interface ExportClaudeResult {
  readonly status: 'exported' | 'dry-run' | 'refused'
  readonly reason?: string
  readonly sessionId: string
  readonly filePath?: string
  readonly recordCount?: number
  readonly toolCalls?: number
  readonly toolResults?: number
  readonly droppedToolResults?: number
}

function isUnder(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Serialize one DSH session as a Claude Code JSONL transcript.
 *
 * The default output directory is `$DSH_HOME/claude2dsh/exports`. Writing into
 * the real `~/.claude` tree is refused unless the caller passes
 * `allowOriginalClaudeDir: true`; the function never overwrites an existing
 * file unless `force: true` is explicit.
 */
export async function exportClaudeSession(ctx: Context, args: ExportClaudeArgs, dshHome = resolveDshHome()): Promise<ExportClaudeResult> {
  const headers = await ctx.sessionPersistence.list()
  const header = headers.find((item) => String(item.id) === args.sessionId)
  if (header === undefined) throw new Error(`session not found: ${args.sessionId}`)

  const outputDir = resolve(args.outputDir ?? join(dshHome, 'claude2dsh', 'exports'))
  if (!args.allowOriginalClaudeDir && isUnder(join(homedir(), '.claude'), outputDir)) {
    return {
      status: 'refused',
      reason: 'outputDir points into ~/.claude; pass allowOriginalClaudeDir:true only after reviewing the backup policy',
      sessionId: args.sessionId,
    }
  }

  const read = await ctx.sessionPersistence.readFrom(args.sessionId as SessionId, 0)
  const view: ForeignSessionView = {
    id: String(header.id),
    createdAt: header.createdAt,
    ...(header.cwd !== undefined ? { cwd: header.cwd } : {}),
    events: read.events as unknown as ForeignSessionView['events'],
  }
  const sessionUuid = newSessionUuid()
  const out = serializeClaudeJsonl(view, { sessionUuid })
  const slug = slugifyClaudeCwd(header.cwd ?? process.cwd())
  const filePath = join(outputDir, slug, `${sessionUuid}.jsonl`)

  if (args.force !== true) {
    try {
      await mkdir(join(outputDir, slug), { recursive: true })
      await writeFile(filePath, out.jsonl, { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return { status: 'refused', reason: 'export file already exists; pass force:true to replace it', sessionId: args.sessionId }
      }
      throw error
    }
  } else {
    await mkdir(join(outputDir, slug), { recursive: true })
    await writeFile(filePath, out.jsonl)
  }

  const turns = read.events.filter((event) => event.type === 'turn/start').length
  const fileInfo = await stat(filePath)
  await saveExportMapping({
    sessionId: args.sessionId,
    filePath,
    slug,
    sessionUuid,
    anchorUuid: lastRecordUuid(out.jsonl),
    lastWrittenSeq: read.events.length,
    lastWrittenTurn: turns,
    recordCount: out.recordCount,
    fileSize: fileInfo.size,
    fileMtimeMs: fileInfo.mtimeMs,
    exportedAt: Date.now(),
  }, dshHome)

  return {
    status: 'exported',
    sessionId: args.sessionId,
    filePath,
    recordCount: out.recordCount,
    toolCalls: out.toolCalls,
    toolResults: out.toolResults,
    droppedToolResults: out.droppedToolResults,
  }
}

function newSessionUuid(): string {
  return crypto.randomUUID()
}

function lastRecordUuid(jsonl: string): string | null {
  const lines = jsonl.split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    if (line === undefined || line.trim() === '') continue
    try {
      const record = JSON.parse(line) as { uuid?: unknown }
      return typeof record.uuid === 'string' ? record.uuid : null
    } catch {
      return null
    }
  }
  return null
}
