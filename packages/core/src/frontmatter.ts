/**
 * Frontmatter parsing shared by skills, commands and agents. The public
 * Agent Skills format and the Claude/Codex dialects disagree on several field
 * names; this module normalizes them without discarding the original object.
 * @module @kirkchinese/harness-forge-core
 */
import { parse as parseYaml } from 'yaml'
import { kebabCase } from './naming.js'
import { readText } from './paths.js'
import type { SkillFrontmatter } from './types.js'

/** One Markdown file split into frontmatter data and body. */
export interface MarkdownAsset {
  readonly path: string
  readonly data: Record<string, unknown>
  readonly body: string
  readonly hasFrontmatter: boolean
}

/** Parse a Markdown file whose leading `---` block is YAML frontmatter. */
export function readMarkdownAsset(path: string, text = readText(path)): MarkdownAsset | undefined {
  if (text === undefined) return undefined
  // Windows editors and PowerShell's UTF8 encoding may leave a BOM. It is not
  // part of the Markdown and must not prevent frontmatter recognition.
  const source = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(source)
  if (match === null) return { path, data: {}, body: source, hasFrontmatter: false }
  let data: Record<string, unknown> = {}
  try {
    const parsed: unknown = parseYaml(match[1] ?? '')
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>
    }
  } catch {
    return { path, data: {}, body: source, hasFrontmatter: false }
  }
  return { path, data, body: source.slice(match[0].length), hasFrontmatter: true }
}

/** Normalize a YAML boolean-like value; undefined when the value is not recognized. */
export function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number' && (value === 0 || value === 1)) return value === 1
  if (typeof value !== 'string') return undefined
  switch (value.trim().toLowerCase()) {
    case 'true':
    case 'yes':
    case 'on':
    case '1':
      return true
    case 'false':
    case 'no':
    case 'off':
    case '0':
      return false
    default:
      return undefined
  }
}

/**
 * Normalize a tool list: a YAML list, or a space- or comma-separated string.
 * Separators inside a rule's parentheses belong to the rule, so
 * `Bash(git add *) Bash(git commit *)` is two entries.
 */
export function toolList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(item => item.length > 0)
    return items.length > 0 ? items : undefined
  }
  if (typeof value !== 'string') return undefined
  const items: string[] = []
  let current = ''
  let depth = 0
  for (const char of value) {
    if (char === '(') depth++
    if (char === ')') depth = Math.max(0, depth - 1)
    if (depth === 0 && /[\s,]/u.test(char)) {
      if (current.trim().length > 0) items.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (current.trim().length > 0) items.push(current.trim())
  return items.length > 0 ? items : undefined
}

/** Read a string field from frontmatter. */
export function frontmatterString(data: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = data[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/** A non-fatal frontmatter problem. */
export interface FrontmatterWarning {
  readonly code: string
  readonly message: string
}

/** Normalized skill frontmatter plus warnings. */
export interface ParsedSkillFrontmatter {
  readonly frontmatter: SkillFrontmatter
  readonly warnings: readonly FrontmatterWarning[]
}

/**
 * Normalize Agent Skills / Claude / Codex skill frontmatter.
 * @param data - parsed YAML object.
 * @param fallbackName - directory or file name used when `name` is absent.
 * @returns normalized frontmatter and warnings; never throws.
 */
export function parseSkillFrontmatter(
  data: Record<string, unknown>,
  fallbackName: string,
): ParsedSkillFrontmatter {
  const warnings: FrontmatterWarning[] = []
  const rawName = frontmatterString(data, 'name') ?? fallbackName
  // DSH addresses skills by `^[a-z0-9]+(?:-[a-z0-9]+)*$`; one invalid name
  // from a provider aborts the whole skill catalog, so normalize here.
  const name = kebabCase(rawName)
  if (name !== rawName) {
    warnings.push({ code: 'skill-name-normalized', message: `skill "${rawName}" is addressed as "${name}" in DSH` })
  }
  const description = frontmatterString(data, 'description')
  if (description === undefined) {
    warnings.push({ code: 'skill-description-missing', message: `skill "${name}" has no description` })
  }
  const disableModelInvocation = booleanValue(data['disable-model-invocation'])
  if (data['disable-model-invocation'] !== undefined && disableModelInvocation === undefined) {
    warnings.push({
      code: 'skill-invocation-invalid',
      message: `skill "${name}" has a non-boolean disable-model-invocation; the model surface is disabled`,
    })
  }
  const userInvocable = booleanValue(data['user-invocable'])
  if (data['user-invocable'] !== undefined && userInvocable === undefined) {
    warnings.push({
      code: 'skill-invocation-invalid',
      message: `skill "${name}" has a non-boolean user-invocable; the user surface is disabled`,
    })
  }
  const metadata = typeof data['metadata'] === 'object' && data['metadata'] !== null && !Array.isArray(data['metadata'])
    ? data['metadata'] as Record<string, unknown>
    : undefined
  const whenToUse = frontmatterString(data, 'whenToUse', 'when_to_use')
  const allowedTools = toolList(data['allowed-tools'])
  const disallowedTools = toolList(data['disallowed-tools'])
  const license = frontmatterString(data, 'license')
  const compatibility = frontmatterString(data, 'compatibility')
  return {
    frontmatter: {
      name,
      description: description ?? '',
      ...(whenToUse !== undefined ? { whenToUse } : {}),
      ...(license !== undefined ? { license } : {}),
      ...(compatibility !== undefined ? { compatibility } : {}),
      ...(allowedTools !== undefined ? { allowedTools } : {}),
      ...(disallowedTools !== undefined ? { disallowedTools } : {}),
      modelInvocable: disableModelInvocation !== true,
      userInvocable: userInvocable !== false,
      ...(metadata !== undefined ? { metadata } : {}),
      raw: data,
    },
    warnings,
  }
}
