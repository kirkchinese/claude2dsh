/** User-global Claude Code instructions -> DSH global AGENTS.md (read-only source, never overwrite). */
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolveDshHome } from './registry.ts'

export interface ContextImportArgs {
  /** Source file. Defaults to $CLAUDE_CONFIG_DIR/CLAUDE.md or ~/.claude/CLAUDE.md. */
  readonly path?: string
  /** Compute and report without writing. */
  readonly preview?: boolean
}

export interface ContextImportResult {
  readonly status: 'imported' | 'preview' | 'skipped-missing' | 'skipped-identical' | 'skipped-conflict'
  readonly reason?: string
  readonly sourcePath: string
  readonly targetPath: string
  readonly bytes?: number
}

export function resolveGlobalClaudeMd(path: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (path !== undefined && path.trim().length > 0) return resolve(path)
  const configDir = env.CLAUDE_CONFIG_DIR
  if (configDir !== undefined && configDir.trim().length > 0) return resolve(join(configDir, 'CLAUDE.md'))
  return resolve(join(homedir(), '.claude', 'CLAUDE.md'))
}

export function globalAgentsMdPath(dshHome = resolveDshHome()): string {
  return join(dshHome, 'AGENTS.md')
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Import the user-global Claude Code instructions into DSH's user-global
 * instructions file. Project-level CLAUDE.md is deliberately untouched:
 * `dsh-agent-instructions` already reads AGENTS.md/CLAUDE.md natively.
 */
export async function importGlobalClaudeContext(args: ContextImportArgs, dshHome = resolveDshHome(), env: NodeJS.ProcessEnv = process.env): Promise<ContextImportResult> {
  const sourcePath = resolveGlobalClaudeMd(args.path, env)
  const targetPath = globalAgentsMdPath(dshHome)
  let source: string
  try {
    source = await readFile(sourcePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'skipped-missing', reason: `source instructions not found: ${sourcePath}`, sourcePath, targetPath }
    }
    throw error
  }
  const bytes = Buffer.byteLength(source, 'utf8')

  let existing: string | undefined
  try {
    existing = await readFile(targetPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (existing !== undefined) {
    if (sha256(existing) === sha256(source)) {
      return { status: 'skipped-identical', reason: 'target already exists with identical content', sourcePath, targetPath, bytes }
    }
    return { status: 'skipped-conflict', reason: `${targetPath} already exists and is never overwritten; review both files manually`, sourcePath, targetPath, bytes }
  }
  if (args.preview === true) {
    return { status: 'preview', reason: 'dry run: would create target without overwriting any existing file', sourcePath, targetPath, bytes }
  }
  await mkdir(dshHome, { recursive: true })
  await writeFile(targetPath, source, { flag: 'wx' })
  return { status: 'imported', sourcePath, targetPath, bytes }
}
