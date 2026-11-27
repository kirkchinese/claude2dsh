/**
 * The OpenCode runtime's DSH-event mapping.
 * @module @kirkchinese/harness-forge/opencode
 */
import { randomUUID } from 'node:crypto'
import { appendNotice } from '../../hooks/notice.js'
import {
  dshArgs,
  isRecord,
  messagesOf,
  openCodeArgs,
  openCodeToolName,
  permissionType,
  sessionInfo,
  toolPart,
  userInfo,
  userParts,
  type LoggedEvent,
} from '../convert.js'
import type { OpenCodeCore } from './core.js'
import type { Agent, Message, ToolExec } from './types.js'

/**
 * DSH's events raised as OpenCode hooks and events: session events,
 * `chat.message`, `chat.params`, `tool.execute.before` / `.after`,
 * `permission.ask`, the prompt and tool transforms, `shell.env` and
 * `command.execute.before`.
 */
export class EventBridge {
  /** Calls whose arguments the `tool.execute.before` hooks saw, by call id. */
  private readonly calls = new Map<string, { name: string; args: Record<string, unknown>; sessionId: string }>()

  constructor(private readonly core: OpenCodeCore) {}

  sessionCreated(agent: Agent): void {
    if (this.core.hosts.size === 0) return
    const info = sessionInfo(this.core.facts(agent))
    this.core.emit({ type: 'session.created', properties: { info } })
    this.core.emit({ type: 'session.updated', properties: { info } })
  }

