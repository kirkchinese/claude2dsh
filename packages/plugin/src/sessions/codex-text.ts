/**
 * What the Codex rollout readers share: the text of a message's content, the prompts a person typed (not the
 * instructions Codex puts first), and the typed fields of a record.
 * @module @kirkchinese/harness-forge
 */

export function usablePrompt(text: string): boolean {
  const value = text.trim()
  if (value.length === 0) return false
  if (value.startsWith('<') || value.startsWith('# AGENTS.md')) return false
  return !(
    value.includes('<environment_context>')
    || value.includes('<skills_instructions>')
    || value.includes('<permissions instructions>')
    || value.includes('<user_instructions>')
  )
}

export function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((item) => {
      if (typeof item === 'string') return item
      if (typeof item !== 'object' || item === null) return ''
      const record = item as Record<string, unknown>
      return typeof record['text'] === 'string' ? record['text'] : ''
    })
    .filter(Boolean)
    .join('\n')
}

export function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function timestamp(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}
