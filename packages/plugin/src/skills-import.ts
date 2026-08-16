import { createHash } from 'node:crypto'
/** Copies validated Claude skills into the DSH-native skills root. */
import { constants } from 'node:fs'
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { join } from 'node:path'
import { discoverClaudeSkills } from '@claude2dsh/adapter-claude-code'
import { skillsRoot } from './registry.ts'

export interface SkillImportResult {
  readonly name: string
  readonly status: 'imported' | 'skipped-identical' | 'skipped-conflict' | 'failed'
  readonly reason?: string
  readonly files: number
}

async function sha256(bytes: Buffer): Promise<string> {
  return createHash('sha256').update(bytes).digest('hex')
}

async function fileDigest(path: string): Promise<string> {
  return sha256(await readFile(path))
}

export async function importClaudeSkills(sourceRoot: string, dshHome?: string): Promise<SkillImportResult[]> {
  const skills = await discoverClaudeSkills(sourceRoot)
  const root = skillsRoot(dshHome)
  const results: SkillImportResult[] = []
  await mkdir(root, { recursive: true })

  for (const skill of skills) {
    const targetDir = join(root, skill.name)
    try {
      const targetSkill = join(targetDir, 'SKILL.md')
      const sourceSkill = skill.files.find((file) => file.relPath === 'SKILL.md')
      if (sourceSkill === undefined) throw new Error('skill bundle has no SKILL.md')

      const existing = await stat(targetSkill).catch(() => undefined)
      if (existing !== undefined) {
        const same = await fileDigest(targetSkill) === await fileDigest(sourceSkill.sourcePath)
        if (same) {
          results.push({ name: skill.name, status: 'skipped-identical', files: 0 })
          continue
        }
        results.push({ name: skill.name, status: 'skipped-conflict', files: 0, reason: `${targetSkill} already exists with different content` })
        continue
      }

      let copied = 0
      for (const file of skill.files) {
        const target = join(targetDir, file.relPath)
        await mkdir(dirname(target), { recursive: true })
        await copyFile(file.sourcePath, target, constants.COPYFILE_EXCL)
        copied += 1
      }
      results.push({ name: skill.name, status: 'imported', files: copied })
    } catch (error) {
      results.push({ name: skill.name, status: 'failed', files: 0, reason: String(error) })
    }
  }
  return results
}
