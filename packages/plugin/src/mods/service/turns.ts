/**
 * Prompts and turns: `prompt.submit`, `prompt.context`, `turn.start` and
 * `turn.complete`.
 * @module @kirkchinese/harness-forge/mods
 */
import { homedir } from 'node:os'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { loadInstructions } from '@kirkchinese/harness-forge-core'
import { appendNotice } from '../../hooks/notice.js'
import { claudeMdText } from '../engine.js'
import { isRecord } from '../values.js'
import { hasHooks, type SessionRegistry } from './sessions.js'
import type { PreStep, PreStepDecision, SessionMods } from './types.js'

/** The sessions' mods around each prompt and turn. */
export class ModTurns {
  constructor(private readonly registry: SessionRegistry) {}

  // ---------------------------------------------------------------------------
  // Prompts and turns
  // ---------------------------------------------------------------------------

  async preStep(payload: PreStep, next: () => Promise<PreStepDecision>): Promise<PreStepDecision> {
    const found = this.registry.sessionOf(payload.agent)
    if (found === undefined || found.session.engine.mods.length === 0) return next()
    const { session, agentId } = found
    await session.ready
    const engine = session.engine
    const prompt = payload.messages.filter(message => message.source?.kind === 'user')
    const text = prompt.flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text ?? '').join('')
    let submitted: { text: string; context?: readonly string[] } = { text }
    if (prompt.length > 0 && agentId === undefined && hasHooks(engine, 'prompt.submit')) {
      const result = await engine.raise('prompt.submit', { text, wait: false, origin: { kind: 'composer' } }, { signal: payload.signal }) as Record<string, unknown>
      if (typeof result['drop'] === 'string') {
        appendNotice(payload.agent!.session, { kind: 'blocked', event: 'prompt.submit', plugin: 'mods', text: `Prompt dropped by a hook: ${result['drop']}` })
        return { kind: 'reject' }
      }
      submitted = {
        text: typeof result['text'] === 'string' ? result['text'] : text,
        ...(Array.isArray(result['context']) ? { context: result['context'].map(String) } : {}),
      }
    }
    const contextMessages = agentId === undefined && !session.isContextRaised && prompt.length > 0 && hasHooks(engine, 'prompt.context')
      ? await this.promptContext(session, payload.signal)
      : []
    const record = session.turns.get(payload.turn) ?? { startedAt: Date.now(), answer: '', started: false }
    session.turns.set(payload.turn, record)
    if (!record.started && agentId === undefined) {
      record.started = true
      if (hasHooks(engine, 'turn.start')) await engine.raise('turn.start', { text: submitted.text, turnId: String(payload.turn) }, { signal: payload.signal }).catch(() => undefined)
    }
    const entered = await next()
    const decision = entered.kind === 'enter' && contextMessages.length > 0 ? { ...entered, messages: [...(entered.messages ?? []), ...contextMessages] } : entered
    if (decision.kind !== 'enter' || prompt.length === 0) return decision
    const context = submitted.context ?? []
    if (submitted.text === text && context.length === 0) return decision
    const rewritten = new Map<unknown, unknown>()
    prompt.forEach((message, index) => {
      const content = index === 0 && submitted.text !== text ? [{ type: 'text', text: submitted.text }, ...message.content.filter(block => block.type !== 'text')] : index === 0 ? message.content : message.content.filter(block => block.type !== 'text')
      const last = index === prompt.length - 1
      rewritten.set(message, { ...message, content: last ? [...content, ...context.map(line => ({ type: 'text', text: line }))] : content })
    })
    return { ...decision, messages: decision.messages?.map(message => rewritten.get(message) ?? message) }
  }

  /**
   * `prompt.context` for the conversation's first prompt: the instruction
   * files Claude Code itself would load (found as core's `loadInstructions`
   * finds them) and the blocks they frame. Files a hook adds that DSH's own
   * instructions did not load enter the conversation as context.
   */
  private async promptContext(session: SessionMods, signal: AbortSignal): Promise<unknown[]> {
    session.isContextRaised = true
    const cwd = await this.registry.host.directory(session.agent, signal).catch(() => session.agent.session.header.cwd ?? process.cwd())
    const files = claudeInstructionFiles(cwd)
    const blocks = [
      ...(files.length > 0 ? [{ name: 'claudeMd', text: claudeMdText(files) }] : []),
      { name: 'currentDate', text: `Today's date is ${new Date().toISOString().slice(0, 10)}.` },
    ]
    const result = await session.engine.raise('prompt.context', { blocks, instructionFiles: files }, { signal }).catch(() => undefined) as Record<string, unknown> | undefined
    const after = Array.isArray(result?.['instructionFiles']) ? result['instructionFiles'].filter(isRecord) : undefined
    if (after === undefined) return []
    const dshLoads = new Set(['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md'])
    const added = after.filter(file => !files.some(known => known.path === file['path']) && !dshLoads.has(String(file['path']).split(/[\\/]/u).pop() ?? ''))
    return added.map(file => createUserMessage({
      content: [{ type: 'text', text: `Contents of ${String(file['path'])}:\n\n${String(file['content'] ?? '')}` }],
      source: { kind: 'user' },
    }))
  }

  sessionEvent(session: { id: string }, event: { type: string; data: Record<string, unknown> }): void {
    const mods = this.registry.sessions.get(session.id)
    if (mods === undefined) return
    const turn = typeof event.data['turn'] === 'number' ? event.data['turn'] : undefined
    if (event.type === 'assistant/message' && turn !== undefined) {
      const record = mods.turns.get(turn)
      const message = event.data['message'] as { content?: Array<{ type: string; text?: string }> } | undefined
      if (record !== undefined && Array.isArray(message?.content)) record.answer = message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
      return
    }
    if (event.type !== 'turn/end' || turn === undefined) return
    const record = mods.turns.get(turn)
    mods.turns.delete(turn)
    mods.surfaces.invalidate()
    if (!hasHooks(mods.engine, 'turn.complete')) return
    const reason = event.data['reason'] as { kind?: string } | undefined
    void mods.engine.raise('turn.complete', {
      turnId: String(turn),
      answer: record?.answer ?? '',
      durationMs: record === undefined ? 0 : Date.now() - record.startedAt,
      isAborted: reason?.kind === 'aborted',
      reason: reason?.kind === 'aborted' ? 'aborted' : reason?.kind === 'error' ? 'error' : 'answer',
      usage: null,
    }).then((result) => {
      const text = isRecord(result) ? result['text'] : undefined
      if (typeof text === 'string' && text.length > 0) appendNotice(mods.agent.session, { kind: 'system-message', event: 'turn.complete', plugin: 'mods', text })
    }, () => undefined)
  }
}

/**
 * The instruction files Claude Code loads for a working directory, found by
 * core's discovery: the user's (~/.claude/CLAUDE.md), then from the repository
 * root (the working directory outside a repository) down to the directory each
 * CLAUDE.md, .claude/CLAUDE.md and CLAUDE.local.md, with their `@path` imports.
 * Every file is returned, including those DSH injects itself.
 */
export function claudeInstructionFiles(cwd: string, home = homedir()): Array<{ path: string; kind: string; content: string }> {
  return loadInstructions({ cwd, home, skipCodex: true }).files.map(({ path, kind, content }) => ({ path, kind, content }))
}
