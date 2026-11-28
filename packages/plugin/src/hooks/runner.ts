/**
 * Run one hook handler of any type and return its raw outcome:
 *
 * - `command`: exec form (`args`) spawns the executable directly with the
 *   placeholders substituted as plain strings; shell form runs in Git Bash
 *   (which expands `${CLAUDE_PLUGIN_ROOT}` and friends from the exported
 *   environment, defaults included) or in PowerShell, where the placeholders
 *   become `${env:NAME}`.
 * - `http`: POSTs the input as JSON; header values interpolate only the
 *   allowed environment variables.
 * - `mcp_tool`: calls a tool of a connected MCP server with `${path}` fields
 *   filled from the input; its text output is read like stdout.
 * - `prompt` / `agent`: a model call or a delegated agent that answers
 *   `{ ok, reason }`.
 * @module @kirkchinese/harness-forge
 */
import type { Context } from '@deepseek-ai/cordis'
import type { CommandHandler, HttpHandler, McpToolHandler, ModelHandler } from './config.js'
import type { McpToolCall, McpToolVerdict } from '../forge/contract.js'
import type { RawRun } from './output.js'
import type { ForeignShell } from './shell.js'
import type { HookDialect } from './vocabulary.js'
import { dshService } from '../dsh/host.js'
import { CATALOG_CALL_TOOL } from '../mcp/catalog.js'
import { publicToolName } from '../mcp/policy.js'
import { startActivation, type Activation } from '../dsh/subagents.js'
import { messageOf } from '../shared/util.js'

/** Paths and values a handler may reference. */
export interface HandlerPlaces {
  readonly pluginRoot: string
  readonly dataDir: string
  readonly projectDir: string
  readonly cwd: string
  /** Plugin user-config values, by key. */
  readonly options: Readonly<Record<string, string>>
  /** `CLAUDE_ENV_FILE`, for the events that receive it. */
  readonly envFile?: string
}

/** One run request. */
export interface HandlerRequest {
  readonly event: string
  readonly dialect: HookDialect
  readonly payload: Readonly<Record<string, unknown>>
  readonly places: HandlerPlaces
  /** Undefined runs without a timeout. */
  readonly timeoutMs?: number
  readonly signal: AbortSignal
  /** The agent the event belongs to, for prompt and agent handlers. */
  readonly agent?: unknown
}

/** A prompt or agent handler's verdict. */
export interface ModelVerdict {
  readonly ok: boolean
  readonly reason?: string
  readonly impossible?: boolean
}

/** A raw outcome, plus the verdict of a model-backed handler. */
export interface HandlerOutcome extends RawRun {
  readonly verdict?: ModelVerdict
  readonly durationMs: number
}

