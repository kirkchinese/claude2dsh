/**
 * Core of the mods engine inside a DSH session: what Claude Code itself does
 * at each event a mod's `$` call or a DSH call site raises, served by the
 * composed DSH services and Harness Forge's runtime.
 * @module @kirkchinese/harness-forge/mods
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ForeignShell } from '../hooks/shell.js'
import { appendNotice } from '../hooks/notice.js'
import type { CoreContext } from './engine.js'
import { isRecord, jsonCopy, messageOf } from './values.js'
import { contextPressureOf, dshService, lastTurnOf, type DshService } from '../dsh/host.js'

/** The root agent of the session the engine serves. */
export interface SessionAgent {
  readonly id?: string
  readonly ctx?: unknown
  readonly options?: { readonly provider?: string; readonly model?: string }
  readonly session: {
    readonly id?: string
    readonly header: { readonly id: string; readonly cwd?: string; readonly createdAt?: number | string; readonly parentSession?: string }
    deriveMessages?(): ReadonlyArray<{ readonly role: string; readonly content: unknown }>
    requestHeader?(): { readonly config?: { readonly model?: string } } | undefined
  }
  inject(message: unknown): void
  followup(message: unknown): void
  cancel?(cause: { kind: string; reason?: string }, options?: { keepInbox?: boolean }): unknown
}

/** What the session host needs from Harness Forge. */
export interface SessionServices {
  readonly ctx: Context
  readonly shell: ForeignShell
  /** Where each plugin's `$.store` file lives. */
  readonly storeRoot: string
  directory(agent: unknown, signal: AbortSignal): Promise<string>
  /** Claude settings merged for the session, or one source's. */
  settings(source: string | undefined): Record<string, unknown>
  /** A line a mod shows (transcript, debug, toast, status). */
  show(kind: 'transcript' | 'debug' | 'toast' | 'status', plugin: string, text: string | undefined): void
  /** A pane a mod opened or closed; the client draws it. */
  pane(plugin: string, action: 'open' | 'close', args: Record<string, unknown>): { isPlaced: boolean; reason?: string }
  /** The open panes. */
  panes(): unknown[]
  /** Register a slash command for the session; returns the withdrawal. */
  registerCommand(plugin: string, spec: Record<string, unknown>): () => void
  /** Redraw what a plugin drew. */
  invalidate(plugin: string): void
}

const STORE_MAX_BYTES = 4 * 1024 * 1024
const FILE_MAX_BYTES = 4 * 1024 * 1024
const OUTPUT_MAX_BYTES = 4 * 1024 * 1024

interface ToolRuntimeLike {
  execute(call: Record<string, unknown>): Promise<{ isError: boolean; value?: unknown; content?: unknown; error?: { message?: string } }>
  schemas(scope?: unknown): ReadonlyArray<{ readonly name: string; readonly description?: string }>
  register(definition: unknown): () => void
}

interface CommandsLike {
  execute(agent: unknown, line: string, attachments: unknown[], signal: AbortSignal): Promise<{ result: { kind: string; text?: string } } | undefined>
  list(agent: unknown): ReadonlyArray<{ readonly name: string; readonly description?: string }>
}

/** The core of one session's mods engine. */
export class SessionHost {
  /** Withdrawals of what the session's mods registered. */
  readonly registrations: Array<() => void> = []
  private readonly stores = new Map<string, Record<string, unknown>>()

  constructor(private readonly services: SessionServices, readonly agent: SessionAgent, readonly interactive: boolean) {}

  private get ctx(): Context {
    return this.services.ctx
  }

  /** Core at an op event: `{ value }` or `{ deny }`. */
  async op(event: string, e: Record<string, unknown>, context: CoreContext): Promise<unknown> {
    const plugin = context.mod?.ref.name ?? context.origin.plugin
    try {
      const value = await this.serve(event, e, plugin, context)
      return { value }
    } catch (error: unknown) {
      return { deny: messageOf(error) }
    }
  }

