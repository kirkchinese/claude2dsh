/**
 * What hooks show the user rather than the model — a `systemMessage`, a
 * `<event> hook error` notice, a block or stop reason, a terminal
 * notification — recorded in the session as `plugin:harness-forge/notice`
 * records. A reader that does not know the record skips it; the Harness
 * Forge client renders it in the conversation.
 * @module @kirkchinese/harness-forge
 */
import { appendRecord, type HookNotice } from '../dsh/session-records.js'

export type { HookNotice, HookOutputRecord } from '../dsh/session-records.js'

/** Record one notice in a session; a session that refuses the record loses only the notice. */
export function appendNotice(session: unknown, notice: HookNotice): void {
  try {
    appendRecord(session, 'plugin:harness-forge/notice', notice)
  } catch {
    // The notice is informational.
  }
}

/** Parse the notification a `terminalSequence` carries (OSC 9, 99, 777 and titles). */
export function terminalNotification(sequence: string): { title?: string; body: string } | undefined {
  // eslint-disable-next-line no-control-regex
  const osc = /\u001b\](\d+);([^\u0007\u001b]*)(?:\u0007|\u001b\\)/gu
  for (const match of sequence.matchAll(osc)) {
    const code = match[1]
    const payload = match[2] ?? ''
    if (code === '777') {
      const [, title, ...body] = payload.split(';')
      return { ...(title !== undefined ? { title } : {}), body: body.join(';') }
    }
    if (code === '9' && !payload.startsWith('4;')) return { body: payload }
    if (code === '99') return { body: payload.replace(/^[^;]*;/u, '') }
    if (code === '0' || code === '2') return { title: payload, body: '' }
  }
  // eslint-disable-next-line no-control-regex
  return sequence.includes('\u0007') ? { body: '' } : undefined
}