const PATH_PLACEHOLDERS = ['CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'PLUGIN_ROOT', 'PLUGIN_DATA'] as const

/** Executes handlers against the host. */
export class HandlerRunner {
  /**
   * @param settingsEnv - the `env` of the harness settings in effect for the
   *   event's agent, under the hook-specific variables.
   */
  /**
   * @param toolPolicy - the MCP row's tool policy (`McpApi.toolPolicy`), which an `mcp_tool` hook's call obeys as a
   *   model's call does; without the row no MCP tool is mounted, so nothing needs it.
   */
  constructor(
    private readonly ctx: Context,
    private readonly shell: ForeignShell,
    private readonly settingsEnv: (agent: unknown) => Readonly<Record<string, string>> = () => ({}),
    private readonly toolPolicy: (call: McpToolCall) => McpToolVerdict | undefined = () => undefined,
  ) {}

  /** The environment every command handler of a source receives. */
  environment(places: HandlerPlaces, kind: 'bash' | 'powershell' | 'exec', agent?: unknown): Record<string, string | undefined> {
    const posix = (value: string): string => value.replace(/\\/gu, '/')
    const env: Record<string, string | undefined> = {
      ...this.settingsEnv(agent),
      CLAUDE_PROJECT_DIR: posix(places.projectDir),
      CLAUDE_PLUGIN_ROOT: posix(places.pluginRoot),
      CLAUDE_PLUGIN_DATA: posix(places.dataDir),
      PLUGIN_ROOT: posix(places.pluginRoot),
      PLUGIN_DATA: posix(places.dataDir),
      CLAUDE_ENV_FILE: kind === 'powershell' ? undefined : places.envFile,
    }
    for (const [key, value] of Object.entries(places.options)) {
      env[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase().replace(/[^A-Z0-9]+/gu, '_')}`] = value
    }
    return env
  }

  /** Run a command handler. */
  async command(handler: CommandHandler, request: HandlerRequest): Promise<HandlerOutcome> {
    const { places } = request
    const stdin = `${JSON.stringify(request.payload)}${request.dialect === 'claude-code' ? '\n' : ''}`
    const base = { cwd: places.cwd, stdin, ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}), signal: request.signal }
    const command = process.platform === 'win32' && handler.commandWindows !== undefined ? handler.commandWindows : handler.command
    let outcome
    if (handler.args !== undefined) {
      const substitute = (value: string): string => substituteExec(value, places)
      outcome = await this.shell.runExec(substitute(command), handler.args.map(substitute), { ...base, env: this.environment(places, 'exec', request.agent) })
    } else {
      if (/\$\{user_config\./u.test(command)) {
        return { stdout: '', stderr: '', durationMs: 0, failure: { kind: 'start', message: 'a shell-form plugin hook command references ${user_config.*}; use CLAUDE_PLUGIN_OPTION_<KEY> or exec form' } }
      }
      const kind = handler.shell ?? this.shell.defaultKind
      const line = kind === 'powershell' ? powershellPlaceholders(command) : command
      outcome = await this.shell.runShell(line, kind, { ...base, env: this.environment(places, kind, request.agent) })
    }
    if (outcome.startError !== undefined) return { stdout: '', stderr: outcome.startError, durationMs: outcome.durationMs, failure: { kind: 'start', message: `failed to start: ${outcome.startError}` } }
    if (outcome.timedOut) return { stdout: outcome.stdout, stderr: outcome.stderr, durationMs: outcome.durationMs, failure: { kind: 'timeout', message: `timed out after ${String(request.timeoutMs)}ms` } }
    if (outcome.cancelled) return { stdout: '', stderr: '', durationMs: outcome.durationMs, failure: { kind: 'cancelled', message: 'cancelled' } }
    return {
      ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      suspectCapture: outcome.suspectCapture,
      durationMs: outcome.durationMs,
    }
  }

  /** Run an HTTP handler. */
  async http(handler: HttpHandler, request: HandlerRequest): Promise<HandlerOutcome> {
    const started = performance.now()
    const elapsed = (): number => Math.round(performance.now() - started)
    const allowed = new Set(handler.allowedEnvVars ?? [])
    const interpolate = (value: string): string => value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu, (_match, braced: string | undefined, bare: string | undefined) => {
      const name = braced ?? bare ?? ''
      return allowed.has(name) ? process.env[name] ?? '' : ''
    })
    const signals = [request.signal, ...(request.timeoutMs !== undefined ? [AbortSignal.timeout(request.timeoutMs)] : [])]
    try {
      const response = await fetch(handler.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...Object.fromEntries(Object.entries(handler.headers ?? {}).map(([key, value]) => [key, interpolate(value)])) },
        body: JSON.stringify(request.payload),
        signal: AbortSignal.any(signals),
      })
      const body = await response.text()
      if (!response.ok) return { stdout: '', stderr: body, durationMs: elapsed(), failure: { kind: 'transport', message: `HTTP ${String(response.status)} from ${handler.url}` } }
      const trimmed = body.trim()
      if (trimmed.length > 0 && !isJsonObject(trimmed)) {
        return { stdout: '', stderr: body, durationMs: elapsed(), failure: { kind: 'transport', message: 'the response body is neither empty nor a JSON object' } }
      }
      return { exitCode: 0, stdout: trimmed, stderr: '', durationMs: elapsed() }
    } catch (error: unknown) {
      if (request.signal.aborted) return { stdout: '', stderr: '', durationMs: elapsed(), failure: { kind: 'cancelled', message: 'cancelled' } }
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
      return { stdout: '', stderr: '', durationMs: elapsed(), failure: timedOut ? { kind: 'timeout', message: `timed out after ${String(request.timeoutMs)}ms` } : { kind: 'transport', message: `request to ${handler.url} failed: ${messageOf(error)}` } }
    }
  }

  /**
   * Run an MCP tool handler: the tool the MCP row mounted directly
   * (`mcp__<server>__<tool>`) or, for a server the capability catalog serves,
   * the catalog's `capability_call` with the entry `mcp:<server>/<tool>`.
   * Codex runs such a hook on an already-connected server only, so a server
   * that is neither is reported as not connected.
   * @param serverName - the server as registered (`McpApi.hookServer`); undefined when neither the hook's plugin nor
   *   the user's configuration has a mounted server of the name it gives.
   */
  async mcpTool(handler: McpToolHandler, request: HandlerRequest, serverName: string | undefined): Promise<HandlerOutcome> {
    if (serverName === undefined) {
      return { stdout: '', stderr: '', durationMs: 0, failure: { kind: 'transport', message: `MCP server "${handler.server}" is not a connected server of this plugin or of the user's configuration` } }
    }
    const started = performance.now()
    const elapsed = (): number => Math.round(performance.now() - started)
    const tools = dshService(this.ctx, 'tools') as {
      get(name: string): { execute(args: unknown, exec: unknown): Promise<unknown>; output: { render(args: unknown, value: unknown): Array<{ type: string; text?: string }> } } | undefined
    } | undefined
    const direct = publicToolName(serverName, handler.tool)
    const viaCatalog = tools?.get(direct) === undefined ? tools?.get(CATALOG_CALL_TOOL) : undefined
    const toolName = viaCatalog === undefined ? direct : CATALOG_CALL_TOOL
    const definition = viaCatalog ?? tools?.get(direct)
    if (definition === undefined) return { stdout: '', stderr: '', durationMs: 0, failure: { kind: 'transport', message: `MCP tool ${direct} is not connected` } }
    const input = fillTemplate(handler.input ?? {}, request.payload)
    const args = viaCatalog === undefined ? input : { id: `mcp:${serverName}/${handler.tool}`, arguments: input }
    // The server's own filters hold for a hook as for the model: Codex runs hooks only on "policy-allowed tools", and a
    // filtered tool is not registered there, so here it is not available. Codex invokes them "without model-tool
    // approval" (openai/codex#39296; https://developers.openai.com/codex/hooks, "MCP tool hooks": they "don't request
    // tool approval"), the hook itself having passed the trust review, so an approval mode does not stop it.
    const verdict = this.toolPolicy({ name: toolName, arguments: args, agent: request.agent })
    if (verdict?.kind === 'deny') return { stdout: '', stderr: '', durationMs: elapsed(), failure: { kind: 'transport', message: `MCP tool ${direct} is not available: ${verdict.reason}` } }
    const signal = request.timeoutMs === undefined ? request.signal : AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)])
    try {
      const value = await definition.execute(args, { name: toolName, arguments: args, callId: `hook-${Date.now().toString(36)}`, signal, agent: request.agent })
      const text = definition.output.render(args, value).map(block => block.text ?? '').join('')
      const isError = typeof value === 'object' && value !== null && (value as { isError?: unknown }).isError === true
      return isError
        ? { stdout: '', stderr: text, durationMs: elapsed(), failure: { kind: 'transport', message: `MCP tool ${direct} returned an error: ${text.slice(0, 300)}` } }
        : { exitCode: 0, stdout: text, stderr: '', durationMs: elapsed() }
    } catch (error: unknown) {
      if (request.signal.aborted) return { stdout: '', stderr: '', durationMs: elapsed(), failure: { kind: 'cancelled', message: 'cancelled' } }
      return { stdout: '', stderr: '', durationMs: elapsed(), failure: signal.aborted ? { kind: 'timeout', message: `timed out after ${String(request.timeoutMs)}ms` } : { kind: 'transport', message: messageOf(error) } }
    }
  }

  /** Run a prompt handler: one model call that answers `{ ok, reason, impossible }`. */
  async prompt(handler: ModelHandler, request: HandlerRequest): Promise<HandlerOutcome> {
    const started = performance.now()
    const elapsed = (): number => Math.round(performance.now() - started)
    const llm = dshService(this.ctx, 'llm') as LlmLike | undefined
    const options = (request.agent as { options?: { provider?: string; model?: string } } | undefined)?.options
    if (llm === undefined || options?.provider === undefined || options.model === undefined) {
      return { stdout: '', stderr: '', durationMs: 0, failure: { kind: 'start', message: 'no model route is available for prompt hooks in this session' } }
    }
    const signal = request.timeoutMs === undefined ? request.signal : AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)])
    try {
      const call = await llm.prepareCall({ provider: options.provider, model: options.model, maxTokens: 1024 }, signal)
      const chunks: string[] = []
      for await (const chunk of call.stream({
        ...call.config,
        messages: [{ role: 'user', content: [{ type: 'text', text: promptText(handler.prompt, request.payload) }], source: { kind: 'harness-forge', event: request.event } }],
        system: VERDICT_SYSTEM,
        purpose: 'hook-evaluation',
        signal,
      })) {
        const text = textDelta(chunk)
        if (text !== undefined) chunks.push(text)
      }
      return { exitCode: 0, stdout: '', stderr: '', durationMs: elapsed(), verdict: parseVerdict(chunks.join('')) }
    } catch (error: unknown) {
      if (request.signal.aborted) return { stdout: '', stderr: '', durationMs: elapsed(), failure: { kind: 'cancelled', message: 'cancelled' } }
      return { stdout: '', stderr: '', durationMs: elapsed(), failure: signal.aborted ? { kind: 'timeout', message: `timed out after ${String(request.timeoutMs)}ms` } : { kind: 'transport', message: `prompt hook model call failed: ${messageOf(error)}` } }
    }
  }

  /** Run an agent handler: a delegated agent with tool access that answers `{ ok, reason }`. */
  async agent(handler: ModelHandler, request: HandlerRequest): Promise<HandlerOutcome> {
    const started = performance.now()
    const elapsed = (): number => Math.round(performance.now() - started)
    const subagents = dshService(this.ctx, 'subagents')
    if (subagents === undefined || request.agent === undefined) {
      return { stdout: '', stderr: '', durationMs: 0, failure: { kind: 'start', message: 'agent hooks need the DSH subagent runtime' } }
    }
    const signal = request.timeoutMs === undefined ? request.signal : AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)])
    let activation: Activation | undefined
    try {
      activation = await startActivation(subagents, {
        parent: request.agent,
        prompt: [{ type: 'text', text: `${promptText(handler.prompt, request.payload)}\n\n${VERDICT_SYSTEM}` }],
        outputSchema: VERDICT_SCHEMA,
      }, { provider: 'spawn', label: `${request.event} hook`, signal, delivery: 'caller' })
      const onAbort = (): void => { void activation?.dispose() }
      signal.addEventListener('abort', onAbort, { once: true })
      const result = await activation.result
      signal.removeEventListener('abort', onAbort)
      const structured = result.structured
      const verdict = typeof structured === 'object' && structured !== null && typeof (structured as { ok?: unknown }).ok === 'boolean'
        ? structured as ModelVerdict
        : parseVerdict((result.output ?? []).map(block => block.type === 'text' ? block.text ?? '' : '').join(''))
      return { exitCode: 0, stdout: '', stderr: '', durationMs: elapsed(), verdict: { ok: verdict.ok, ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}) } }
    } catch (error: unknown) {
      void activation?.dispose().catch(() => undefined)
      if (request.signal.aborted) return { stdout: '', stderr: '', durationMs: elapsed(), failure: { kind: 'cancelled', message: 'cancelled' } }
      return { stdout: '', stderr: '', durationMs: elapsed(), failure: signal.aborted ? { kind: 'timeout', message: `timed out after ${String(request.timeoutMs)}ms` } : { kind: 'transport', message: `agent hook failed: ${messageOf(error)}` } }
    }
  }
}