  private async cwd(signal: AbortSignal): Promise<string> {
    return this.services.directory(this.agent, signal).catch(() => this.agent.session.header.cwd ?? process.cwd())
  }

  private async path(path: unknown, signal: AbortSignal): Promise<string> {
    if (typeof path !== 'string' || path.length === 0) throw new Error('takes a path')
    return isAbsolute(path) ? path : resolve(await this.cwd(signal), path)
  }

  private async serve(event: string, e: Record<string, unknown>, plugin: string, context: CoreContext): Promise<unknown> {
    const signal = context.signal
    switch (event) {
      // ---- session facts -----------------------------------------------------
      case 'session.id': return this.agent.session.header.id
      case 'session.cwd': return this.cwd(signal)
      case 'session.root': return this.agent.session.header.cwd ?? this.cwd(signal)
      case 'session.model': return this.agent.session.requestHeader?.()?.config?.model ?? this.agent.options?.model ?? ''
      case 'session.turns': return this.turns()
      case 'session.messages': return this.messages()
      case 'session.surfaces': return this.interactive ? ['desktop'] : []
      case 'session.surface': return this.interactive ? 'desktop' : 'terminal'
      case 'session.usage': return this.usage()
      case 'session.version': return { version: 'harness-forge/dsh', base: '2.1.277' }
      case 'session.repo': return this.repo(signal)
      case 'session.identity': return this.identity()
      case 'session.authorize': return null
      // ---- files -------------------------------------------------------------
      case 'fs.read': {
        const path = await this.path(e['path'], signal)
        if (statSync(path).size > FILE_MAX_BYTES) throw new Error(`${path} is over the 4194304-byte limit`)
        return e['as'] === 'bytes' ? { base64: readFileSync(path).toString('base64') } : readFileSync(path, 'utf8')
      }
      case 'fs.write': {
        const path = await this.path(e['path'], signal)
        const text = String(e['text'] ?? '')
        if (Buffer.byteLength(text) > FILE_MAX_BYTES) throw new Error('the text is over the 4194304-byte limit')
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, text)
        return undefined
      }
      case 'fs.list': {
        const path = await this.path(e['path'] ?? '.', signal)
        return readdirSync(path, { withFileTypes: true }).map((entry) => {
          const full = join(path, entry.name)
          const link = entry.isSymbolicLink()
          let size = 0
          try { size = statSync(full).size } catch { size = 0 }
          return { name: entry.name, kind: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : link ? statKind(full) : 'other', size, isLink: link }
        }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      }
      case 'fs.exists': return existsSync(await this.path(e['path'], signal))
      case 'fs.stat': {
        const path = await this.path(e['path'], signal)
        const own = lstatSync(path)
        const link = own.isSymbolicLink()
        const info = link ? statSync(path) : own
        return {
          kind: info.isDirectory() ? 'dir' : info.isFile() ? 'file' : 'other',
          size: info.size,
          mtimeMs: info.mtimeMs,
          isLink: link,
          ...(e['resolve'] === true ? { realPath: realpathSync(path) } : {}),
        }
      }
      case 'fs.ancestors': return this.ancestors(e, signal)
      // ---- store ------------------------------------------------------------
      case 'store.get': return this.store(plugin)[String(e['key'])]
      case 'store.set': {
        const store = { ...this.store(plugin), [String(e['key'])]: jsonCopy(e['value']) }
        this.saveStore(plugin, store)
        return undefined
      }
      case 'store.delete': {
        const store = { ...this.store(plugin) }
        delete store[String(e['key'])]
        this.saveStore(plugin, store)
        return undefined
      }
      case 'store.keys': return Object.keys(this.store(plugin))
      // ---- time --------------------------------------------------------------
      case 'clock.now': return Date.now()
      case 'clock.sleep':
      case 'clock.after':
      case 'clock.every':
        await sleep(Number(e['ms']) || 0, signal)
        return undefined
      // ---- processes, network, environment, settings -------------------------
      case 'process.run': return this.run(e, signal)
      case 'http.fetch': return this.fetch(e, signal)
      case 'env.get': return process.env[String(e['name'])]
      case 'env.set': {
        const name = String(e['name'])
        if (typeof e['value'] === 'string') process.env[name] = e['value']
        else delete process.env[name]
        return undefined
      }
      case 'settings.read': return this.services.settings(typeof e['source'] === 'string' ? e['source'] : undefined)
      // ---- display -----------------------------------------------------------
      case 'ui.log': this.services.show(e['to'] === 'debug' ? 'debug' : 'transcript', plugin, String(e['text'] ?? '')); return undefined
      case 'ui.toast': this.services.show('toast', plugin, String(e['text'] ?? '')); return undefined
      case 'ui.status': this.services.show('status', plugin, typeof e['text'] === 'string' ? e['text'] : undefined); return undefined
      case 'ui.notice': return undefined
      case 'ui.invalidate': this.services.invalidate(plugin); return undefined
      case 'ui.open': return this.services.pane(plugin, 'open', e)
      case 'ui.close': this.services.pane(plugin, 'close', e); return undefined
      case 'ui.panes': return this.services.panes()
      case 'ui.copy': return { isCopied: false, reason: 'no-clipboard: the copy reaches the client when it draws the button' }
      case 'ui.notify': return { isSent: false, channel: 'none' }
      // ---- commands and tools ------------------------------------------------
      case 'command.register': {
        const withdraw = this.services.registerCommand(plugin, e)
        this.registrations.push(withdraw)
        return { command: String(e['name']) }
      }
      case 'command.list': {
        const commands = this.scoped<CommandsLike>('commands')
        return (commands?.list(this.agent) ?? []).map(command => ({ name: command.name, description: command.description ?? '', source: 'builtin' }))
      }
      case 'tool.register': return this.registerTool(plugin, e)
      case 'tool.list': {
        const tools = this.scoped<ToolRuntimeLike>('tools')
        return (tools?.schemas(this.agent) ?? []).map(tool => ({ name: tool.name, description: tool.description ?? '', mcp: tool.name.startsWith('mcp__') }))
      }
      case 'model.complete': return this.complete(e, signal)
      case 'model.classify': return this.classify(e, signal)
      case 'agent.list': return []
      case 'mcp.call': {
        const tools = this.scoped<ToolRuntimeLike>('tools')
        if (tools === undefined) throw new Error('no tool runtime')
        const result = await tools.execute({ callId: `mod-mcp-${crypto.randomUUID()}`, name: `mcp__${String(e['server'])}__${String(e['tool'])}`, arguments: e['args'] ?? {}, agent: this.agent, signal })
        return { content: result.content ?? [], isError: result.isError }
      }
      case 'telemetry.log':
      case 'telemetry.mark':
        // Claude Code's collector is first-party analytics; DSH has none to send to.
        return undefined
      // A plugin stopping the turn is a hook's cancel; what the person queued stays.
      case 'turn.abort': this.agent.cancel?.({ kind: 'hook', reason: 'a plugin aborted the turn' }, { keepInbox: true }); return undefined
      case 'prompt.read': return { text: '', cursor: 0 }
      default:
        throw new Error(`${event} is not served by this host`)
    }
  }

