/**
 * Harness Forge's OpenCode plugin host: one Bun process per OpenCode plugin,
 * loading it as OpenCode does and serving its hooks and tools to DSH.
 *
 * Started by `@kirkchinese/harness-forge` with the plugin's directory as
 * the working directory and these variables:
 *   HF_OC_ENTRY   the plugin's entry module
 *   HF_OC_SERVER  the OpenCode-compatible server the plugin's `client` talks to
 *   HF_OC_KEY     this host's name on that server
 *   HF_OC_SDK     the `@opencode-ai/sdk/client` module that builds `client`
 *   HF_OC_INPUT   JSON: { directory, worktree, project, options, config, auth }
 *
 * Loading follows OpenCode V1: a default export with `server` is the plugin;
 * otherwise every exported function is one, each called once. Every hook runs
 * in load order on the same output object, as OpenCode triggers them.
 */
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const entry = process.env.HF_OC_ENTRY
const server = process.env.HF_OC_SERVER
const key = process.env.HF_OC_KEY
const input = JSON.parse(process.env.HF_OC_INPUT ?? '{}')

const internal = (path, body) => fetch(`${server}/__hf/${key}/${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body ?? {}),
})

const messageOf = error => (error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error))

/**
 * A deliberate refusal (`throw new Error('...')`, a string) or a crash: a
 * system error (it has a `code`) or a TypeError, ReferenceError, SyntaxError
 * or RangeError.
 */
const kindOf = error => (error instanceof Error && (typeof error.code === 'string' || ['TypeError', 'ReferenceError', 'SyntaxError', 'RangeError'].includes(error.name)) ? 'crash' : 'stop')

async function main() {
  const { createOpencodeClient } = await import(pathToFileURL(process.env.HF_OC_SDK).href)
  const client = createOpencodeClient({ baseUrl: server, directory: input.directory, headers: { 'x-hf-plugin': key } })
  const pluginInput = {
    client,
    project: input.project,
    directory: input.directory,
    worktree: input.worktree,
    experimental_workspace: { register() {} },
    serverUrl: new URL(server),
    $: Bun.$,
  }

  const module = await import(pathToFileURL(entry).href)
  const plugins = []
  const fromDefault = module.default
  if (fromDefault !== null && typeof fromDefault === 'object' && typeof fromDefault.server === 'function') {
    plugins.push({ name: typeof fromDefault.id === 'string' ? fromDefault.id : 'default', fn: fromDefault.server })
  } else if (fromDefault !== null && typeof fromDefault === 'object' && typeof fromDefault.setup === 'function') {
    // An OpenCode V2 plugin only (`Plugin.define({ id, setup })`): its `setup(ctx)` API is a different one.
    throw new Error(`OpenCode V2 plugin${typeof fromDefault.id === 'string' ? ` ${fromDefault.id}` : ''} (Plugin.define with setup(ctx)): Harness Forge runs OpenCode V1 plugins; the V2 context API is not served yet`)
  } else {
    const seen = new Set()
    for (const [name, value] of Object.entries(module)) {
      if (typeof value !== 'function' || seen.has(value)) continue
      seen.add(value)
      plugins.push({ name, fn: value })
    }
  }

  const loaded = []
  for (const plugin of plugins) {
    const hooks = await plugin.fn(pluginInput, input.options ?? {})
    if (hooks !== null && typeof hooks === 'object') loaded.push({ name: plugin.name, hooks })
  }

  // `config` runs once with the whole configuration, which a plugin may extend.
  const config = structuredClone(input.config ?? {})
  for (const { hooks } of loaded) if (typeof hooks.config === 'function') await hooks.config(config)

  // `auth` loaders receive the stored credential of their provider, as OpenCode loads a provider.
  for (const { hooks } of loaded) {
    const auth = hooks.auth
    if (auth === null || typeof auth !== 'object' || typeof auth.loader !== 'function') continue
    const stored = input.auth?.[auth.provider]
    const provider = config.provider?.[auth.provider] ?? { id: auth.provider, name: auth.provider, env: [], models: {} }
    try {
      await auth.loader(async () => stored ?? { type: 'api', key: '' }, provider)
    } catch (error) {
      console.error(`[harness-forge] auth loader for ${auth.provider}: ${messageOf(error)}`)
    }
  }

  const zod = await zodFor(dirname(entry))
  const tools = new Map()
  for (const { name: plugin, hooks } of loaded) {
    for (const [toolName, tool] of Object.entries(hooks.tool ?? {})) {
      if (tool === null || typeof tool !== 'object' || typeof tool.execute !== 'function') continue
      tools.set(toolName, { tool, plugin, schema: objectSchema(zod, tool.args) })
    }
  }

  const calls = new Map()
  const run = async (name, hookInput, output) => {
    let ran = 0
    for (const { hooks } of loaded) {
      const hook = hooks[name]
      if (typeof hook !== 'function') continue
      ran += 1
      await hook(hookInput, output)
    }
    return ran
  }

  const serve = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {}
      try {
        if (path === '/hook') {
          const output = body.output ?? {}
          try {
            const ran = await run(body.name, body.input ?? {}, output)
            return Response.json({ ran, output })
          } catch (error) {
            return Response.json({ ran: 1, output, error: messageOf(error), errorKind: kindOf(error) })
          }
        }
        if (path === '/event') {
          // Every plugin hears the event; the first failure is reported.
          let failure
          for (const { hooks } of loaded) {
            if (typeof hooks.event !== 'function') continue
            try {
              await hooks.event({ event: body.event })
            } catch (error) {
              failure ??= messageOf(error)
            }
          }
          return Response.json(failure === undefined ? { ok: true } : { ok: false, error: failure })
        }
        if (path === '/tool') return Response.json(await callTool(body))
        if (path === '/abort') {
          calls.get(body.callID)?.abort(new Error('aborted'))
          return Response.json({ ok: true })
        }
        if (path === '/dispose') {
          let failure
          let ran = 0
          for (const { hooks } of loaded) {
            if (typeof hooks.dispose !== 'function') continue
            ran += 1
            try {
              await hooks.dispose()
            } catch (error) {
              failure ??= messageOf(error)
            }
          }
          setTimeout(() => process.exit(0), 50)
          return Response.json(failure === undefined ? { ok: true, ran } : { ok: false, ran, error: failure })
        }
        return new Response('not found', { status: 404 })
      } catch (error) {
        return Response.json({ error: messageOf(error) }, { status: 500 })
      }
    },
  })

  async function callTool({ name, args, context }) {
    const entry = tools.get(name)
    if (entry === undefined) return { error: `no tool ${name}` }
    let parsed = args ?? {}
    if (entry.schema?.zod !== undefined) {
      const result = entry.schema.zod.safeParse(parsed)
      if (!result.success) {
        return { error: `The ${name} tool was called with invalid arguments: ${result.error.message}.\nPlease rewrite the input so it satisfies the expected schema.` }
      }
      parsed = result.data
    }
    const controller = new AbortController()
    calls.set(context.callID, controller)
    const toolContext = {
      sessionID: context.sessionID,
      messageID: context.messageID,
      agent: context.agent,
      directory: context.directory,
      worktree: context.worktree,
      abort: controller.signal,
      callID: context.callID,
      metadata(update) {
        void internal('metadata', { callID: context.callID, sessionID: context.sessionID, update }).catch(() => undefined)
      },
      async ask(request) {
        const response = await internal('ask', { callID: context.callID, sessionID: context.sessionID, request, tool: name })
        const answer = await response.json()
        if (answer.allowed !== true) throw new Error(answer.reason ?? `The user rejected permission to use this specific tool call.`)
      },
    }
    try {
      const value = await entry.tool.execute(parsed, toolContext)
      return { result: value }
    } catch (error) {
      return { error: messageOf(error) }
    } finally {
      calls.delete(context.callID)
    }
  }

  await internal('ready', {
    port: serve.port,
    plugins: loaded.map(({ name, hooks }) => ({
      name,
      hooks: Object.keys(hooks).filter(hook => hook !== 'tool' && hooks[hook] !== undefined),
      tools: Object.keys(hooks.tool ?? {}),
    })),
    tools: [...tools].map(([name, { tool, plugin, schema }]) => ({
      name,
      plugin,
      description: typeof tool.description === 'string' ? tool.description : '',
      parameters: schema?.json ?? { type: 'object', additionalProperties: true },
    })),
    config,
  })
}

/** The plugin's zod (its `@opencode-ai/plugin`'s `tool.schema`, else its own `zod`). */
async function zodFor(from) {
  const require = createRequire(join(from, 'index.js'))
  for (const specifier of ['@opencode-ai/plugin', 'zod']) {
    try {
      const resolved = Bun.resolveSync(specifier, from)
      const module = await import(pathToFileURL(resolved).href)
      const z = specifier === 'zod' ? (module.z ?? module.default ?? module) : module.tool?.schema
      if (z !== undefined && typeof z.object === 'function') return z
    } catch {
      try {
        const module = require(specifier)
        const z = specifier === 'zod' ? (module.z ?? module) : module.tool?.schema
        if (z !== undefined && typeof z.object === 'function') return z
      } catch {
        // Try the next.
      }
    }
  }
  return undefined
}

/** A tool's argument shape as a zod object and the JSON Schema the model sees, as OpenCode derives them. */
function objectSchema(z, args) {
  if (args === null || typeof args !== 'object') return undefined
  // A schema already (an object), or a raw shape of field schemas.
  const zodObject = typeof args.safeParse === 'function' ? args : z?.object?.(args)
  if (zodObject === undefined) return undefined
  let json
  try {
    json = typeof z?.toJSONSchema === 'function' ? z.toJSONSchema(zodObject, { io: 'input', unrepresentable: 'any' }) : undefined
  } catch {
    json = undefined
  }
  if (json !== undefined) delete json.$schema
  return { zod: zodObject, json: json ?? { type: 'object', additionalProperties: true } }
}

main().catch(async (error) => {
  await internal('ready', { error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) }).catch(() => undefined)
  process.exit(1)
})
