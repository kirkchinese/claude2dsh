/**
 * Scripted Messages-compatible model endpoint. A policy function answers every request with text and/or tool
 * calls, so a real DSH can be driven through exact tool sequences without a provider key. Every request body is
 * kept: the tool list and the messages are what an installed plugin visibly changes.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** One scripted model reply. */
export interface Reply {
  readonly text?: string
  readonly tools?: ReadonlyArray<{ readonly name: string; readonly input: Record<string, unknown> }>
}

/** The subset of the Messages request body the checks read. */
export interface MessagesRequest {
  readonly model?: string
  readonly system?: string | ReadonlyArray<{ readonly text?: string }>
  readonly tools?: ReadonlyArray<{ readonly name: string; readonly description?: string; readonly input_schema?: unknown }>
  readonly messages?: ReadonlyArray<{ readonly role: string; readonly content: unknown }>
}

/** Decide the reply for one request; `undefined` answers with a final "Done.". */
export type Policy = (request: MessagesRequest, seen: readonly MessagesRequest[]) => Reply | undefined

/** A running scripted endpoint. */
export interface ScriptedLlm {
  /** Base URL to export as `DEEPSEEK_BASE_URL`. */
  readonly baseURL: string
  readonly requests: readonly MessagesRequest[]
  close(): Promise<void>
}

export async function startScriptedLlm(policy: Policy): Promise<ScriptedLlm> {
  const requests: MessagesRequest[] = []
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: String(error) } }))
    })
  })

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST' || !(request.url ?? '').split('?')[0]!.endsWith('/messages')) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: `no mock route for ${request.method} ${request.url}` } }))
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as MessagesRequest
    const seen = [...requests]
    requests.push(body)
    // Host-side auxiliary calls (session titles) offer no tools; they never take part in a script.
    const reply = isAuxiliary(body) ? { text: 'E2E session' } : policy(body, seen) ?? { text: 'Done.' }
    stream(response, reply)
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  return {
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    }),
  }
}

function stream(response: ServerResponse, reply: Reply): void {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const write = (event: Record<string, unknown> & { type: string }): void => {
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  }
  write({ type: 'message_start', message: { id: `mock-${Date.now()}`, type: 'message', role: 'assistant', model: 'mock-model', content: [], usage: { input_tokens: 1, output_tokens: 0 } } })
  let index = 0
  if (reply.text !== undefined && reply.text.length > 0) {
    write({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
    write({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: reply.text } })
    write({ type: 'content_block_stop', index })
    index += 1
  }
  for (const [offset, tool] of (reply.tools ?? []).entries()) {
    write({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `call_${Date.now()}_${offset}`, name: tool.name, input: {} } })
    write({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } })
    write({ type: 'content_block_stop', index })
    index += 1
  }
  write({ type: 'message_delta', delta: { stop_reason: (reply.tools?.length ?? 0) > 0 ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
  write({ type: 'message_stop' })
  response.end()
}

/** Whether a request is a host-side auxiliary call rather than an agent step. */
export function isAuxiliary(request: MessagesRequest): boolean {
  return (request.tools ?? []).length === 0
}

/** The tool names a request offered the model. */
export function toolNames(request: MessagesRequest): string[] {
  return (request.tools ?? []).map(tool => tool.name)
}

/** The system prompt of a request. */
export function systemText(request: MessagesRequest): string {
  const system = request.system
  return system === undefined ? '' : typeof system === 'string' ? system : system.map(block => block.text ?? '').join('\n')
}

/** The system prompt and every message of a request as one text, tool inputs and results included. */
export function requestText(request: MessagesRequest): string {
  return [systemText(request), ...(request.messages ?? []).map(message => flatten(message.content))].join('\n')
}

function flatten(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block: unknown) => {
    if (typeof block !== 'object' || block === null) return ''
    const value = block as { text?: unknown; content?: unknown; input?: unknown }
    if (typeof value.text === 'string') return value.text
    if (value.content !== undefined) return flatten(value.content)
    if (value.input !== undefined) return JSON.stringify(value.input)
    return ''
  }).join('\n')
}
