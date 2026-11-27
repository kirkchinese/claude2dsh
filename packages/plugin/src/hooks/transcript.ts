/**
 * A Claude Code–format transcript mirror of each DSH session. Hooks receive
 * its path as `transcript_path` and read it the way they read Claude Code's
 * own JSONL: one record per line, `type` `user`/`assistant`, Anthropic
 * content blocks (`text`, `thinking`, `tool_use`, `tool_result`) with Claude
 * tool names and input shapes. The file is rewritten when the session has
 * new events since the last read.
 * @module @kirkchinese/harness-forge
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { foreignTool, type ToolContext } from './vocabulary.js'

/** The session surface the mirror reads. */
export interface TranscriptSession {
  readonly header: { readonly id: string; readonly cwd?: string; readonly parentSession?: string }
  readonly seq: number
  snapshotEvents(): ReadonlyArray<{ readonly type: string; readonly time: number; readonly data: unknown }>
}

/** Keeps one JSONL mirror per session under a root directory. */
export class TranscriptMirror {
  private readonly written = new Map<string, number>()

  constructor(private readonly root: string, private readonly tools: ToolContext = {}) {}

  /** The mirror path of a session, refreshed to its current events. */
  path(session: TranscriptSession, cwd: string): string {
    const path = this.pathOf(session)
    if (this.written.get(path) === session.seq) return path
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, renderTranscript(session, cwd, this.tools))
      this.written.set(path, session.seq)
    } catch {
      // A transcript that cannot be written leaves the previous copy in place.
    }
    return path
  }

  /** The path without writing. */
  pathOf(session: TranscriptSession): string {
    const parent = session.header.parentSession
    return parent === undefined
      ? join(this.root, `${session.header.id}.jsonl`)
      : join(this.root, parent, 'subagents', `agent-${session.header.id}.jsonl`)
  }
}

/** Render a session's message events as Claude Code JSONL. */
export function renderTranscript(session: TranscriptSession, cwd: string, tools: ToolContext = {}): string {
  const lines: string[] = []
  let parent: string | null = null
  let index = 0
  const sessionId = session.header.id
  const push = (record: Record<string, unknown>, time: number): void => {
    const uuid = `${sessionId}-${String(index++).padStart(6, '0')}`
    lines.push(JSON.stringify({
      parentUuid: parent,
      isSidechain: session.header.parentSession !== undefined,
      userType: 'external',
      cwd,
      sessionId,
      version: 'dsh-harness-forge',
      ...record,
      uuid,
      timestamp: new Date(time).toISOString(),
    }))
    parent = uuid
  }
  for (const event of session.snapshotEvents()) {
    const data = isRecord(event.data) ? event.data : {}
    if (event.type === 'user/message') {
      const content = blocks(data['content']).flatMap(userBlock)
      if (content.length === 0) continue
      push({ type: 'user', message: { role: 'user', content } }, event.time)
    } else if (event.type === 'assistant/message') {
      const message = isRecord(data['message']) ? data['message'] : {}
      const content = blocks(message['content']).flatMap(block => assistantBlock(block, cwd, tools))
      if (content.length === 0) continue
      const source = isRecord(message['source']) ? message['source'] : {}
      push({
        type: 'assistant',
        message: {
          id: typeof message['id'] === 'string' ? message['id'] : `msg_${String(index)}`,
          type: 'message',
          role: 'assistant',
          model: typeof source['model'] === 'string' ? source['model'] : 'dsh',
          content,
          stop_reason: content.some(block => block['type'] === 'tool_use') ? 'tool_use' : 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }, event.time)
    } else if (event.type === 'tool/result') {
      const message = isRecord(data['message']) ? data['message'] : {}
      const callId = message['toolCallId'] ?? (isRecord(message['source']) ? message['source']['callId'] : undefined)
      if (typeof callId !== 'string') continue
      const text = blocks(message['content']).map(block => typeof block['text'] === 'string' ? block['text'] : '').join('')
      push({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: text, is_error: message['isError'] === true }] },
      }, event.time)
    }
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

function userBlock(block: Record<string, unknown>): Array<Record<string, unknown>> {
  if (block['type'] === 'text' && typeof block['text'] === 'string') return [{ type: 'text', text: block['text'] }]
  if (block['type'] === 'image') return [{ type: 'image', source: block['source'] ?? {} }]
  return []
}

function assistantBlock(block: Record<string, unknown>, cwd: string, tools: ToolContext): Array<Record<string, unknown>> {
  if (block['type'] === 'text' && typeof block['text'] === 'string') return [{ type: 'text', text: block['text'] }]
  if (block['type'] === 'reasoning' && typeof block['text'] === 'string') return [{ type: 'thinking', thinking: block['text'], signature: '' }]
  if (block['type'] === 'tool-call') {
    const name = String(block['name'] ?? '')
    const args = typeof block['arguments'] === 'string' ? parse(block['arguments']) : block['arguments']
    const tool = foreignTool('claude-code', name, args, { ...tools, cwd })
    return [{ type: 'tool_use', id: block['id'], name: tool.name, input: tool.input }]
  }
  return []
}

function blocks(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return {}
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
