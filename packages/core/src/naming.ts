/**
 * Deterministic naming helpers. Foreign plugins may carry names that DSH
 * cannot address directly (marketplace-qualified, uppercase, namespaced,
 * colliding); every conversion here is stable so receipts and re-imports agree.
 * @module @kirkchinese/harness-forge-core
 */
import { createHash } from 'node:crypto'

/** Maximum length of a DSH skill/command name in practice. */
export const MAX_NAME_LENGTH = 64

/** Convert arbitrary text to a lowercase kebab-case identifier. */
export function kebabCase(input: string): string {
  const base = input
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .toLowerCase()
    .slice(0, MAX_NAME_LENGTH)
    .replace(/-+$/u, '')
  return base.length > 0 ? base : `n-${shortHash(input, 8)}`
}

/** A short stable hash for collision suffixes and provenance. */
export function shortHash(input: string, length = 8): string {
  return createHash('sha256').update(input).digest('hex').slice(0, length)
}

/**
 * Return a name that is unique among `used`, adding a stable hash when needed.
 * The input name is returned unchanged when free, so normal imports stay
 * readable.
 */
export function uniqueName(base: string, used: ReadonlySet<string>, hashSource = base): string {
  const candidate = kebabCase(base)
  if (!used.has(candidate)) return candidate
  const suffix = `-${shortHash(hashSource)}`
  const stem = candidate.slice(0, Math.max(1, MAX_NAME_LENGTH - suffix.length)).replace(/-+$/u, '')
  return `${stem}${suffix}`
}

/** Prefix a component name with its source and plugin namespace. */
export function namespaced(source: string, plugin: string, name: string): string {
  return kebabCase(`${source}-${plugin}-${name}`)
}

/** A deterministic plugin id. */
export function pluginId(source: string, name: string): string {
  return `${source}:${kebabCase(name)}`
}

/** A deterministic child id. */
export function childId(plugin: string, kind: string, name: string): string {
  return `${plugin}:${kind}:${kebabCase(name)}`
}

/** Convert a Claude/Codex namespace separator (`:`) to a DSH-safe segment. */
export function namespaceSegment(input: string): string {
  return input
    .split(/[:/\\]/u)
    .map(kebabCase)
    .filter(segment => segment.length > 0 && segment !== 'unnamed')
    .join('-')
}
