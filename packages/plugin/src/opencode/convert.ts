/**
 * DSH ↔ OpenCode vocabulary: tool names and arguments as OpenCode's own tools
 * name them, and a DSH session log as OpenCode's sessions, messages and parts
 * (`@opencode-ai/sdk` v1 types).
 * @module @kirkchinese/harness-forge/opencode
 */
import { isAbsolute, resolve } from 'node:path'

/** DSH tool → OpenCode's built-in tool of the same job. */
const TOOL_NAMES: Readonly<Record<string, string>> = {
  bash: 'bash',
  pwsh: 'bash',
  read: 'read',
  read_image: 'read',
  write: 'write',
  edit: 'edit',
  glob: 'glob',
  grep: 'grep',
  web_fetch: 'webfetch',
  web_search: 'websearch',
  todo_write: 'todowrite',
  subagent: 'task',
  subagent_fork: 'task',
  agent: 'task',
  skill: 'skill',
  ask_user_question: 'question',
}

/** OpenCode's name for a DSH tool; MCP and plugin tools keep theirs. */
export function openCodeToolName(dshName: string): string {
  return TOOL_NAMES[dshName] ?? dshName
}

/** OpenCode's permission name for a DSH tool (`bash`, `edit`, `webfetch`, ...). */
export function permissionType(dshName: string): string {
  const name = openCodeToolName(dshName)
  return name === 'write' ? 'edit' : name
}

const absolute = (path: unknown, cwd: string): unknown => (typeof path === 'string' && path.length > 0 && !isAbsolute(path) ? resolve(cwd, path) : path)

/** A DSH call's arguments as OpenCode's tool of the same name takes them. */
export function openCodeArgs(dshName: string, args: unknown, cwd: string): Record<string, unknown> {
  const input = isRecord(args) ? args : {}
  switch (openCodeToolName(dshName)) {
    case 'bash':
      return {
        command: input['command'],
        description: input['description'] ?? '',
        ...(typeof input['timeoutMs'] === 'number' ? { timeout: input['timeoutMs'] } : {}),
        ...(typeof input['workdir'] === 'string' ? { workdir: input['workdir'] } : {}),
      }
    case 'read':
      return { filePath: absolute(input['file_path'] ?? input['path'], cwd), ...pick(input, { offset: 'offset', limit: 'limit' }) }
    case 'write':
      return { filePath: absolute(input['file_path'], cwd), content: input['content'] }
    case 'edit':
      return {
        filePath: absolute(input['file_path'], cwd),
        oldString: input['old_string'],
        newString: input['new_string'],
        ...(input['replace_all'] === true ? { replaceAll: true } : {}),
      }
    case 'glob':
      return { pattern: input['pattern'], ...(typeof input['path'] === 'string' ? { path: absolute(input['path'], cwd) } : {}) }
    case 'grep':
      return {
        pattern: input['pattern'],
        ...(typeof input['path'] === 'string' ? { path: absolute(input['path'], cwd) } : {}),
        ...(typeof input['include'] === 'string' ? { include: input['include'] } : {}),
      }
    case 'webfetch':
      return { url: input['url'], format: 'markdown' }
    case 'websearch': {
      const queries = Array.isArray(input['queries']) ? input['queries'].map(String) : []
      return { query: queries[0] ?? '' }
    }
    case 'task':
      return { description: input['description'] ?? '', prompt: input['prompt'], subagent_type: input['agent_preset'] ?? 'general' }
    case 'skill':
      return { name: input['name'] }
    default:
      return { ...input }
  }
}

