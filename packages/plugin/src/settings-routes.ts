/** Same-origin Settings routes for the Claude2DSH browser panel. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { SettingsRuntime } from './settings-service.ts'
import { loadSessionSourceMap } from './session-sources.ts'

export const CLAUDE2DSH_SETTINGS_PATH = '/plugins/claude2dsh/settings'
export const CLAUDE2DSH_SESSION_SOURCES_PATH = '/plugins/claude2dsh/session-sources'

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

/** Register GET/POST handlers for the browser settings page. */
export function registerClaude2dshSettingsRoutes(ctx: Context, runtime: SettingsRuntime): void {
  const webServer = ctx.get('webServer') as { register(spec: unknown): () => void } | undefined
  if (webServer === undefined) return
  const dispose = webServer.register({
    kind: 'exact',
    path: CLAUDE2DSH_SETTINGS_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
      if (req.method === 'GET') return json(res, 200, runtime.get())
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
      try {
        const patch = await readJson(req)
        await runtime.update(patch)
        json(res, 200, runtime.get())
      } catch (error) {
        json(res, 400, { error: safeMessage(error) })
      }
    },
  })
  const disposeSources = webServer.register({
    kind: 'exact',
    path: CLAUDE2DSH_SESSION_SOURCES_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      try {
        json(res, 200, { sessions: (await loadSessionSourceMap()).sessions })
      } catch (error) {
        json(res, 500, { error: safeMessage(error) })
      }
    },
  })
  ctx.effect(() => () => {
    dispose()
    disposeSources()
  }, 'claude2dsh: settings routes')
}
