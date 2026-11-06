/** Same-origin Settings routes for the DSH2Claude browser panel. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { resolveClaudeHome, resolveDshHome } from './dsh-home.ts'
import { installStaged, summarizeStaging } from './install.ts'
import { listDshSessionInventory, migrateDsh } from './migrate.ts'
import { loadManifest, stagingRoot, type StagedKind } from './staging.ts'
import type { SettingsRuntime } from './settings-service.ts'

export const DSH2CLAUDE_SETTINGS_PATH = '/plugins/dsh2claude/settings'
export const DSH2CLAUDE_STAGE_PATH = '/plugins/dsh2claude/stage'
export const DSH2CLAUDE_INSTALL_PATH = '/plugins/dsh2claude/install'
export const DSH2CLAUDE_STATUS_PATH = '/plugins/dsh2claude/status'
export const DSH2CLAUDE_SESSIONS_PATH = '/plugins/dsh2claude/sessions'

function trustedRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const host = req.headers.host
  if (host === undefined) return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === new URL(`http://${host}`).host
  } catch {
    return false
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(value))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += data.byteLength
    if (bytes > 64 * 1024) throw new Error('request body is too large')
    chunks.push(data)
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('request body must be an object')
  return value as Record<string, unknown>
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500)
}

function paths(runtime: SettingsRuntime): { dshHome: string; claudeHome: string; root: string } {
  const settings = runtime.get()
  const dshHome = settings.sessions.dshHome.trim().length > 0 ? settings.sessions.dshHome.trim() : resolveDshHome()
  const claudeHome = settings.install.claudeHome.trim().length > 0 ? settings.install.claudeHome.trim() : resolveClaudeHome()
  const root = settings.sessions.root.trim().length > 0 ? settings.sessions.root.trim() : join(dshHome, 'sessions')
  return { dshHome, claudeHome, root }
}

const KINDS: readonly StagedKind[] = ['session', 'skill', 'instructions', 'mcp']

function requestedKinds(value: unknown): StagedKind[] | undefined {
  if (!Array.isArray(value)) return undefined
  const kinds = value.filter((item): item is StagedKind => typeof item === 'string' && (KINDS as readonly string[]).includes(item))
  return kinds.length > 0 ? kinds : undefined
}

/** Register GET/POST handlers for the browser settings page. */
export function registerDsh2ClaudeRoutes(ctx: Context, runtime: SettingsRuntime): void {
  let registered = false
  let disposed = false
  const disposers: Array<() => void> = []
  const registerNow = (): boolean => {
    if (registered || disposed) return true
    const webServer = ctx.get('webServer') as { register(spec: unknown): () => void } | undefined
    if (webServer === undefined) return false
    registered = true

    const register = (path: string, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void): void => {
      disposers.push(webServer.register({ kind: 'exact', path, handler }))
    }

    register(DSH2CLAUDE_SETTINGS_PATH, async (req, res) => {
      if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
      if (req.method === 'GET') return json(res, 200, runtime.get())
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
      try {
        await runtime.update(await readJson(req))
        json(res, 200, runtime.get())
      } catch (error) {
        json(res, 400, { error: safeMessage(error) })
      }
    })

    register(DSH2CLAUDE_STAGE_PATH, async (req, res) => {
      if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
      try {
        const body = await readJson(req)
        const settings = runtime.get()
        const resolved = paths(runtime)
        const only = Array.isArray(body.only) ? body.only.filter((id): id is string => typeof id === 'string') : undefined
        const report = await migrateDsh({
          dshHome: resolved.dshHome,
          path: typeof body.path === 'string' && body.path.trim().length > 0 ? body.path.trim() : resolved.root,
          recursive: settings.sessions.recursive,
          includeSubagents: typeof body.includeSubagents === 'boolean' ? body.includeSubagents : settings.sessions.includeSubagents,
          preview: body.preview === true,
          skills: body.skills === true || (body.skills === undefined && settings.assets.skills),
          instructions: body.instructions === true || (body.instructions === undefined && settings.assets.instructions),
          mcp: body.mcp === true || (body.mcp === undefined && settings.assets.mcp),
          ...(only !== undefined ? { only } : {}),
        })
        json(res, 200, report)
      } catch (error) {
        json(res, 400, { error: safeMessage(error) })
      }
    })

    register(DSH2CLAUDE_INSTALL_PATH, async (req, res) => {
      if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
      try {
        const body = await readJson(req)
        const settings = runtime.get()
        const resolved = paths(runtime)
        const kinds = requestedKinds(body.kinds)
        const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : undefined
        const report = await installStaged({
          dshHome: resolved.dshHome,
          staging: stagingRoot(resolved.dshHome),
          claudeHome: resolved.claudeHome,
          ...(kinds !== undefined ? { kinds } : {}),
          ...(ids !== undefined ? { ids } : {}),
          force: body.force === true || settings.install.overwrite,
          dryRun: body.confirm !== true || body.dryRun === true,
        })
        json(res, 200, report)
      } catch (error) {
        json(res, 400, { error: safeMessage(error) })
      }
    })

    register(DSH2CLAUDE_STATUS_PATH, async (req, res) => {
      if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      try {
        const resolved = paths(runtime)
        const manifest = await loadManifest(resolved.dshHome)
        json(res, 200, {
          settings: runtime.get(),
          dshHome: resolved.dshHome,
          claudeHome: resolved.claudeHome,
          sessionsRoot: resolved.root,
          stagingRoot: stagingRoot(resolved.dshHome),
          summary: summarizeStaging(manifest),
          items: manifest.items,
        })
      } catch (error) {
        json(res, 500, { error: safeMessage(error) })
      }
    })

    register(DSH2CLAUDE_SESSIONS_PATH, async (req, res) => {
      if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      try {
        const resolved = paths(runtime)
        json(res, 200, await listDshSessionInventory({
          dshHome: resolved.dshHome,
          path: resolved.root,
          includeSubagents: runtime.get().sessions.includeSubagents,
        }))
      } catch (error) {
        json(res, 500, { error: safeMessage(error) })
      }
    })
    return true
  }

  const timer = setInterval(() => {
    if (registerNow()) clearInterval(timer)
  }, 100)
  ctx.effect(() => () => {
    disposed = true
    clearInterval(timer)
    for (const dispose of disposers) dispose()
  }, 'dsh2claude: settings routes')
}
