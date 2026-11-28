/**
 * Turns as a stored session and a source session are compared, to tell which source session a stored one holds:
 * what the person said and what the assistant answered, in text, read one turn at a time and only as far as the
 * comparison needs.
 * @module @kirkchinese/harness-forge
 */

/** One turn, as compared: the person's prompt and the assistant's text answer, whitespace aside. */
export interface TurnText {
  readonly prompt: string
  readonly reply: string
}

/** The turns of one session, read in order and only as far as asked. */
export interface TurnReader {
  /** Turn `index` (0-based); `undefined` past the last. Rejects when the session cannot be read. */
  at(index: number): Promise<TurnText | undefined>
  /** Let go of what it reads from. */
  close(): Promise<void>
}

/** How two sessions' turns compare: the same throughout, parting ways, or not known (unread, or one only begins like the other). */
export type TurnComparison = 'same' | 'different' | 'unknown'

/** One turn as compared, from what it says. */
export function turnText(prompt: string, replies: readonly string[]): TurnText {
  return { prompt: collapse(prompt), reply: collapse(replies.join('\n')) }
}

function collapse(text: string): string {
  return text.trim().replace(/\s+/gu, ' ')
}

/** The text of the assistant's answer in one step's content: its `text` blocks (not its reasoning nor its tool calls). */
export function replyText(content: readonly unknown[]): string[] {
  return content.flatMap((block) => {
    const value = block as { type?: unknown; text?: unknown } | null
    return value?.type === 'text' && typeof value.text === 'string' ? [value.text] : []
  })
}

/**
 * A reader over turns handed out one by one (a generator that reads its source as it goes); the turns read are
 * kept, so several comparisons read the source once.
 */
export function turnReader(source: AsyncIterator<TurnText, unknown>): TurnReader {
  const turns: TurnText[] = []
  let done = false
  return {
    async at(index) {
      while (!done && turns.length <= index) {
        const next = await source.next()
        if (next.done === true) done = true
        else turns.push(next.value)
      }
      return turns[index]
    },
    async close() {
      if (!done) await source.return?.(undefined)
      done = true
    },
  }
}

/** Compare two sessions turn by turn, prompt and reply, stopping at the first turn that differs. */
export async function compareTurns(a: TurnReader, b: TurnReader): Promise<TurnComparison> {
  try {
    for (let index = 0; ; index++) {
      const [left, right] = await Promise.all([a.at(index), b.at(index)])
      if (left === undefined && right === undefined) return index === 0 ? 'unknown' : 'same'
      // One goes on past the other: it went on after the import, or the stored one did in DSH.
      if (left === undefined || right === undefined) return 'unknown'
      if (left.prompt !== right.prompt || left.reply !== right.reply) return 'different'
    }
  } catch {
    return 'unknown'
  }
}
