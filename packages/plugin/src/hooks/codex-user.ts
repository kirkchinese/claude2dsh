/**
 * The parts of a user's Codex configuration that act at run time:
 *
 * - `notify`: when a turn of a main conversation completes, Codex runs the
 *   configured program with one more argument, a JSON object
 *   `{ type: "agent-turn-complete", "thread-id", "turn-id", cwd,
 *   "input-messages", "last-assistant-message" }`; so does DSH.
 * - the global instructions (`AGENTS.override.md`, else `AGENTS.md`), which
 *   Codex adds to every conversation, as a section of the main system prompt.
 * @module @kirkchinese/harness-forge
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { readCodexConfig } from '@kirkchinese/harness-forge-core'
import { dshService, onDsh, type DshEvent } from '../dsh/host.js'

interface Agent {
  readonly session: {
    readonly header: { readonly id: string; readonly cwd?: string; readonly delegationDepth?: number }
    readonly seq: number
    eventAt(seq: number): { type: string; data: unknown } | undefined
  }
}

interface Agents {
  get(id: string): Agent | undefined
}

/** Run Codex's `notify` program at every completed main-conversation turn. Returns the disposer. */
export function mountCodexNotify(ctx: Context, codexRoot: string, observe: (ok: boolean, detail: string) => void): () => void {
  const argv = (Array.isArray(readCodexConfig(codexRoot)['notify']) ? readCodexConfig(codexRoot)['notify'] as unknown[] : []).filter((item): item is string => typeof item === 'string')
  if (argv.length === 0) return () => {}
  const on = (name: DshEvent, listener: unknown): (() => void) => onDsh(ctx, name, listener as never)
  return on('session/event', ((session: { id: string }, event: { type: string; data: { turn?: number; reason?: string } }) => {
    if (event.type !== 'turn/end' || event.data.reason === 'aborted') return
    const agent = (dshService(ctx, 'agents') as Agents | undefined)?.get(session.id)
    if (agent === undefined || (agent.session.header.delegationDepth ?? 0) > 0) return
    const payload = {
      type: 'agent-turn-complete',
      'thread-id': session.id,
      'turn-id': String(event.data.turn ?? ''),
      cwd: agent.session.header.cwd ?? process.cwd(),
      'input-messages': turnInputs(agent, event.data.turn),
      'last-assistant-message': lastAnswer(agent),
    }
    const [command = '', ...args] = argv
    try {
      const child = spawn(command, [...args, JSON.stringify(payload)], { detached: true, stdio: 'ignore', windowsHide: true })
      child.on('error', (error) => { observe(false, `notify could not start: ${error.message}`) })
      child.on('spawn', () => { observe(true, `notify ran after turn ${String(event.data.turn ?? '')}`) })
      child.unref()
    } catch (error: unknown) {
      observe(false, `notify could not start: ${error instanceof Error ? error.message : String(error)}`)
    }
  }) as never)
}

/** The user's messages of one turn, as text. */
function turnInputs(agent: Agent, turn: number | undefined): string[] {
  const out: string[] = []
  let inTurn = false
  for (let seq = 0; seq < agent.session.seq; seq++) {
    const event = agent.session.eventAt(seq)
    if (event === undefined) continue
    if (event.type === 'turn/start') inTurn = (event.data as { turn?: number }).turn === turn
    if (!inTurn || event.type !== 'user/message') continue
    const message = event.data as { source?: { kind?: string }; content?: Array<{ type: string; text?: string }> }
    if (message.source?.kind !== 'user') continue
    out.push((message.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join(''))
  }
  return out
}

function lastAnswer(agent: Agent): string {
  for (let seq = agent.session.seq - 1; seq >= 0; seq--) {
    const event = agent.session.eventAt(seq)
    if (event?.type !== 'assistant/message') continue
    const message = (event.data as { message?: { content?: Array<{ type: string; text?: string }> } }).message
    const text = (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('')
    if (text.length > 0) return text
  }
  return ''
}

/** Add Codex's global instructions to the main conversation's system prompt. Returns the disposer. */
export function mountCodexInstructions(ctx: Context, codexRoot: string, file: string, observe: (ok: boolean, detail: string) => void): () => void {
  const prompt = dshService(ctx, 'systemPrompt') as {
    section(section: { name: string; order: number; text: (context: { scope?: unknown }) => string; interpolate?: boolean }): () => void
    getSectionOrder(name: string): number
  } | undefined
  if (prompt === undefined) return () => {}
  const path = join(codexRoot, file)
  let reported = false
  return prompt.section({
    name: 'harness-forge:codex-instructions',
    order: prompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX') - 2,
    interpolate: false,
    text: ({ scope }) => {
      const depth = (scope as { session?: { header?: { delegationDepth?: number } } } | undefined)?.session?.header?.delegationDepth ?? 0
      if (depth > 0) return ''
      let text: string
      try {
        text = readFileSync(path, 'utf8').trim()
      } catch {
        return ''
      }
      if (!reported) {
        reported = true
        observe(true, `${file} is in the system prompt`)
      }
      return text.length === 0 ? '' : `# Instructions from ~/.codex/${file}\n\n${text}`
    },
  })
}