  /**
   * The account the session is signed in as: DSH's DeepSeek account where one
   * is signed in (its contact, when an email address), as Claude Code answers
   * with its own login; an API-key or keyless session has none.
   */
  private async identity(): Promise<Record<string, unknown>> {
    const account = dshService(this.ctx, 'deepseekAccount') as {
      getProfile(client: { version: string; locale: string; timezoneOffsetSeconds: number }): Promise<{ status: string; value?: { contact?: string | null } } | null>
    } | undefined
    if (account === undefined) return { kind: 'none', isVerified: false }
    const profile = await account.getProfile({ version: 'harness-forge', locale: Intl.DateTimeFormat().resolvedOptions().locale, timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 }).catch(() => null)
    if (profile?.status !== 'ready') return { kind: 'none', isVerified: false }
    const contact = profile.value?.contact ?? undefined
    return { kind: 'deepseek', isVerified: true, ...(typeof contact === 'string' && contact.includes('@') ? { email: contact } : {}) }
  }

  private scoped<T>(service: DshService): T | undefined {
    const agentCtx = this.agent.ctx as { get?(name: string): unknown } | undefined
    return (dshService(agentCtx, service) ?? dshService(this.ctx, service)) as T | undefined
  }

  private turns(): number {
    return lastTurnOf(this.ctx, this.agent.session) ?? 0
  }

