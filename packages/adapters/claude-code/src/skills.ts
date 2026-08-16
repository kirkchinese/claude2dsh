/** Claude Code skills -> DSH-compatible SKILL.md assets. */
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, join, relative } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { ClaudeSkill, ClaudeSkillFrontmatter } from './types.ts'

const IGNORED_NAMES = new Set(['README.md', 'MEMORY.md', '.DS_Store'])
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Parse YAML frontmatter delimited by `---` lines. */
export function parseSkillFrontmatter(body: string): ClaudeSkillFrontmatter {
  const lines = body.split('\n')
  if (lines[0]?.trim() !== '---') return {}
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end <= 0) return {}
  try {
    const parsed: unknown = parseYaml(lines.slice(1, end).join('\n'))
    if (typeof parsed === 'object' && parsed !== null) return parsed as ClaudeSkillFrontmatter
  } catch {
    return {}
  }
  return {}
}

/** Normalize a description and reject empty values. */
export function normalizeDescription(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim().replace(/\s+/g, ' ')
  return text.length > 0 ? text : undefined
}

/** Validate a Claude skill entry and collect files that should be copied. */
export async function collectClaudeSkill(sourceDir: string): Promise<ClaudeSkill | undefined> {
  let realDir: string
  try {
    realDir = await realpath(sourceDir)
    const info = await stat(realDir)
    if (!info.isDirectory()) return undefined
  } catch {
    return undefined
  }

  const skillPath = join(realDir, 'SKILL.md')
  let body: string
  try {
    body = await readFile(skillPath, 'utf8')
  } catch {
    return undefined
  }

  const meta = parseSkillFrontmatter(body)
  const name = typeof meta.name === 'string' ? meta.name.trim() : ''
  const description = normalizeDescription(meta.description)
  if (!KEBAB_CASE.test(name) || description === undefined) return undefined

  const files = await collectSkillFiles(realDir)
  return { name, description, sourceDir: realDir, files }
}

async function collectSkillFiles(realDir: string): Promise<{ relPath: string; sourcePath: string }[]> {
  const out: { relPath: string; sourcePath: string }[] = []
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const absolute = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        const targetInfo = await stat(absolute).catch(() => undefined)
        if (targetInfo?.isDirectory()) {
          await walk(await realpath(absolute))
          continue
        }
        if (targetInfo?.isFile()) {
          out.push({ relPath: relative(realDir, absolute), sourcePath: await realpath(absolute) })
        }
        continue
      }
      if (entry.isDirectory()) {
        await walk(absolute)
      } else if (entry.isFile()) {
        out.push({ relPath: relative(realDir, absolute), sourcePath: absolute })
      }
    }
  }
  await walk(realDir)
  return out
}

/** Discover migratable Claude skills (directory bundles and flat Markdown files). */
export async function discoverClaudeSkills(root: string): Promise<ClaudeSkill[]> {
  const entries = await readdir(root, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))
  const out: ClaudeSkill[] = []
  for (const entry of entries) {
    if (IGNORED_NAMES.has(entry.name) || entry.name.startsWith('.')) continue
    const absolute = join(root, entry.name)
    const skill = await collectClaudeSkill(absolute)
    if (skill !== undefined) out.push(skill)
  }
  return out
}

/** The DSH skill filesystem provider recognizes `<name>/SKILL.md` bundles. */
export function dshSkillBundleName(skill: ClaudeSkill): string {
  return basename(skill.name)
}

/** A flat Markdown skill is copied as `<name>.md`; bundles keep SKILL.md. */
export function dshSkillRelativeFiles(skill: ClaudeSkill): { relPath: string; sourcePath: string }[] {
  return skill.files.map((file) => ({ relPath: file.relPath, sourcePath: file.sourcePath }))
}

void extname
