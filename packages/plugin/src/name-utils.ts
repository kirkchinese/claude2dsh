/** Path-safe kebab-case names shared by plugin-asset and memory migration. */

export function safeSegment(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed === '.' || trimmed === '..') return ''
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.startsWith('.')) return ''
  return trimmed.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
}

export function safeSkillName(namespace: string, name: string): string {
  const ns = safeSegment(namespace)
  const n = safeSegment(name)
  if (ns.length === 0 || n.length === 0) return ''
  const targetName = `${ns}-${n}`.replace(/^-+|-+$/g, '')
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(targetName) ? targetName : ''
}