  private messages(): unknown[] {
    const rows = this.agent.session.deriveMessages?.() ?? []
    return rows.slice(-4096).map((row) => {
      const blocks = Array.isArray(row.content) ? row.content as Array<Record<string, unknown>> : []
      return {
        role: row.role === 'assistant' ? 'assistant' : 'user',
        text: blocks.filter(block => block['type'] === 'text').map(block => String(block['text'] ?? '')).join(''),
        toolUses: blocks.filter(block => block['type'] === 'tool-call' || block['type'] === 'tool_use').map(block => ({ name: String(block['name'] ?? block['toolName'] ?? ''), input: block['arguments'] ?? block['input'] ?? {} })),
      }
    })
  }

  private usage(): Record<string, unknown> {
    const created = this.agent.session.header.createdAt
    const startedAt = typeof created === 'number' ? created : typeof created === 'string' ? Date.parse(created) : Date.now()
    const pressure = contextPressureOf(this.ctx, this.agent.session)
    const tokens = pressure?.pressureTokens
    const window = pressure?.contextWindow ?? 0
    return {
      startedAt,
      context: { ...(tokens !== undefined ? { tokens } : {}), window, ...(tokens !== undefined && window > 0 ? { percent: Math.round(tokens / window * 100) } : {}) },
      rateLimits: [],
    }
  }

  private async repo(signal: AbortSignal): Promise<unknown> {
    const cwd = await this.cwd(signal)
    const top = await this.services.shell.runExec('git', ['rev-parse', '--show-toplevel'], { cwd, signal })
    if (top.exitCode !== 0) return null
    const root = top.stdout.trim()
    const remote = await this.services.shell.runExec('git', ['remote', 'get-url', 'origin'], { cwd: root, signal })
    const branch = await this.services.shell.runExec('git', ['branch', '--show-current'], { cwd: root, signal })
    return {
      root,
      ...(remote.exitCode === 0 && remote.stdout.trim().length > 0 ? { remote: remote.stdout.trim() } : {}),
      ...(branch.exitCode === 0 && branch.stdout.trim().length > 0 ? { branch: branch.stdout.trim() } : {}),
    }
  }

  /** `$.fs.ancestors`: the named instruction files from the root down to `of`, with their `@` imports. */
  private async ancestors(e: Record<string, unknown>, signal: AbortSignal): Promise<unknown[]> {
    const names = Array.isArray(e['names']) ? e['names'].filter((name): name is string => typeof name === 'string') : []
    const target = typeof e['of'] === 'string' ? dirname(await this.path(e['of'], signal)) : await this.cwd(signal)
    const below = typeof e['below'] === 'string' ? await this.path(e['below'], signal) : undefined
    const dirs: string[] = []
    let current = resolve(target)
    for (;;) {
      dirs.unshift(current)
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
    const within = (dir: string): boolean => (below === undefined ? true : dir !== below && (dir + sep).startsWith(below + sep))
    const out: unknown[] = []
    for (const dir of dirs.filter(within)) {
      for (const name of names) {
        const path = join(dir, name)
        if (!existsSync(path) || !statSync(path).isFile()) continue
        const content = readFileSync(path, 'utf8')
        out.push({ dir, name, content, parts: [{ path, content }] })
      }
    }
    return out
  }

  private store(plugin: string): Record<string, unknown> {
    const cached = this.stores.get(plugin)
    if (cached !== undefined) return cached
    const path = join(this.services.storeRoot, `${plugin}.json`)
    let value: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
      if (isRecord(parsed)) value = parsed
    } catch {
      value = {}
    }
    this.stores.set(plugin, value)
    return value
  }