  /** The session log, as OpenCode's events. */
  sessionEvent(sessionId: string, event: LoggedEvent): void {
    if (this.core.hosts.size === 0) return
    const agent = this.core.agents()?.get(sessionId)
    if (agent === undefined) return
    const facts = this.core.facts(agent)
    const data = isRecord(event.data) ? event.data : {}
    switch (event.type) {
      case 'user/message': {
        const info = userInfo(facts, data, event.time)
        this.core.emit({ type: 'message.updated', properties: { info } })
        for (const part of userParts(sessionId, data)) this.core.emit({ type: 'message.part.updated', properties: { part } })
        return
      }
      case 'assistant/message': {
        const [message] = messagesOf(facts, [event])
        if (message === undefined) return
        this.core.emit({ type: 'message.updated', properties: { info: message.info } })
        for (const part of message.parts) this.core.emit({ type: 'message.part.updated', properties: { part } })
        return
      }
      case 'tool/call': {
        const part = toolPart({ id: `prt_${String(data['callId'])}`, sessionID: sessionId, messageID: `msg_${String(data['turn'])}_${String(data['step'])}` }, { id: data['callId'], name: data['name'], arguments: data['arguments'] }, undefined, facts.cwd, event.time)
        this.core.emit({ type: 'message.part.updated', properties: { part } })
        return
      }
      case 'turn/start':
        this.core.emit({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'busy' } } })
        return
      case 'turn/end':
        // DSH's turn/end reason is { kind: 'error', error: { message, … } } for a failed turn.
        if (isFailure(data['reason'])) this.core.emit({ type: 'session.error', properties: { sessionID: sessionId, error: { name: 'UnknownError', data: { message: failureMessage(data['reason']) } } } })
        this.core.emit({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'idle' } } })
        this.core.emit({ type: 'session.idle', properties: { sessionID: sessionId } })
        this.core.emit({ type: 'session.updated', properties: { info: sessionInfo(facts) } })
        return
      case 'command/done':
        this.core.emit({ type: 'command.executed', properties: { name: String(data['name'] ?? ''), sessionID: sessionId, arguments: String(data['args'] ?? ''), messageID: '' } })
        return
      case 'compaction/end':
        if (data['error'] === undefined) this.core.emit({ type: 'session.compacted', properties: { sessionID: sessionId } })
        return
      default:
    }
  }

  /**
   * `chat.message` for each prompt about to enter: the plugin sees the
   * message and its parts before the session holds it, may change or add
   * parts, and the prompts it sends meanwhile (`noReply`) enter before it.
   */
  async preStep(payload: { agent: Agent; messages: Message[]; signal: AbortSignal }, next: () => Promise<{ kind: string; messages?: Message[] }>): Promise<unknown> {
    const prompts = payload.messages.filter(message => message.source?.kind === 'user')
    if (prompts.length === 0 || !this.core.has('chat.message')) return next()
    const sessionId = payload.agent.session.header.id
    const facts = this.core.facts(payload.agent)
    const replaced = new Map<Message, { before: Message[]; message: Message }>()
    for (const message of prompts) {
      this.core.admitting.set(sessionId, [])
      const info = userInfo(facts, message as unknown as Record<string, unknown>, Date.now())
      const parts = userParts(sessionId, message as unknown as Record<string, unknown>)
      const { output, error, faults } = await this.core.trigger('chat.message', {
        sessionID: sessionId,
        agent: facts.agent,
        model: { providerID: facts.provider, modelID: facts.model },
        messageID: info['id'],
      }, { message: info, parts })
      for (const text of [...(error === undefined ? [] : [error]), ...faults]) appendNotice(payload.agent.session, { kind: 'hook-error', event: 'chat.message', plugin: 'opencode', text })
      const before = this.core.admitting.get(sessionId) ?? []
      this.core.admitting.delete(sessionId)
      const after = Array.isArray(output['parts']) ? output['parts'].filter(isRecord) : parts
      const changed = JSON.stringify(after) !== JSON.stringify(parts)
      replaced.set(message, { before, message: changed ? withParts(message, after) : message })
    }
    const decision = await next()
    if (decision.kind !== 'enter' || decision.messages === undefined) {
      // A prompt that does not enter leaves what the plugin added waiting for the next one.
      for (const { before } of replaced.values()) for (const message of before) payload.agent.inject(message)
      return decision
    }
    const messages: Message[] = []
    for (const message of decision.messages) {
      const entry = replaced.get(message)
      if (entry === undefined) {
        messages.push(message)
        continue
      }
      messages.push(...entry.before, entry.message)
    }
    return { ...decision, messages }
  }

  /** `chat.params`: the temperature and output tokens a plugin sets reach the request. */
  async request(payload: { agent: Agent }, next: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const config = await next()
    if (!this.core.has('chat.params')) return config
    const facts = this.core.facts(payload.agent)
    const before = {
      temperature: typeof config['temperature'] === 'number' ? config['temperature'] : 0,
      topP: 1,
      topK: 0,
      maxOutputTokens: typeof config['maxTokens'] === 'number' ? config['maxTokens'] : undefined,
      options: {},
    }
    const { output } = await this.core.trigger('chat.params', {
      sessionID: facts.id,
      agent: facts.agent,
      model: { id: facts.model, providerID: facts.provider, name: facts.model },
      provider: { source: 'config', info: { id: facts.provider, name: facts.provider, env: [], models: {} }, options: {} },
      message: userInfo(facts, { id: `msg_${facts.id}` }, Date.now()),
    }, { ...before })
    return {
      ...config,
      ...(output['temperature'] !== before.temperature && typeof output['temperature'] === 'number' ? { temperature: output['temperature'] } : {}),
      ...(output['maxOutputTokens'] !== before.maxOutputTokens && typeof output['maxOutputTokens'] === 'number' ? { maxTokens: output['maxOutputTokens'] } : {}),
    }
  }

  /** `tool.execute.before`: OpenCode's view of the call; a throw refuses it, changed arguments run. */
  async preExecute(exec: ToolExec, next: () => Promise<unknown>): Promise<unknown> {
    if (exec.callId === undefined || exec.agent === undefined || this.core.hosts.size === 0) return next()
    const cwd = await this.core.host.directory(exec.agent, exec.signal).catch(() => exec.agent?.session.header.cwd ?? process.cwd())
    const args = openCodeArgs(exec.name, exec.arguments, cwd)
    const sessionId = exec.agent.session.header.id
    this.calls.set(exec.callId, { name: exec.name, args, sessionId })
    if (!this.core.has('tool.execute.before')) return next()
    const { output, error } = await this.core.trigger('tool.execute.before', { tool: openCodeToolName(exec.name), sessionID: sessionId, callID: exec.callId }, { args: structuredClone(args) })
    if (error !== undefined) return { kind: 'deny', reason: error }
    const updated = isRecord(output['args']) ? output['args'] : args
    if (JSON.stringify(updated) !== JSON.stringify(args)) {
      this.calls.set(exec.callId, { name: exec.name, args: updated, sessionId })
      this.core.host.rewrite(exec.callId, dshArgs(exec.name, exec.arguments, updated))
    }
    return next()
  }

  /** `tool.execute.after`: the plugin may rewrite the output the model reads. */
  async postExecute(exec: ToolExec, result: { isError: boolean; content?: Array<{ type: string; text?: string }> }, next: () => Promise<{ kind: string; content?: unknown[] }>): Promise<unknown> {
    const decision = await next()
    const call = exec.callId === undefined ? undefined : this.calls.get(exec.callId)
    if (call === undefined || !this.core.has('tool.execute.after') || decision.kind !== 'accept') return decision
    const content = (decision.content ?? result.content ?? []) as Array<{ type: string; text?: string }>
    const text = content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
    const before = { title: openCodeToolName(exec.name), output: text, metadata: {} }
    const { output } = await this.core.trigger('tool.execute.after', { tool: openCodeToolName(exec.name), sessionID: call.sessionId, callID: exec.callId, args: call.args }, { ...before })
    if (typeof output['output'] === 'string' && output['output'] !== text) return { ...decision, content: [{ type: 'text', text: output['output'] }] }
    return decision
  }

  toolResult(exec: ToolExec, result: { isError: boolean }): void {
    const call = exec.callId === undefined ? undefined : this.calls.get(exec.callId)
    if (exec.callId !== undefined) this.calls.delete(exec.callId)
    if (call === undefined || result.isError) return
    const tool = openCodeToolName(exec.name)
    if ((tool === 'write' || tool === 'edit') && typeof call.args['filePath'] === 'string') {
      this.core.emit({ type: 'file.edited', properties: { file: call.args['filePath'] } })
    }
  }

  /** `permission.ask` before DSH asks the person: `allow` and `deny` answer for them. */
  async approval(request: { agent: Agent; toolName: string; callId?: string; reason?: string }, next: () => Promise<string>): Promise<string> {
    if (this.core.hosts.size === 0) return next()
    const sessionId = request.agent.session.header.id
    const call = request.callId === undefined ? undefined : this.calls.get(request.callId)
    const pattern = call === undefined ? undefined : call.args['command'] ?? call.args['filePath'] ?? call.args['url']
    const permission = {
      id: `per_${request.callId ?? randomUUID()}`,
      type: permissionType(request.toolName),
      ...(typeof pattern === 'string' ? { pattern } : {}),
      sessionID: sessionId,
      messageID: '',
      ...(request.callId !== undefined ? { callID: request.callId } : {}),
      title: request.reason ?? request.toolName,
      metadata: call?.args ?? {},
      time: { created: Date.now() },
    }
    this.core.emit({ type: 'permission.updated', properties: permission })
    const { output } = this.core.has('permission.ask') ? await this.core.trigger('permission.ask', permission, { status: 'ask' }) : { output: { status: 'ask' } }
    const outcome = output['status'] === 'allow' ? 'allowed-once' : output['status'] === 'deny' ? 'rejected' : await next()
    this.core.emit({ type: 'permission.replied', properties: { sessionID: sessionId, permissionID: permission.id, response: outcome === 'allowed-once' ? 'once' : 'reject' } })
    return outcome
  }

  /**
   * `experimental.chat.system.transform` on the assembled prompt. (`tool.definition` has no seam: DSH collects the
   * offered tools outside the assembly a listener sees.)
   */
  async assemble(next: () => Promise<{ sections: Array<{ name: string; text: string }> }>): Promise<unknown> {
    const assembly = await next()
    if (this.core.has('experimental.chat.system.transform')) {
      const system = assembly.sections.map(section => section.text)
      const { output } = await this.core.trigger('experimental.chat.system.transform', { model: {} }, { system: [...system] })
      const after = Array.isArray(output['system']) ? output['system'].map(String) : system
      const sections = assembly.sections.map((section, index) => (after[index] !== undefined && after[index] !== section.text ? { ...section, text: after[index] } : section))
      for (const [index, text] of after.slice(system.length).entries()) sections.push({ name: `opencode-system-${String(index)}`, text })
      assembly.sections = sections
    }
    return assembly
  }

  /** `shell.env`: the variables plugins add to a shell call's environment. */
  async shellEnv(exec: ToolExec): Promise<Record<string, string>> {
    if (!this.core.has('shell.env') || exec.agent === undefined) return {}
    const cwd = await this.core.host.directory(exec.agent, exec.signal).catch(() => process.cwd())
    const { output } = await this.core.trigger('shell.env', { cwd, sessionID: exec.agent.session.header.id, ...(exec.callId !== undefined ? { callID: exec.callId } : {}) }, { env: {} })
    const env = isRecord(output['env']) ? output['env'] : {}
    return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  }

  /**
   * `command.execute.before` for an OpenCode command about to be submitted:
   * the plugin sees the command and the parts of its prompt, and may change them.
   */
  async beforeCommand(agent: Agent, command: { name: string; args: string }, prompt: string): Promise<string[] | { stopped: string }> {
    if (!this.core.has('command.execute.before')) return [prompt]
    const sessionId = agent.session.header.id
    const parts = [{ id: `prt_${randomUUID()}`, sessionID: sessionId, messageID: '', type: 'text', text: prompt }]
    const { output, error } = await this.core.trigger('command.execute.before', { command: command.name, sessionID: sessionId, arguments: command.args }, { parts })
    // A plugin that throws has handled the command itself; its prompt is not sent.
    if (error !== undefined) return { stopped: error }
    const after = Array.isArray(output['parts']) ? output['parts'].filter(isRecord) : parts
    return after.filter(part => part['type'] === 'text').map(part => String(part['text'] ?? ''))
  }
}

/** A DSH message with its text replaced by OpenCode parts (non-text blocks kept). */
/** Whether a `turn/end` reason is a failed turn. */
function isFailure(reason: unknown): boolean {
  return typeof reason === 'object' && reason !== null && (reason as { kind?: unknown }).kind === 'error'
}

/** The message of a failed turn's reason. */
function failureMessage(reason: unknown): string {
  const message = (reason as { error?: { message?: unknown } }).error?.message
  return typeof message === 'string' && message.length > 0 ? message : 'the turn ended with an error'
}

function withParts(message: Message, parts: ReadonlyArray<Record<string, unknown>>): Message {
  const texts = parts.filter(part => part['type'] === 'text').map(part => ({ type: 'text', text: String(part['text'] ?? '') }))
  const others = message.content.filter(block => block['type'] !== 'text')
  return { ...message, content: [...texts, ...others] }
}
