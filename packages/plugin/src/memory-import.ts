/** Project Claude Code memory -> one DSH-native skill bundle per project. */
import { constants } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { safeSkillName } from './name-utils.ts'
import { skillsRoot } from './registry.ts'

export interface MemoryImportArgs {
  /** Project root containing MEMORY.md and/or memory/*.md. */
  readonly path: string
  /** Compute and report without writing. */
  readonly preview?: boolean
}

export interface MemoryFile {
  readonly relPath: string
  readonly sourcePath: string
  readonly bytes: number
}

export interface MemoryImportResult {
  readonly skillName: string
  readonly status: 'imported' | 'preview' | 'skipped-missing' | 'skipped-identical' | 'skipped-conflict' | 'failed'
  readonly reason?: string
  readonly files: number
  readonly bytes?: number
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function projectSkillName(projectRoot: string): string {
  const base = basename(resolve(projectRoot)).replace(/^\.+/, '')
  return safeSkillName('claude-memory', base || 'project')
}

async function discoverMemoryFiles(projectRoot: string): Promise<MemoryFile[]> {
  const root = resolve(projectRoot)
  const out: MemoryFile[] = []
  const rootMemory = join(root, 'MEMORY.md')
  const memoryDir = join(root, 'memory')

  const add = async (path: string, relPath: string): Promise<void> => {
    try {
      const info = await stat(path)
      if (info.isFile()) out.push({ relPath, sourcePath: path, bytes: info.size })
    } catch {
      // Missing files are reported by the caller, not treated as partial success.
    }
  }

  await add(rootMemory, 'MEMORY.md')
  try {
    const entries = await readdir(memoryDir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      await add(join(memoryDir, entry.name), join('memory', entry.name))
    }
  } catch {
    // No memory directory is a normal empty project.
  }
  return out
}

function frontmatter(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n`
}

function indexBody(files: MemoryFile[]): string {
  const lines = [
    'Claude Code project memory migrated by Claude2DSH.',
    'Read the files listed below before working in the project; they are the original memory content, copied verbatim.',
    '',
  ]
  for (const file of files) lines.push(`- ${file.relPath} (${file.bytes} bytes)`)
  return lines.join('\n') + '\n'
}

/**
 * Package a project's Claude memory into `$DSH_HOME/skills/<name>/` so DSH
 * discovers it natively. Existing skills are never overwritten; identical
 * content is skipped and different content is reported as a conflict.
 */
export async function importClaudeMemory(args: MemoryImportArgs, dshHome?: string): Promise<MemoryImportResult> {
  const files = await discoverMemoryFiles(args.path)
  const skillName = projectSkillName(args.path)
  if (!KEBAB.test(skillName)) {
    return { skillName, status: 'failed', reason: 'could not derive a kebab-case skill name from the project path', files: 0 }
  }
  if (files.length === 0) {
    return { skillName, status: 'skipped-missing', reason: `no MEMORY.md or memory/*.md found under ${resolve(args.path)}`, files: 0 }
  }

  const root = skillsRoot(dshHome)
  const targetDir = join(root, skillName)
  const targetSkill = join(targetDir, 'SKILL.md')
  const existingSkill = await readFile(targetSkill, 'utf8').catch(() => undefined)
  if (existingSkill !== undefined) {
    let identical = true
    try {
      for (const file of files) {
        const candidate = await readFile(join(targetDir, file.relPath), 'utf8').catch(() => undefined)
        if (candidate === undefined || candidate !== await readFile(file.sourcePath, 'utf8')) {
          identical = false
          break
        }
      }
    } catch {
      return { skillName, status: 'failed', reason: `could not compare existing target ${targetDir}`, files: 0 }
    }
    if (identical) {
      return { skillName, status: 'skipped-identical', reason: `${targetSkill} already exists with identical content`, files: 0 }
    }
    return { skillName, status: 'skipped-conflict', reason: `${targetSkill} already exists with different content; never overwritten`, files: 0 }
  }

  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)
  if (args.preview === true) {
    return { skillName, status: 'preview', reason: 'dry run: would create a DSH skill bundle without overwriting', files: files.length, bytes: totalBytes }
  }

  await mkdir(targetDir, { recursive: true })
  await writeFile(targetSkill, frontmatter(skillName, `Claude Code project memory for ${basename(resolve(args.path))}; copied verbatim by Claude2DSH`) + indexBody(files), { flag: 'wx' })
  let copied = 1
  for (const file of files) {
    const target = join(targetDir, file.relPath)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(file.sourcePath, target, constants.COPYFILE_EXCL)
    copied += 1
  }
  return { skillName, status: 'imported', files: copied, bytes: totalBytes }
}