  private saveStore(plugin: string, value: Record<string, unknown>): void {
    const text = JSON.stringify(value)
    if (Buffer.byteLength(text) > STORE_MAX_BYTES) throw new Error(`${plugin}'s store would be over 4 MiB of JSON`)
    mkdirSync(this.services.storeRoot, { recursive: true })
    writeFileSync(join(this.services.storeRoot, `${plugin}.json`), text)
    this.stores.set(plugin, value)
  }

  private async run(e: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const argv = Array.isArray(e['argv']) ? e['argv'].map(String) : []
    if (argv.length === 0) throw new Error('takes an argv of at least the command')
    const init = isRecord(e['init']) ? e['init'] : {}
    const timeoutMs = Math.min(600_000, typeof init['timeoutMs'] === 'number' ? init['timeoutMs'] : 30_000)
    const cwd = typeof init['cwd'] === 'string' ? await this.path(init['cwd'], signal) : await this.cwd(signal)
    const env = isRecord(init['env']) ? Object.fromEntries(Object.entries(init['env']).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : undefined
    const outcome = await this.services.shell.runExec(argv[0]!, argv.slice(1), {
      cwd,
      timeoutMs,
      signal,
      ...(env !== undefined ? { env } : {}),
      ...(typeof init['stdin'] === 'string' ? { stdin: init['stdin'] } : {}),
    })
    if (outcome.startError !== undefined) throw new Error(`${argv[0]!} did not start: ${outcome.startError}`)
    if (outcome.timedOut) throw new Error(`${argv[0]!} was still running after ${String(timeoutMs)} ms`)
    const stdout = outcome.stdout.length > OUTPUT_MAX_BYTES ? outcome.stdout.slice(0, OUTPUT_MAX_BYTES) : outcome.stdout
    const stderr = outcome.stderr.length > OUTPUT_MAX_BYTES ? outcome.stderr.slice(0, OUTPUT_MAX_BYTES) : outcome.stderr
    return {
      exitCode: outcome.exitCode ?? -1,
      stdout,
      stderr,
      ...(stdout.length < outcome.stdout.length ? { isStdoutTruncated: true } : {}),
      ...(stderr.length < outcome.stderr.length ? { isStderrTruncated: true } : {}),
    }
  }

  private async fetch(e: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const url = String(e['url'])
    const init = isRecord(e['init']) ? e['init'] : {}
    const headers = isRecord(init['headers']) ? Object.fromEntries(Object.entries(init['headers']).map(([key, value]) => [key, String(value)])) : {}
    const response = await fetch(url, {
      method: typeof init['method'] === 'string' ? init['method'] : 'GET',
      headers,
      ...(typeof init['body'] === 'string' ? { body: init['body'] } : {}),
      redirect: 'follow',
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    })
    const text = (await response.text()).slice(0, 4 * 1024 * 1024)
    return { status: response.status, ok: response.ok, headers: Object.fromEntries(response.headers.entries()), text }
  }

  private registerTool(plugin: string, e: Record<string, unknown>): unknown {
    const tools = dshService(this.ctx, 'tools') as ToolRuntimeLike | undefined
    if (tools === undefined) throw new Error('no tool runtime')
    const name = String(e['name'])
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(name)) throw new Error('tool names are letters, digits, "_" and "-", up to 64 characters')
    const full = `mcp__${plugin}__${name}`
    const withdraw = tools.register({
      name: full,
      description: String(e['description'] ?? ''),
      parameters: isRecord(e['inputSchema']) ? e['inputSchema'] : { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }] },
      execute: () => Promise.reject(new Error(`${plugin} registered ${full} but no tool.call hook answered it`)),
    })
    this.registrations.push(withdraw)
    return { tool: full }
  }

  private async complete(e: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const llm = dshService(this.ctx, 'llm') as {
      prepareCall(route: { provider: string; model: string; maxTokens: number }, signal: AbortSignal): Promise<{ stream(options: Record<string, unknown>): AsyncIterable<unknown> }>
    } | undefined
    if (llm === undefined) throw new Error('no model is composed')
    const provider = this.agent.options?.provider
    const model = this.agent.options?.model
    if (provider === undefined || model === undefined) throw new Error('the session names no model')
    const call = await llm.prepareCall({ provider, model, maxTokens: typeof e['maxTokens'] === 'number' ? e['maxTokens'] : 1024 }, signal)
    let text = ''
    for await (const chunk of call.stream({
      ...(typeof e['system'] === 'string' ? { system: e['system'] } : {}),
      messages: [createUserMessage({ content: [{ type: 'text', text: String(e['prompt'] ?? '') }], source: { kind: 'user' } })],
      signal,
    })) {
      if (isRecord(chunk) && chunk['type'] === 'text-delta' && typeof chunk['delta'] === 'string') text += chunk['delta']
      if (isRecord(chunk) && chunk['type'] === 'text' && typeof chunk['text'] === 'string') text += chunk['text']
    }
    return { isAnswered: true, text, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
  }

  private async classify(e: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const labels = Array.isArray(e['labels']) ? e['labels'].map(String) : []
    const answer = await this.complete({ prompt: `${String(e['text'] ?? '')}\n\nAnswer with exactly one of: ${labels.join(', ')}`, maxTokens: 32 }, signal) as { text: string }
    return labels.find(label => answer.text.toLowerCase().includes(label.toLowerCase())) ?? labels[0] ?? ''
  }

  /** Run a slash command line in the session (`$.command.run`). */
  async runCommand(command: string, args: string, signal: AbortSignal): Promise<{ text?: string }> {
    const commands = this.scoped<CommandsLike>('commands')
    if (commands === undefined) throw new Error('no command registry')
    const line = args.length > 0 ? `/${command} ${args}` : `/${command}`
    const execution = await commands.execute(this.agent, line, [], signal)
    if (execution === undefined) throw new Error(`/${command} is not a command`)
    if (execution.result.kind === 'error') throw new Error(execution.result.text ?? `/${command} failed`)
    return execution.result.text === undefined ? {} : { text: execution.result.text }
  }

  /** A note a plugin appends (`$.session.append`): kept in the conversation. */
  appendNote(plugin: string, e: Record<string, unknown>): unknown {
    const message = isRecord(e['message']) ? e['message'] : {}
    const content = Array.isArray(message['content']) ? message['content'] : []
    const text = content.filter(isRecord).map(block => String(block['text'] ?? '')).join('\n')
    if (message['type'] === 'system') {
      appendNotice(this.agent.session, { kind: 'system-message', event: 'session.append', plugin, text })
    } else {
      this.agent.inject(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    }
    return { message, uuid: e['uuid'] }
  }

  /** Relative path a mod sees for a file, from the session's root. */
  relativePath(path: string): string {
    return relative(this.agent.session.header.cwd ?? process.cwd(), path)
  }
}

function statKind(path: string): 'file' | 'dir' | 'other' {
  try {
    const info = statSync(path)
    return info.isDirectory() ? 'dir' : info.isFile() ? 'file' : 'other'
  } catch {
    return 'other'
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveSleep, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolveSleep()
    }, Math.max(0, ms))
    const abort = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}
