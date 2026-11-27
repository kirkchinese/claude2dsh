/**
 * Plain helpers the hook broker's parts share.
 * @module @kirkchinese/harness-forge
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionLike } from './types.js'

/** The text of the last assistant message in a session. */
export function lastAssistantText(session: SessionLike): string | null {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    const message = isRecord(event.data) && isRecord(event.data['message']) ? event.data['message'] : {}
    const text = Array.isArray(message['content'])
      ? message['content'].filter(isRecord).filter(block => block['type'] === 'text').map(block => String(block['text'] ?? '')).join('')
      : ''
    if (text.length > 0) return text
  }
  return null
}

export function textOf(content: readonly ContentBlock[]): string {
  return content.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text').map(block => block.text).join('')
}


export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