/** OpenCode-named arguments back as the DSH tool takes them; DSH-only fields keep their values. */
export function dshArgs(dshName: string, original: unknown, updated: Record<string, unknown>): Record<string, unknown> {
  const base = isRecord(original) ? original : {}
  switch (openCodeToolName(dshName)) {
    case 'bash':
      return {
        ...base,
        command: updated['command'] ?? base['command'],
        ...(typeof updated['description'] === 'string' ? { description: updated['description'] } : {}),
        ...(typeof updated['timeout'] === 'number' ? { timeoutMs: updated['timeout'] } : {}),
        ...(typeof updated['workdir'] === 'string' ? { workdir: updated['workdir'] } : {}),
      }
    case 'read':
      return { ...base, file_path: updated['filePath'] ?? base['file_path'], ...pick(updated, { offset: 'offset', limit: 'limit' }) }
    case 'write':
      return { ...base, file_path: updated['filePath'] ?? base['file_path'], content: updated['content'] ?? base['content'] }
    case 'edit':
      return {
        ...base,
        file_path: updated['filePath'] ?? base['file_path'],
        old_string: updated['oldString'] ?? base['old_string'],
        new_string: updated['newString'] ?? base['new_string'],
        ...(typeof updated['replaceAll'] === 'boolean' ? { replace_all: updated['replaceAll'] } : {}),
      }
    case 'glob':
    case 'grep':
      return { ...base, ...updated }
    case 'webfetch':
      return { ...base, url: updated['url'] ?? base['url'] }
    case 'websearch':
      return { ...base, queries: typeof updated['query'] === 'string' ? [updated['query']] : base['queries'] }
    case 'task':
      return { ...base, prompt: updated['prompt'] ?? base['prompt'], description: updated['description'] ?? base['description'] }
    case 'skill':
      return { ...base, name: updated['name'] ?? base['name'] }
    default:
      return updated
  }
}

function pick(input: Record<string, unknown>, names: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [from, to] of Object.entries(names)) if (input[from] !== undefined) out[to] = input[from]
  return out
}

// -----------------------------------------------------------------------------
// Sessions, messages and parts
// -----------------------------------------------------------------------------

/** The DSH facts one OpenCode view is built from. */
export interface SessionFacts {
  readonly id: string
  readonly cwd: string
  readonly projectId: string
  readonly worktree: string
  readonly parentId?: string
  readonly title: string
  readonly created: number
  readonly updated: number
  readonly provider: string
  readonly model: string
  readonly agent: string
}

/** OpenCode's `Session`. */
export function sessionInfo(facts: SessionFacts): Record<string, unknown> {
  return {
    id: facts.id,
    projectID: facts.projectId,
    directory: facts.cwd,
    ...(facts.parentId !== undefined ? { parentID: facts.parentId } : {}),
    title: facts.title,
    version: '1.19.6',
    time: { created: facts.created, updated: facts.updated },
  }
}

/** One logged event of a DSH session, as read back. */
export interface LoggedEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

/** One OpenCode message with its parts. */
export interface MessageWithParts {
  readonly info: Record<string, unknown>
  readonly parts: Array<Record<string, unknown>>
}

/** Block arrays of a DSH message. */
function blocksOf(message: unknown): Array<Record<string, unknown>> {
  return isRecord(message) && Array.isArray(message['content']) ? message['content'].filter(isRecord) : []
}

/** OpenCode's user message (info) for one DSH user message. */
export function userInfo(facts: SessionFacts, message: Record<string, unknown>, time: number): Record<string, unknown> {
  return {
    id: String(message['id'] ?? `msg_${time}`),
    sessionID: facts.id,
    role: 'user',
    time: { created: time },
    agent: facts.agent,
    model: { providerID: facts.provider, modelID: facts.model },
  }
}

/** OpenCode's parts for one DSH user message: text and file parts, synthetic unless typed by a person. */
export function userParts(sessionId: string, message: Record<string, unknown>): Array<Record<string, unknown>> {
  const messageId = String(message['id'] ?? '')
  const source = isRecord(message['source']) ? message['source'] : {}
  const synthetic = source['kind'] !== 'user' || source['synthetic'] === true
  return blocksOf(message).flatMap((block, index): Array<Record<string, unknown>> => {
    const base = { id: `prt_${messageId}_${index}`, sessionID: sessionId, messageID: messageId }
    if (block['type'] === 'text') return [{ ...base, type: 'text', text: String(block['text'] ?? ''), ...(synthetic ? { synthetic: true } : {}) }]
    if (block['type'] === 'image' || block['type'] === 'file') {
      const attachment = isRecord(block['attachment']) ? block['attachment'] : {}
      return [{ ...base, type: 'file', mime: String(attachment['mediaType'] ?? attachment['mimeType'] ?? 'application/octet-stream'), url: String(attachment['url'] ?? attachment['uri'] ?? ''), ...(typeof attachment['name'] === 'string' ? { filename: attachment['name'] } : {}) }]
    }
    return []
  })
}

