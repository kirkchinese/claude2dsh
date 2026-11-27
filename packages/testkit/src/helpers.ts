/** Pure helpers of the end-to-end runner. */
import { Document, isMap, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml'

/** One parsed `--json` event of a headless session. */
export interface HeadlessEvent {
  readonly type: string
  readonly [field: string]: unknown
}

/** Parse the JSON lines of a headless run's stdout; other lines (diagnostics) are skipped. */
export function parseEvents(stdout: string): HeadlessEvent[] {
  const events: HeadlessEvent[] = []
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.startsWith('{')) continue
    try {
      events.push(JSON.parse(line) as HeadlessEvent)
    } catch {
      // not an event
    }
  }
  return events
}

/** One line of the result table. */
export interface Outcome {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
  readonly ms: number
}

/** A short pass/fail table. */
export function renderTable(outcomes: readonly Outcome[]): string {
  const width = Math.max(...outcomes.map(outcome => outcome.name.length), 5)
  const lines = outcomes.map(outcome => `${outcome.ok ? 'PASS' : 'FAIL'}  ${outcome.name.padEnd(width)}  ${(outcome.ms / 1000).toFixed(1).padStart(5)}s  ${outcome.detail}`)
  const failed = outcomes.filter(outcome => !outcome.ok).length
  return [...lines, '', failed === 0 ? `${outcomes.length} checks passed` : `${failed} of ${outcomes.length} checks FAILED`].join('\n')
}

/**
 * The Web bundle's patch without what only serves the browser: its rows that bind the web server, the UI
 * connection or the signed-in account, and the client UI rows. What is left composes the agent plane (agent
 * presets, delegation, tools) over a headless profile, which has none of its own.
 */
export function agentPlanePatch(webPatch: string, webOnlyRows: ReadonlySet<string>): string {
  const source = parseDocument(webPatch)
  const kept: YAMLMap[] = []
  for (const item of (source.contents as YAMLSeq<YAMLMap>).items) {
    if (!isMap(item)) continue
    // A bare disable directive (`id` + `disabled`) stays.
    if (item.get('disabled') === true && item.items.length === 2) {
      kept.push(item)
      continue
    }
    const insert = item.get('insert')
    if (!isSeq(insert)) continue
    const rows = insert.items.filter(row => isMap(row) && !webOnlyRows.has(String(row.get('id'))) && !String(row.get('name')).startsWith('@deepseek-ai/dsh-client-'))
    if (rows.length === 0) continue
    const copy = item.clone() as YAMLMap
    ;(copy.get('insert') as YAMLSeq).items = rows
    kept.push(copy)
  }
  const out = new Document([])
  ;(out.contents as YAMLSeq).items = kept
  return out.toString({ lineWidth: 0 })
}

/** The results of every call to `tool`, in order, with whether DSH reported the call as failed. */
export function toolResults(events: readonly HeadlessEvent[], tool: string): Array<{ readonly ok: boolean; readonly text: string }> {
  const calls = new Set(events.filter(event => event.type === 'tool_call' && event.tool === tool).map(event => event['callId']))
  return events
    .filter(event => event.type === 'tool_result' && calls.has(event['callId']))
    .map(event => ({ ok: event['status'] === 'completed', text: typeof event['result'] === 'string' ? event['result'] : JSON.stringify(event['result']) }))
}
