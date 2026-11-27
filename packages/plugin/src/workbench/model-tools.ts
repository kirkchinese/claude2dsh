/**
 * Model-facing Harness Forge tools. They are thin adapters over the same
 * service the workbench uses, so a model can discover, inspect and install a
 * plugin without inventing a second code path.
 * @module @kirkchinese/harness-forge
 */
import type { Context } from '@deepseek-ai/cordis'
import { dialectIds } from '@kirkchinese/harness-forge-core'
import type { HarnessForge } from '../forge/service.js'
import { Workbench } from './workbench.js'
import { dshService } from '../dsh/host.js'
import { forgeVerifyDeps, verifyPort } from '../porting/verify-port.js'
import { VERIFY_TOOL } from '../porting/prompt.js'

interface ToolRegistry {
  register(definition: Record<string, unknown>): () => void
}

const inputSchema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
})

function textOutput(): Record<string, unknown> {
  return {
    schema: { type: 'object', additionalProperties: true },
    render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  }
}

/** Register the `harness_*` tool family; returns one disposer. */
export function registerModelTools(ctx: Context, forge: HarnessForge): () => void {
  const tools = dshService(ctx, 'tools') as ToolRegistry | undefined
  if (tools === undefined) return () => {}
  const workbench = new Workbench(forge)
  const disposers = [
    tools.register({
      name: 'harness_status',
      description: 'List installed Harness Forge plugins, component mounts, compatibility vectors and gaps.',
      parameters: inputSchema({}),
      output: textOutput(),
      execute: async () => ({ plugins: forge.list(), host: workbench.hostCapabilities() }),
    }),
    tools.register({
      name: 'harness_discover',
      description: 'Discover plugin roots under the configured Claude, Codex and OpenCode directories.',
      parameters: inputSchema({}),
      output: textOutput(),
      execute: async () => workbench.discover(),
    }),
    tools.register({
      name: 'harness_capabilities',
      description: 'Return the installed capability catalog, per-plugin compatibility and context-budget usage.',
      parameters: inputSchema({}),
      output: textOutput(),
      execute: async () => workbench.capabilities(),
    }),
    tools.register({
      name: 'harness_scan',
      description: 'Scan one foreign plugin root without installing it.',
      parameters: inputSchema({
        path: { type: 'string', description: 'Absolute plugin root' },
        source: { type: 'string', enum: dialectIds() },
      }, ['path']),
      output: textOutput(),
      execute: async (args: unknown) => {
        const input = args as { path?: unknown; source?: unknown }
        const path = typeof input.path === 'string' ? input.path : ''
        const source = typeof input.source === 'string' ? input.source : 'claude-code'
        return forge.scan(path, source)
      },
    }),
    tools.register({
      name: 'harness_plan',
      description: 'Build the reversible action plan for one foreign plugin root.',
      parameters: inputSchema({
        path: { type: 'string', description: 'Absolute plugin root' },
        source: { type: 'string', enum: dialectIds() },
      }, ['path']),
      output: textOutput(),
      execute: async (args: unknown) => {
        const input = args as { path?: unknown; source?: unknown }
        const path = typeof input.path === 'string' ? input.path : ''
        const source = typeof input.source === 'string' ? input.source : 'claude-code'
        return forge.plan(path, source)
      },
    }),
    tools.register({
      name: 'harness_mcp_login',
      description: 'Open the browser sign-in page of an imported remote MCP server that requires OAuth (its status shows "sign-in required"). The server connects when the user finishes; tell the user to complete the sign-in in the browser.',
      parameters: inputSchema({ server: { type: 'string', description: 'MCP server name, e.g. plugin_context7_context7' } }, ['server']),
      output: textOutput(),
      execute: async (args: unknown, exec: unknown) => {
        const server = String((args as { server?: unknown }).server ?? '')
        const mcp = forge.lookup('mcp')
        if (mcp === undefined) throw new Error('the Harness Forge mcp row is off')
        const sessionId = (exec as { agent?: { session?: { header?: { id?: string } } } } | undefined)?.agent?.session?.header?.id
        return { server, signInUrl: mcp.startSignIn(server, sessionId), waiting: mcp.pendingSignIns(sessionId) }
      },
    }),
    tools.register({
      name: 'harness_install',
      description: 'Install one foreign plugin root and execute its hooks, MCP servers and code shims.',
      parameters: inputSchema({
        path: { type: 'string', description: 'Absolute plugin root' },
        source: { type: 'string', enum: dialectIds() },
      }, ['path']),
      output: textOutput(),
      execute: async (args: unknown) => {
        const input = args as { path?: unknown; source?: unknown }
        const path = typeof input.path === 'string' ? input.path : ''
        const source = typeof input.source === 'string' ? input.source : 'claude-code'
        return forge.install(path, source)
      },
    }),
    tools.register({
      name: VERIFY_TOOL,
      description: 'Check that an installed adapter now covers a plugin part Harness Forge could not run: an installed package declares it in package.json "harnessForge.ports", its DSH bundle is enabled, and its plugins started without a fault. Answers { covered, checks[] } and records the result in Harness Forge\'s Gaps screen. Call it after installing an adapter, before reporting the port done; when covered is false, fix what the failing check says and call it again.',
      parameters: inputSchema({
        pluginId: { type: 'string', description: 'The original plugin\'s id, as the porting brief gives it (e.g. claude-code:claude-hud)' },
        componentId: { type: 'string', description: 'The part\'s component id, as the porting brief gives it' },
      }, ['pluginId', 'componentId']),
      output: textOutput(),
      execute: async (args: unknown, exec: unknown) => {
        const input = args as { pluginId?: unknown; componentId?: unknown }
        const sessionId = (exec as { agent?: { session?: { header?: { id?: string } } } } | undefined)?.agent?.session?.header?.id
        return verifyPort(forgeVerifyDeps(forge, workbench), String(input.pluginId ?? ''), String(input.componentId ?? ''), sessionId)
      },
    }),
  ]
  return () => { for (const dispose of disposers) dispose() }
}
