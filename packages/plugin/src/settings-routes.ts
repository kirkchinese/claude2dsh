/** Same-origin Settings routes for the Claude2DSH browser panel. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { SettingsRuntime } from './settings-service.ts'
import { loadSessionSourceMap } from './session-sources.ts'
import { importClaudeSessions } from './session-import.ts'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { currentSessionRoute, probeImageRoute } from './image-policy.ts'
import { discoverClaudeHooks, saveDiscoveredHooks } from './hook-discovery.ts'
import { exportClaudeSession } from './export-claude.ts'
import { syncClaudeSession } from './sync-claude.ts'
import { resolveDshHome } from './registry.ts'

export const CLAUDE2DSH_SETTINGS_PATH = '/plugins/claude2dsh/settings'
export const CLAUDE2DSH_SESSION_SOURCES_PATH = '/plugins/claude2dsh/session-sources'
export const CLAUDE2DSH_IMPORT_PATH = '/plugins/claude2dsh/import'
export const CLAUDE2DSH_IMAGE_PROBE_PATH = '/plugins/claude2dsh/image-probe'
export const CLAUDE2DSH_IMPORT_DEFAULTS_PATH = '/plugins/claude2dsh/import-defaults'
export const CLAUDE2DSH_HOOK_SCAN_PATH = '/plugins/claude2dsh/hook-scan'
export const CLAUDE2DSH_HOOK_APPLY_PATH = '/plugins/claude2dsh/hook-scan/apply'
export const CLAUDE2DSH_SESSIONS_PATH = '/plugins/claude2dsh/sessions'
export const CLAUDE2DSH_EXPORT_PATH = '/plugins/claude2dsh/export'
export const CLAUDE2DSH_SYNC_PATH = '/plugins/claude2dsh/sync'

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
  let registered = false
  let disposed = false
  const disposers: Array<() => void> = []
  const registerNow = (): boolean => {
    if (registered || disposed) return true
    const webServer = ctx.get('webServer') as { register(spec: unknown): () => void } | undefined
    if (webServer === undefined) return false
    registered = true
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
    disposers.push(dispose)
    disposers.push(webServer.register({
      kind: 'exact',
      path: CLAUDE2DSH_SESSIONS_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        try {
          const headers = await ctx.sessionPersistence.list()
          json(res, 200, { sessions: headers.map((header) => ({ sessionId: String(header.id), cwd: header.cwd, origin: header.origin, delegationDepth: header.delegationDepth, createdAt: header.createdAt })) })
        } catch (error) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    }))
    disposers.push(webServer.register({
      kind: 'exact',
      path: CLAUDE2DSH_EXPORT_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        try {
          const body = await readJson(req)
          if (typeof body.sessionId !== 'string' || body.sessionId.trim().length === 0) throw new Error('sessionId must be a non-empty string')
          const result = await exportClaudeSession(ctx, {
            sessionId: body.sessionId,
            ...(typeof body.outputDir === 'string' && body.outputDir.trim().length > 0 ? { outputDir: body.outputDir } : {}),
            allowOriginalClaudeDir: body.allowOriginalClaudeDir === true,
            force: body.force === true,
          }, resolveDshHome())
          json(res, 200, result)
        } catch (error) {
          json(res, 400, { error: safeMessage(error) })
        }
      },
    }))
    disposers.push(webServer.register({
      kind: 'exact',
      path: CLAUDE2DSH_SYNC_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        try {
          const body = await readJson(req)
          if (typeof body.sessionId !== 'string' || body.sessionId.trim().length === 0) throw new Error('sessionId must be a non-empty string')
          const result = await syncClaudeSession(ctx, {
            sessionId: body.sessionId,
            target: body.target === 'source' ? 'source' : 'copy',
            allowOriginalClaudeDir: body.allowOriginalClaudeDir === true,
            force: body.force === true,
            dryRun: body.dryRun === true,
          }, resolveDshHome())
          json(res, 200, result)
        } catch (error) {
          json(res, 400, { error: safeMessage(error) })
        }
      },
    }))
    disposers.push(webServer.register({
      kind: 'exact',
      path: CLAUDE2DSH_HOOK_SCAN_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        try {
          json(res, 200, await discoverClaudeHooks())
        } catch (error) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    }))
    disposers.push(webServer.register({
      kind: 'exact',
      path: CLAUDE2DSH_HOOK_APPLY_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        try {
          const report = await discoverClaudeHooks()
          const configPath = await saveDiscoveredHooks(report.config, resolveDshHome())
          await runtime.update({ hooks: { configPath } })
          json(res, 200, { configPath, scannedFiles: report.scannedFiles, supportedCommands: report.supportedCommands, skipped: report.skipped, activation: `CLAUDE2DSH_HOOKS_CONFIG=${configPath} dsh --profile web` })
        } catch (error) {
          json(res, 400, { error: safeMessage(error) })
        }
      },
    }))
    disposers.push(webServer.register({
      kind: 'exact',
      path: CLAUDE2DSH_IMPORT_DEFAULTS_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        const configDir = process.env.CLAUDE_CONFIG_DIR
        const sourceRoot = configDir !== undefined && configDir.trim().length > 0
          ? join(configDir, 'projects')
          : join(homedir(), '.claude', 'projects')
        json(res, 200, { sourceRoot, recursive: runtime.get().importDefaults.recursive })
      },
    }))
    disposers.push(webServer.register({
      kind: 'exact',
      path: CLAUDE2DSH_IMAGE_PROBE_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        try {
          const settings = runtime.get().importDefaults
          const manual = settings.imageProvider.trim().length > 0 && settings.imageModel.trim().length > 0
          const route = manual
            ? { provider: settings.imageProvider.trim(), model: settings.imageModel.trim(), source: 'manual' as const }
            : currentSessionRoute(ctx) !== undefined
              ? { provider: currentSessionRoute(ctx)!.provider, model: currentSessionRoute(ctx)!.model, source: 'session' as const }
              : undefined
          const supports = route !== undefined ? await probeImageRoute(ctx, route.provider, route.model) : undefined
          const reason = supports === true
            ? `route ${route?.provider}/${route?.model} advertises image input`
            : supports === false
              ? `route ${route?.provider}/${route?.model} advertises text-only input; images degrade to safe placeholders`
              : route === undefined
                ? 'no current DSH session route and no manual probe route configured'
                : `could not resolve image capabilities for ${route.provider}/${route.model}`
          json(res, 200, { routeSource: route?.source ?? 'none', provider: route?.provider, model: route?.model, supports, reason })
        } catch (error) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    }))
    disposers.push(webServer.register({
      kind: 'exact',
      path: CLAUDE2DSH_IMPORT_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        try {
          const body = await readJson(req)
          const defaults = runtime.get().importDefaults
          const configDir = process.env.CLAUDE_CONFIG_DIR
          const defaultPath = configDir !== undefined && configDir.trim().length > 0
            ? join(configDir, 'projects')
            : join(homedir(), '.claude', 'projects')
          const sourcePath = typeof body.path === 'string' && body.path.trim().length > 0 ? body.path : defaultPath
          const report = await importClaudeSessions(ctx, {
            path: sourcePath,
            recursive: typeof body.recursive === 'boolean' ? body.recursive : defaults.recursive,
            preview: body.preview === true,
            includeSubagents: body.includeSubagents === true ? true : defaults.includeSubagents,
            imageMode: defaults.imageMode,
            imageProvider: defaults.imageProvider,
            imageModel: defaults.imageModel,
            sidecarMaxBytes: defaults.sidecarMaxBytes,
          }, resolveDshHome())
          json(res, 200, report)
        } catch (error) {
          json(res, 400, { error: safeMessage(error) })
        }
      },
    }))
    disposers.push(webServer.register({
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
    }))
    return true
  }
  const timer = setInterval(() => {
    if (registerNow()) clearInterval(timer)
  }, 100)
  ctx.effect(() => () => {
    disposed = true
    clearInterval(timer)
    for (const dispose of disposers) dispose()
  }, 'claude2dsh: settings routes')
}
