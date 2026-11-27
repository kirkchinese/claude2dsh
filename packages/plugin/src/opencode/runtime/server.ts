/**
 * The OpenCode-compatible server: the routes the plugin's SDK client calls
 * (sessions, prompts, files, logs, toasts) and the Bun hosts' own calls.
 * @module @kirkchinese/harness-forge/opencode
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { appendNotice } from '../../hooks/notice.js'
import { isRecord, messagesOf, sessionInfo, userInfo, userParts, type MessageWithParts } from '../convert.js'
import { dshService } from '../../dsh/host.js'
import type { OpenCodeCore } from './core.js'
import { messageOf } from '../../shared/util.js'
import type { Agent, Message, PluginHost } from './types.js'

/** The source of a message an OpenCode plugin added to a session (`client.session.prompt` with `noReply`). */
const PLUGIN_SOURCE = 'opencode-plugin'
const FULL_ACCESS = new Set(['danger-full-access', 'full-access'])

/** The OpenCode-compatible server plugins' `client` talks to, backed by DSH's sessions. */
export class OpenCodeServer {
  private readonly tui = { prompt: '' }
  server: Server | undefined
  base = ''
  private listening: Promise<void> | undefined

  constructor(private readonly core: OpenCodeCore) {}

  // ---------------------------------------------------------------------------
  // The OpenCode-compatible server
  // ---------------------------------------------------------------------------