interface LlmLike {
  prepareCall(route: { provider: string; model: string; maxTokens: number }, signal: AbortSignal): Promise<{
    readonly config: Record<string, unknown>
    stream(options: Record<string, unknown>): AsyncIterable<unknown>
  }>
}

const VERDICT_SYSTEM = 'You evaluate a hook condition for a coding agent. Respond with only a JSON object: {"ok": true} when the condition holds or the action may proceed, or {"ok": false, "reason": "<why>"} when it does not. Add "impossible": true when the condition can never be satisfied.'

const VERDICT_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['ok'],
  additionalProperties: false,
}

/** `$ARGUMENTS` → the input JSON (`\$` escapes); appended when absent. */
function promptText(prompt: string, payload: Readonly<Record<string, unknown>>): string {
  const json = JSON.stringify(payload)
  let used = false
  const text = prompt.replace(/\\\$|\$ARGUMENTS\b/gu, (match) => {
    if (match === '\\$') return '$'
    used = true
    return json
  })
  return used ? text : `${text}\n\n${json}`
}

/** The hook model's `{"ok": …}` answer: the text from its first `{` to its last `}`. */
export function parseVerdict(text: string): ModelVerdict {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      const value = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
      if (typeof value['ok'] === 'boolean') {
        return {
          ok: value['ok'],
          ...(typeof value['reason'] === 'string' ? { reason: value['reason'] } : {}),
          ...(value['impossible'] === true ? { impossible: true } : {}),
        }
      }
    } catch {
      // Fall through.
    }
  }
  return { ok: false, reason: `the hook model did not answer with {"ok": …}: ${text.slice(0, 200)}` }
}

