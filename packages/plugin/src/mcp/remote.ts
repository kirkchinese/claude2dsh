/**
 * Remote MCP servers (Streamable HTTP and legacy SSE) with OAuth sign-in.
 * The MCP SDK client connects; tools register through the official
 * `createMcpToolDefinition`, so naming, schemas, task rejection and result
 * projection match DSH's native MCP client. A server that requires sign-in
 * stays mounted in the `sign-in required` state until the user signs in.
 *
 * The bridge runs inside `ctx.inject(['tools'])`: Cordis only permits the
 * `ctx.tools` accessor in a context that declared the dependency.
 * @module @kirkchinese/harness-forge
 */
import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import { Client, SSEClientTransport, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client'
import type { Tool } from '@modelcontextprotocol/client'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import type { McpComponent } from '@kirkchinese/harness-forge-core'
import type { McpAuthStore } from './auth.js'
import { DEFAULT_TOOL_CALL_TIMEOUT_MS, mcpToolPolicy, publicToolName } from './policy.js'

/** This package's version, as the MCP client names itself to a server. */
const PACKAGE_VERSION = (createRequire(import.meta.url)('../../package.json') as { version: string }).version

/** Connection state reported to the service. */
export type RemoteMcpState =
  | { readonly kind: 'connected'; readonly tools: readonly string[] }
  | { readonly kind: 'sign-in-required'; readonly url: string }
  | { readonly kind: 'failed'; readonly error: string }

type Transport = StreamableHTTPClientTransport | SSEClientTransport

/** One live remote server. */
export class RemoteMcp {
  private client: Client | undefined
  private transport: Transport | undefined
  private toolCtx: Context | undefined
  private fiber: { dispose(): Promise<void> } | undefined
  private registrations: Array<() => void> = []
  private authorizationUrl: URL | undefined
  private state: RemoteMcpState = { kind: 'failed', error: 'not connected' }
  private closed = false

  constructor(
    private readonly ctx: Context,
    private readonly component: McpComponent & { readonly url: string },
    readonly serverName: string,
    private readonly auth: McpAuthStore,
    private readonly onState: (state: RemoteMcpState) => void,
  ) {}

  /** Connect and register tools; resolves with the resulting state. */
  async start(): Promise<RemoteMcpState> {
    this.toolCtx ??= await new Promise<Context>((resolve) => {
      this.fiber = this.ctx.inject(['tools'], (toolCtx) => { resolve(toolCtx) }) as unknown as { dispose(): Promise<void> }
    })
    await this.auth.prepare(this.component.url)
    return this.connect()
  }

  /** Open the sign-in page, finish the OAuth exchange, then connect. */
  async signIn(): Promise<RemoteMcpState> {
    if (this.state.kind !== 'sign-in-required' || this.authorizationUrl === undefined || this.transport === undefined) return this.state
    const params = await this.auth.signIn(this.component.url, this.authorizationUrl)
    await this.transport.finishAuth(params)
    return this.connect()
  }

  get current(): RemoteMcpState {
    return this.state
  }

  /** Whether the server was disposed: it waits for nothing any more. */
  get disposed(): boolean {
    return this.closed
  }

  async dispose(): Promise<void> {
    this.closed = true
    this.unregister()
    await this.client?.close().catch(() => undefined)
    await this.fiber?.dispose()
  }

  private async connect(): Promise<RemoteMcpState> {
    this.unregister()
    await this.client?.close().catch(() => undefined)
    const url = new URL(this.component.url)
    const options = {
      requestInit: { headers: { ...this.component.headers } },
      authProvider: this.auth.provider(this.component.url, (authorizationUrl) => { this.authorizationUrl = authorizationUrl }),
    }
    const transport: Transport = this.component.transport === 'sse'
      ? new SSEClientTransport(url, options)
      : new StreamableHTTPClientTransport(url, options)
    const client = new Client({ name: 'harness-forge', version: PACKAGE_VERSION }, { capabilities: {}, versionNegotiation: { mode: 'auto' } })
    this.transport = transport
    this.client = client
    try {
      await client.connect(transport)
      const response = await client.listTools(undefined, { cacheMode: 'refresh' })
      // Tools the server's configuration switches off are never registered.
      const policy = mcpToolPolicy(this.component, this.serverName)
      const tools = response.tools.filter(tool => policy?.runs(tool.name) ?? true).map(tool => this.register(client, tool))
      return this.settle({ kind: 'connected', tools })
    } catch (error: unknown) {
      if (error instanceof UnauthorizedError && this.authorizationUrl !== undefined) {
        return this.settle({ kind: 'sign-in-required', url: this.authorizationUrl.href })
      }
      await client.close().catch(() => undefined)
      return this.settle({ kind: 'failed', error: rootCause(error) })
    }
  }

  private register(client: Client, tool: Tool): string {
    const toolCtx = this.toolCtx as Context & { tools: { register(definition: unknown): () => void } }
    const name = publicToolName(this.serverName, tool.name)
    const definition = createMcpToolDefinition(toolCtx, {
      name,
      rawName: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      taskRequired: tool.execution?.taskSupport === 'required',
      call: (args: Record<string, unknown>, execution: { signal: AbortSignal }) => client.callTool(
        { name: tool.name, arguments: args },
        { signal: execution.signal, timeout: this.component.toolTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS, toolDefinition: tool },
      ),
    })
    this.registrations.push(toolCtx.tools.register(definition))
    return name
  }

  private unregister(): void {
    for (const dispose of this.registrations.splice(0)) dispose()
  }

  private settle(state: RemoteMcpState): RemoteMcpState {
    this.state = state
    this.onState(state)
    return state
  }
}

function rootCause(error: unknown): string {
  let current: unknown = error
  let message = error instanceof Error ? error.message : String(error)
  while (current instanceof Error && current.cause !== undefined) {
    current = current.cause
    if (current instanceof Error) message = current.message
  }
  return message
}