/**
 * A DSH session log as OpenCode's messages: each user message, and each
 * step's assistant message with its text, reasoning and tool parts (a tool
 * part completed or errored by its logged result).
 */
export function messagesOf(facts: SessionFacts, events: readonly LoggedEvent[]): MessageWithParts[] {
  const out: MessageWithParts[] = []
  const results = new Map<string, { text: string; isError: boolean; time: number }>()
  for (const event of events) {
    if (event.type !== 'tool/result' || !isRecord(event.data)) continue
    const message = isRecord(event.data['message']) ? event.data['message'] : {}
    const text = blocksOf(message).filter(block => block['type'] === 'text').map(block => String(block['text'] ?? '')).join('')
    results.set(String(message['toolCallId'] ?? ''), { text, isError: message['isError'] === true, time: event.time })
  }
  let lastUser = ''
  for (const event of events) {
    if (event.type === 'user/message' && isRecord(event.data)) {
      const info = userInfo(facts, event.data, event.time)
      lastUser = String(info['id'])
      out.push({ info, parts: userParts(facts.id, event.data) })
      continue
    }
    if (event.type !== 'assistant/message' || !isRecord(event.data)) continue
    const data = event.data
    const message = isRecord(data['message']) ? data['message'] : {}
    const id = String(message['id'] ?? `msg_${String(data['turn'])}_${String(data['step'])}`)
    const usage = isRecord(data['usage']) ? data['usage'] : {}
    const blocks = blocksOf(message)
    const calls = blocks.filter(block => block['type'] === 'tool-call')
    const info = {
      id,
      sessionID: facts.id,
      role: 'assistant',
      time: { created: event.time, completed: event.time },
      parentID: lastUser,
      modelID: facts.model,
      providerID: facts.provider,
      mode: facts.agent,
      path: { cwd: facts.cwd, root: facts.worktree },
      cost: 0,
      tokens: {
        input: Number(usage['inputTokens'] ?? 0),
        output: Number(usage['outputTokens'] ?? 0),
        reasoning: Number(usage['reasoningTokens'] ?? 0),
        cache: { read: Number(usage['cacheReadTokens'] ?? 0), write: Number(usage['cacheWriteTokens'] ?? 0) },
      },
      finish: calls.length > 0 ? 'tool-calls' : data['interrupted'] === true ? 'aborted' : 'stop',
    }
    const parts = blocks.flatMap((block, index): Array<Record<string, unknown>> => {
      const base = { id: `prt_${id}_${index}`, sessionID: facts.id, messageID: id }
      if (block['type'] === 'text') return [{ ...base, type: 'text', text: String(block['text'] ?? ''), time: { start: event.time, end: event.time } }]
      if (block['type'] === 'reasoning') return [{ ...base, type: 'reasoning', text: String(block['text'] ?? ''), time: { start: event.time, end: event.time } }]
      if (block['type'] === 'tool-call') return [toolPart(base, block, results.get(String(block['id'] ?? '')), facts.cwd, event.time)]
      return []
    })
    out.push({ info, parts })
  }
  return out
}

/** OpenCode's tool part for one DSH tool call, running until its result settles it. */
export function toolPart(
  base: Record<string, unknown>,
  call: Record<string, unknown>,
  result: { text: string; isError: boolean; time: number } | undefined,
  cwd: string,
  time: number,
): Record<string, unknown> {
  const dshName = String(call['name'] ?? '')
  let args: unknown = {}
  try {
    args = typeof call['arguments'] === 'string' ? JSON.parse(call['arguments']) : call['arguments']
  } catch {
    args = {}
  }
  const input = openCodeArgs(dshName, args, cwd)
  const tool = openCodeToolName(dshName)
  const state = result === undefined
    ? { status: 'running', input, time: { start: time } }
    : result.isError
      ? { status: 'error', input, error: result.text, time: { start: time, end: result.time } }
      : { status: 'completed', input, output: result.text, title: tool, metadata: {}, time: { start: time, end: result.time } }
  return { ...base, type: 'tool', callID: String(call['id'] ?? ''), tool, state }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