  listen(): Promise<void> {
    this.listening ??= new Promise((resolve, reject) => {
      const server = createServer((req, res) => { void this.handle(req, res) })
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        this.base = `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`
        this.server = server
        resolve()
      })
    })
    return this.listening
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const body = req.method === 'GET' || req.method === 'HEAD' ? {} : await readBody(req)
    const plugin = this.pluginOf(req)
    try {
      const internal = /^\/__hf\/([^/]+)\/([a-z]+)$/u.exec(url.pathname)
      if (internal !== null) return send(res, 200, await this.internal(internal[1] ?? '', internal[2] ?? '', body))
      if (url.pathname === '/event' || url.pathname === '/global/event') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`)
        this.core.streams.add(res)
        req.on('close', () => { this.core.streams.delete(res) })
        return
      }
      const routed = await this.route(req.method ?? 'GET', url, body)
      if (routed === undefined) {
        if (plugin !== undefined) this.core.host.observe(plugin.componentId, `opencode:client:${req.method ?? 'GET'} ${templateOf(url.pathname)}`, false, 'Harness Forge does not serve this OpenCode route')
        return send(res, 501, { name: 'UnknownError', data: { message: `${req.method ?? 'GET'} ${url.pathname} is not served by Harness Forge's OpenCode server` } })
      }
      if (plugin !== undefined) this.core.host.observe(plugin.componentId, `opencode:client:${req.method ?? 'GET'} ${templateOf(url.pathname)}`, true, 'served')
      return send(res, routed.status ?? 200, routed.body)
    } catch (error: unknown) {
      return send(res, 400, { name: 'UnknownError', data: { message: messageOf(error) } })
    }
  }

  private pluginOf(req: IncomingMessage): PluginHost | undefined {
    const key = req.headers['x-hf-plugin']
    return typeof key === 'string' ? this.core.hosts.get(key) ?? [...this.core.hosts.values()].find(plugin => plugin.key === key) : undefined
  }

  /** The Bun hosts' own calls: readiness, a tool's permission request, a tool's metadata. */
  private async internal(key: string, action: string, body: Record<string, unknown>): Promise<unknown> {
    if (action === 'ready') {
      this.core.waiting.get(key)?.resolve(body)
      return { ok: true }
    }
    if (action === 'metadata') return { ok: true }
    if (action === 'ask') {
      const agent = this.core.agents()?.get(String(body['sessionID'] ?? ''))
      if (agent === undefined) return { allowed: false, reason: 'the session is gone' }
      const presets = dshService(this.core.ctx, 'permissionPresets') as { current(session: unknown): string } | undefined
      let preset: string | undefined
      try {
        preset = presets?.current(agent.session)
      } catch {
        preset = undefined
      }
      if (preset !== undefined && FULL_ACCESS.has(preset)) return { allowed: true }
      const approval = dshService(this.core.ctx, 'approval') as { request(req: Record<string, unknown>): Promise<string> } | undefined
      if (approval === undefined) return { allowed: true }
      const request = isRecord(body['request']) ? body['request'] : {}
      const patterns = Array.isArray(request['patterns']) ? request['patterns'].map(String).join(', ') : ''
      const outcome = await approval.request({
        agent,
        toolName: String(body['tool'] ?? 'tool'),
        ...(typeof body['callID'] === 'string' ? { callId: body['callID'] } : {}),
        reason: `${String(request['permission'] ?? 'permission')}${patterns.length > 0 ? `: ${patterns}` : ''}`,
      })
      return outcome === 'allowed-once' ? { allowed: true } : { allowed: false, reason: 'The user rejected permission to use this specific tool call.' }
    }
    return { ok: false }
  }

  /** OpenCode's server routes, as DSH serves them; undefined when not served. */
  private async route(method: string, url: URL, body: Record<string, unknown>): Promise<{ status?: number; body: unknown } | undefined> {
    const path = url.pathname.replace(/\/+$/u, '') || '/'
    const agents = this.core.agents()
    const sessionMatch = /^\/session\/([^/]+)(?:\/(.+))?$/u.exec(path)
    const sessionId = sessionMatch === null ? undefined : decodeURIComponent(sessionMatch[1] ?? '')
    const rest = sessionMatch?.[2]
    const agent = sessionId === undefined ? undefined : agents?.get(sessionId)
    const need = (): Agent => {
      if (agent === undefined) throw new Error(`Session not found: ${sessionId ?? ''}`)
      return agent
    }
    const directory = url.searchParams.get('directory') ?? process.cwd()
    const ok = (value: unknown): { body: unknown } => ({ body: value })

    if (method === 'GET' && path === '/session') return ok((agents?.list() ?? []).map(item => sessionInfo(this.core.facts(item))))
    if (method === 'GET' && path === '/session/status') {
      return ok(Object.fromEntries((agents?.list() ?? []).map(item => [item.session.header.id, { type: (item as unknown as { status?: string }).status === 'idle' ? 'idle' : 'busy' }])))
    }
    if (method === 'POST' && path === '/session') return ok(await this.createSession(body, directory))
    if (sessionMatch !== null) {
      if (method === 'GET' && rest === undefined) return ok(sessionInfo(this.core.facts(need())))
      if (method === 'DELETE' && rest === undefined) return ok(await this.deleteSession(sessionId ?? ''))
      if (method === 'PATCH' && rest === undefined) {
        const titles = dshService(this.core.ctx, 'sessionTitle') as { rename(session: unknown, title: string): unknown } | undefined
        if (typeof body['title'] === 'string') titles?.rename(need().session, body['title'])
        return ok(sessionInfo(this.core.facts(need())))
      }
      if (method === 'GET' && rest === 'children') return ok((agents?.list() ?? []).filter(item => this.core.facts(item).parentId === sessionId).map(item => sessionInfo(this.core.facts(item))))
      if (method === 'GET' && rest === 'message') {
        const limit = Number(url.searchParams.get('limit') ?? 0)
        const messages = messagesOf(this.core.facts(need()), this.core.events(need()))
        return ok(limit > 0 ? messages.slice(-limit) : messages)
      }
      if (method === 'GET' && rest?.startsWith('message/') === true) {
        const id = decodeURIComponent(rest.slice('message/'.length))
        const found = messagesOf(this.core.facts(need()), this.core.events(need())).find(message => message.info['id'] === id)
        if (found === undefined) throw new Error(`Message not found: ${id}`)
        return ok(found)
      }
      if (method === 'POST' && rest === 'message') return ok(await this.prompt(need(), body, true))
      if (method === 'POST' && rest === 'prompt_async') {
        await this.prompt(need(), body, false)
        return { status: 204, body: undefined }
      }
      if (method === 'POST' && rest === 'abort') {
        need().cancel({ kind: 'user' })
        return ok(true)
      }
      if (method === 'POST' && rest === 'command') {
        const commands = dshService(this.core.ctx, 'commands') as { execute(agent: unknown, line: string, attachments: unknown[], signal: AbortSignal): Promise<unknown> } | undefined
        const line = `/${String(body['command'] ?? '')}${typeof body['arguments'] === 'string' && body['arguments'].length > 0 ? ` ${body['arguments']}` : ''}`
        await commands?.execute(need(), line, [], new AbortController().signal)
        await need().whenIdle()
        return ok(this.lastAssistant(need()))
      }
      if (method === 'GET' && rest === 'todo') return ok([])
      return undefined
    }
    if (method === 'GET' && path === '/config') return ok(this.core.configFor(directory))
    if (method === 'GET' && (path === '/config/providers' || path === '/provider')) {
      const selection = this.core.defaultModel()
      const providers = selection === undefined ? [] : [{ id: selection.provider, name: selection.provider, env: [], models: { [selection.model]: { id: selection.model, providerID: selection.provider, name: selection.model, release_date: '', attachment: false, reasoning: true, temperature: true, tool_call: true, limit: { context: 0, output: 0 }, options: {} } } }]
      const defaults = selection === undefined ? {} : { [selection.provider]: selection.model }
      return ok(path === '/provider' ? { all: providers, default: defaults, connected: providers.map(provider => provider.id) } : { providers, default: defaults })
    }
    if (method === 'GET' && path === '/project') return ok([this.projectView(directory)])
    if (method === 'GET' && path === '/project/current') return ok(this.projectView(directory))
    if (method === 'GET' && path === '/path') {
      const configHome = process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config')
      return ok({ state: join(this.core.host.dataRoot, 'opencode'), config: join(configHome, 'opencode'), worktree: this.core.projectOf(directory).worktree, directory })
    }
    if (method === 'GET' && path === '/agent') {
      return ok([{ name: 'build', description: 'DSH default agent', mode: 'primary', builtIn: true, permission: { edit: 'allow', bash: {}, webfetch: 'allow' }, tools: {}, options: {} }])
    }
    if (method === 'GET' && path === '/command') {
      const commands = dshService(this.core.ctx, 'commands') as { list(agent: unknown): ReadonlyArray<{ name: string; description?: string }> } | undefined
      const root = agents?.roots()[0]
      return ok(root === undefined ? [] : (commands?.list(root) ?? []).map(command => ({ name: command.name, description: command.description ?? '', template: '' })))
    }
    if (method === 'GET' && path === '/file/content') {
      const file = resolve(directory, url.searchParams.get('path') ?? '')
      return ok({ type: 'text', content: readFileSync(file, 'utf8') })
    }
    if (method === 'POST' && path === '/log') {
      const level = String(body['level'] ?? 'info')
      this.core.ctx.logger[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'](`[opencode:${String(body['service'] ?? 'plugin')}] ${String(body['message'] ?? '')}`)
      return ok(true)
    }
    if (method === 'POST' && path === '/tui/show-toast') {
      const root = agents?.roots().at(-1)
      const text = `${typeof body['title'] === 'string' ? `${body['title']}: ` : ''}${String(body['message'] ?? '')}`
      if (root !== undefined) appendNotice(root.session, { kind: 'system-message', event: 'tui.toast', plugin: 'opencode', text })
      this.core.emit({ type: 'tui.toast.show', properties: body })
      return ok(true)
    }
    if (method === 'POST' && path === '/tui/append-prompt') {
      this.tui.prompt += String(body['text'] ?? '')
      this.core.emit({ type: 'tui.prompt.append', properties: { text: String(body['text'] ?? '') } })
      return ok(true)
    }
    if (method === 'POST' && path === '/tui/clear-prompt') {
      this.tui.prompt = ''
      return ok(true)
    }
    if (method === 'POST' && path === '/tui/submit-prompt') {
      const root = agents?.roots().at(-1)
      if (root !== undefined && this.tui.prompt.length > 0) root.followup(createUserMessage({ content: [{ type: 'text', text: this.tui.prompt }], source: { kind: 'user' } }))
      this.tui.prompt = ''
      return ok(true)
    }
    if (method === 'POST' && path === '/tui/execute-command') {
      const root = agents?.roots().at(-1)
      const commands = dshService(this.core.ctx, 'commands') as { execute(agent: unknown, line: string, attachments: unknown[], signal: AbortSignal): Promise<unknown> } | undefined
      if (root !== undefined) await commands?.execute(root, `/${String(body['command'] ?? '').replace(/^\//u, '')}`, [], new AbortController().signal)
      return ok(true)
    }
    return undefined
  }

  private projectView(directory: string): Record<string, unknown> {
    const project = this.core.projectOf(directory)
    return { id: project.id, worktree: project.worktree, vcs: 'git', time: { created: project.created } }
  }

  /** `session.prompt`: a message into the session; with a reply, the assistant's last message once the turn ends. */
  private async prompt(agent: Agent, body: Record<string, unknown>, wait: boolean): Promise<unknown> {
    const sessionId = agent.session.header.id
    const parts = Array.isArray(body['parts']) ? body['parts'].filter(isRecord) : []
    const content = parts.flatMap(part => (part['type'] === 'text' ? [{ type: 'text' as const, text: String(part['text'] ?? '') }] : []))
    if (typeof body['system'] === 'string' && body['system'].length > 0) content.unshift({ type: 'text', text: `<system>\n${body['system']}\n</system>` })
    const plugin = 'opencode'
    const message = createUserMessage({ content, source: body['noReply'] === true ? { kind: PLUGIN_SOURCE, plugin } : { kind: 'user' } } as never) as unknown as Message
    if (body['noReply'] === true) {
      const admitting = this.core.admitting.get(sessionId)
      if (admitting !== undefined) admitting.push(message)
      else agent.inject(message)
      const facts = this.core.facts(agent)
      return { info: userInfo(facts, message as unknown as Record<string, unknown>, Date.now()), parts: userParts(sessionId, message as unknown as Record<string, unknown>) }
    }
    const before = agent.session.seq
    agent.followup(message)
    if (!wait) return undefined
    await this.turnEnded(agent, before)
    return this.lastAssistant(agent)
  }

  /** Resolve once a turn that began after `seq` has ended. */
  private async turnEnded(agent: Agent, seq: number): Promise<void> {
    for (let attempt = 0; attempt < 6000; attempt++) {
      for (let at = seq; at < agent.session.seq; at++) if (agent.session.eventAt(at)?.type === 'turn/end') return
      await agent.whenIdle()
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  private lastAssistant(agent: Agent): MessageWithParts | Record<string, never> {
    const messages = messagesOf(this.core.facts(agent), this.core.events(agent))
    return [...messages].reverse().find(message => message.info['role'] === 'assistant') ?? {}
  }

  /** `session.create`: a new root session on the default model, in the plugin's directory. */
  private async createSession(body: Record<string, unknown>, directory: string): Promise<unknown> {
    const agents = this.core.agents()
    if (agents === undefined) throw new Error('DSH has no agent registry')
    const selection = this.core.defaultModel()
    if (selection === undefined) throw new Error('DSH has no model selected')
    const sessionId = `session-${randomUUID().replaceAll('-', '')}`
    const handle = await agents.create({ sessionId, meta: { cwd: directory }, agentOptions: { provider: selection.provider, model: selection.model } })
    const parentId = typeof body['parentID'] === 'string' ? body['parentID'] : undefined
    this.core.created.set(sessionId, { dispose: () => handle.dispose(), ...(parentId !== undefined ? { parentId } : {}) })
    if (typeof body['title'] === 'string') {
      const titles = dshService(this.core.ctx, 'sessionTitle') as { rename(session: unknown, title: string): unknown } | undefined
      try {
        titles?.rename(handle.agent.session, body['title'])
      } catch {
        // An untitled session is still a session.
      }
    }
    return sessionInfo(this.core.facts(handle.agent))
  }

  private async deleteSession(sessionId: string): Promise<boolean> {
    const owned = this.core.created.get(sessionId)
    if (owned === undefined) throw new Error(`Session ${sessionId} was not created by a plugin; DSH keeps the sessions a person opened`)
    const agent = this.core.agents()?.get(sessionId)
    const info = agent === undefined ? { id: sessionId } : sessionInfo(this.core.facts(agent))
    this.core.created.delete(sessionId)
    await owned.dispose()
    this.core.emit({ type: 'session.deleted', properties: { info } })
    return true
  }
}

/** A route's template, for evidence: ids become `{id}`. */
function templateOf(path: string): string {
  return path.replace(/^\/session\/[^/]+/u, '/session/{id}').replace(/\/message\/[^/]+$/u, '/message/{messageID}')
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (status === 204 || body === undefined) {
    res.writeHead(status === 200 ? 204 : status)
    res.end()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