function textDelta(chunk: unknown): string | undefined {
  if (typeof chunk !== 'object' || chunk === null) return undefined
  const value = chunk as { type?: unknown; text?: unknown; delta?: unknown }
  if (value.type === 'text-delta' && typeof value.text === 'string') return value.text
  if (value.type === 'text-delta' && typeof value.delta === 'string') return value.delta
  if (value.type === 'text' && typeof value.text === 'string') return value.text
  return undefined
}

/** Exec form: placeholders are substituted as plain strings. */
function substituteExec(value: string, places: HandlerPlaces): string {
  const posix = (path: string): string => path.replace(/\\/gu, '/')
  const values: Record<string, string> = {
    CLAUDE_PROJECT_DIR: posix(places.projectDir),
    CLAUDE_PLUGIN_ROOT: posix(places.pluginRoot),
    CLAUDE_PLUGIN_DATA: posix(places.dataDir),
    PLUGIN_ROOT: posix(places.pluginRoot),
    PLUGIN_DATA: posix(places.dataDir),
  }
  return value
    .replace(/\$\{user_config\.([A-Za-z0-9_.-]+)\}/gu, (_match, key: string) => places.options[key] ?? '')
    .replace(/\$\{([A-Z_]+)\}/gu, (match, name: string) => values[name] ?? match)
}

/** PowerShell shell form: path placeholders become `${env:NAME}`. */
export function powershellPlaceholders(command: string): string {
  let out = command
  for (const name of PATH_PLACEHOLDERS) out = out.split(`\${${name}}`).join(`\${env:${name}}`)
  return out
}

/** `${a.b}` fields from the input; a placeholder filling a whole value keeps its JSON type. */
export function fillTemplate(template: unknown, payload: Readonly<Record<string, unknown>>): unknown {
  const lookup = (path: string): unknown => path.split('.').reduce<unknown>((value, key) => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined), payload)
  if (typeof template === 'string') {
    const whole = /^\$\{([A-Za-z0-9_.]+)\}$/u.exec(template)
    if (whole !== null) return lookup(whole[1] ?? '')
    return template.replace(/\$\{([A-Za-z0-9_.]+)\}/gu, (_match, path: string) => {
      const value = lookup(path)
      return value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value)
    })
  }
  if (Array.isArray(template)) return template.map(item => fillTemplate(item, payload))
  if (typeof template === 'object' && template !== null) {
    return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, fillTemplate(value, payload)]))
  }
  return template
}

function isJsonObject(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  } catch {
    return false
  }
}

