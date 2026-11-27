/**
 * The workbench's whole Host surface, as Typert Remote methods under the
 * `harnessCompat` namespace: the browser reaches them through DSH's own
 * Remote carrier, like every DSH service, and Harness Forge registers no HTTP
 * routes of its own. Each method takes at most one `request` object, so the
 * Gateway's source-mode reflection maps one named wire argument and no
 * parameter name can collide with a Host lookup. Method names avoid the
 * browser namespace service's own members (`install`, `remove`, `has`, …). Failures are RemoteErrors
 * whose message is the reason the person reads.
 *
 * Methods are marked with the protocol's runtime marker helper rather than
 * decorator syntax so Vitest can load the Host entry without a decorator
 * transform.
 * @module @kirkchinese/harness-forge
 */
import type { Context } from '@deepseek-ai/cordis'
import { assess, type ForeignPlugin } from '@kirkchinese/harness-forge-core'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { HarnessForge, InstallReport } from '../forge/service.js'
import { Workbench } from './workbench.js'
import { waitingParts } from '../forge/projects.js'
import type { RowApis } from '../forge/contract.js'
import { forgeVerifyDeps, livePorts, verifyPort } from '../porting/verify-port.js'
import { stateOf } from '../porting/port-sessions.js'
import { installChatImport, sessionImportStatus } from '../sessions/chat-import.js'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A workbench operation failed; the message says why, for the person. */
    'harness-forge/failed': { readonly operation: string }
  }
}

type Source = 'claude-code' | 'codex' | 'opencode'

function sourceOf(value: unknown): Source {
  return value === 'codex' || value === 'opencode' ? value : 'claude-code'
}

function text(request: Record<string, unknown> | undefined, key: string): string {
  const value = request?.[key]
  return typeof value === 'string' ? value : ''
}

function required(request: Record<string, unknown> | undefined, key: string, operation: string): string {
  const value = text(request, key)
  if (value.length === 0) throw new RemoteError('harness-forge/failed', `${key} is required`, { operation })
  return value
}

/** Plugin facts the workbench shows for a scan. */
function summary(plugin: ForeignPlugin): Record<string, unknown> {
  const counts = new Map<string, number>()
  for (const component of plugin.components) counts.set(component.kind, (counts.get(component.kind) ?? 0) + 1)
  return {
    id: plugin.id,
    name: plugin.name,
    source: plugin.source,
    version: plugin.version,
    license: plugin.license,
    root: plugin.root,
    manifestKind: plugin.ref.manifestKind,
    components: Object.fromEntries(counts),
    warnings: plugin.warnings.map(warning => warning.code),
    compat: assess(plugin),
  }
}

/** What an install reports to the workbench. */
function reportOf(report: InstallReport): Record<string, unknown> {
  return {
    plugin: summary(report.plugin),
    compat: report.compat,
    receipt: report.receipt,
    outcomes: report.outcomes,
    alreadyInstalled: report.alreadyInstalled,
    skillRoots: report.skillRoots,
    commands: report.commands,
    mcp: report.mcp,
    hooks: report.hooks,
    agents: report.agents,
  }
}

/** What an adapter's surface shows for one session (the ui-slot template's `{ lines, at }`). */
export interface AdapterSurfaceSource {
  /** `request`: what the browser half sent with it (a width, say). */
  read(sessionId: string, request: Readonly<Record<string, unknown>>): unknown
}

/** The installation service as Remote methods. */
export class HarnessRemoteService extends TypertRemoteService {
  private readonly forge: HarnessForge
  private readonly workbench: Workbench
  private readonly adapterSurfaces = new Map<string, AdapterSurfaceSource>()
  private readonly adapterListeners = new Map<string, Set<(sessionId: string) => void>>()

  constructor(ctx: Context, forge: HarnessForge) {
    super(ctx, 'harnessCompat')
    this.forge = forge
    this.workbench = new Workbench(forge)
  }

  /** A row's API, or a failure naming the row that is off. */
  private row<K extends keyof RowApis>(name: K, operation: string): RowApis[K] {
    const api = this.forge.lookup(name)
    if (api === undefined) throw new RemoteError('harness-forge/failed', `the Harness Forge ${name} row is off; turn it on in Plugin Manager`, { operation })
    return api
  }

  /** Run one operation; anything it throws reaches the browser with its message. */
  private async guard<T>(operation: string, run: () => T | Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && (error as { isDSHRemoteError?: unknown }).isDSHRemoteError === true) throw error
      throw new RemoteError('harness-forge/failed', error instanceof Error ? error.message : String(error), { operation }, { cause: error })
    }
  }

  // --- reading --------------------------------------------------------------

  /** The instruction files added to the default workspace's prompt (`{ active, yieldingTo?, files }`); inactive while the context row is off. */
  contextStatus(): Promise<unknown> {
    return this.guard('contextStatus', () => this.forge.lookup('context')?.status() ?? { active: false, files: [] })
  }

  /** The overview, plus the workspaces of open sessions with their trust and the project parts that wait for it. */
  overview(): Promise<unknown> {
    return this.guard('overview', async () => ({ ...await this.workbench.overview(), workspaces: await this.forge.projects.workspaces() }))
  }

  // --- workspace trust ----------------------------------------------------------

  /** A workspace's trust (`{ workspace, trusted, sources, waiting }`): its project parts that run code wait until it is trusted. */
  workspaceTrust(request: Record<string, unknown>): Promise<unknown> {
    return this.guard('workspaceTrust', () => this.trustOf(required(request, 'cwd', 'workspaceTrust')))
  }

  /**
   * Trust (or stop trusting) a workspace in Harness Forge; returns once open sessions in it have mounted or withdrawn what changed
   * (`{ decision, stillLive: [{ componentId, reason }] }`: the parts whose withdrawal failed are still live, and calling it again retries).
   */
  trustWorkspace(request: Record<string, unknown>): Promise<unknown> {
    return this.guard('trustWorkspace', async () => {
      const cwd = required(request, 'cwd', 'trustWorkspace')
      if (typeof request['trusted'] !== 'boolean') throw new RemoteError('harness-forge/failed', 'trusted must be true or false', { operation: 'trustWorkspace' })
      const { stillLive } = await this.forge.projects.setTrust(cwd, request['trusted'])
      return { decision: this.trustOf(cwd), stillLive }
    })
  }

  /** The workspaces Harness Forge holds a trust decision on (`{ workspaces: [{ workspace, trusted, sources, dismissed, trustedAt?, dismissedAt? }] }`): trusted here, or dismissed with "Not now". */
  trustDecisions(): Promise<unknown> {
    return this.guard('trustDecisions', () => ({ workspaces: this.forge.projects.trust.list() }))
  }

  /** Hide (or show again) a workspace's trust banner; trusts nothing. */
  dismissTrust(request: Record<string, unknown>): Promise<unknown> {
    return this.guard('dismissTrust', () => {
      const cwd = required(request, 'cwd', 'dismissTrust')
      if (typeof request['dismissed'] !== 'boolean') throw new RemoteError('harness-forge/failed', 'dismissed must be true or false', { operation: 'dismissTrust' })
      this.forge.projects.trust.dismiss(cwd, request['dismissed'])
      return this.trustOf(cwd)
    })
  }

  private trustOf(cwd: string): Record<string, unknown> {
    const state = this.forge.projects.trust.state(cwd)
    return { ...state, waiting: waitingParts(cwd, state) }
  }

  discover(): Promise<unknown> {
    return this.guard('discover', () => this.workbench.discover())
  }

  diagnostics(): Promise<unknown> {
    return this.guard('diagnostics', () => this.workbench.diagnostics())
  }

  settings(): Promise<unknown> {
    return this.guard('settings', () => this.workbench.settings())
  }

  saveSettings(request: Record<string, unknown>): Promise<unknown> {
    return this.guard('saveSettings', () => this.workbench.saveSettings(request as never))
  }

  // --- migrating --------------------------------------------------------------

  installPlugin(request: Record<string, unknown>): Promise<unknown> {
    return this.guard('installPlugin', async () => {
      return reportOf(await this.forge.install(required(request, 'path', 'installPlugin'), text(request, 'source') || 'claude-code'))
    })
  }

  migrate(request: Record<string, unknown>): Promise<unknown> {
    return this.guard('migrate', () => this.workbench.migrate(sourceOf(request['source'])))
  }

  setPartEnabled(request: Record<string, unknown>): Promise<unknown> {
    return this.guard('setPartEnabled', async () => {
      const pluginId = required(request, 'pluginId', 'setPartEnabled')
      const componentId = required(request, 'componentId', 'setPartEnabled')
      if (typeof request['enabled'] !== 'boolean') throw new RemoteError('harness-forge/failed', 'enabled must be true or false', { operation: 'setPartEnabled' })
      return { changed: await this.forge.setPartEnabled(pluginId, componentId, request['enabled']) }
    })
  }

  removePlugin(request: Record<string, unknown>): Promise<unknown> {
    return this.guard('removePlugin', async () => {
      const id = required(request, 'id', 'removePlugin')
      if (!await this.forge.uninstall(id)) throw new RemoteError('harness-forge/failed', `no installed plugin ${id}`, { operation: 'removePlugin' })
      return { removed: true }
    })
  }

  marketplaceScan(request: Record<string, unknown>): Promise<unknown> {
    return this.guard('marketplaceScan', () => {
      const index = this.forge.scanMarketplace(required(request, 'path', 'marketplaceScan'))
      return {
        name: index.name,
        description: index.description,
        owner: index.owner,
        manifestPath: index.manifestPath,
        warnings: index.warnings,
        entries: index.entries.map(entry => ({
          name: entry.name,
          description: entry.description,
          version: entry.version,
          license: entry.license,
          category: entry.category,
          tags: entry.tags,
          source: {
            kind: entry.source.kind,
            ...(entry.source.path !== undefined ? { path: entry.source.path } : {}),
            ...(entry.source.url !== undefined ? { url: entry.source.url } : {}),
            ...(entry.source.package !== undefined ? { package: entry.source.package } : {}),
          },
        })),
      }
    })
  }

  marketplaceInstall(request: Record<string, unknown>): Promise<unknown> {
    return this.guard('marketplaceInstall', async () => {
      return reportOf(await this.forge.installMarketplace(required(request, 'path', 'marketplaceInstall'), required(request, 'name', 'marketplaceInstall')))
    })
  }

  // --- sign-in, sessions ------------------------------------------------------

  signIns(): Promise<unknown> {
    return this.guard('signIns', () => ({ waiting: this.row('mcp', 'signIns').pendingSignIns() }))
  }

  signIn(request: Record<string, unknown>): Promise<unknown> {
    return this.guard('signIn', () => {
      const server = required(request, 'server', 'signIn')
      return { server, signInUrl: this.row('mcp', 'signIn').startSignIn(server) }
    })
  }

  sessions(request: Record<string, unknown> | undefined): Promise<unknown> {
    return this.guard('sessions', async () => ({ sessions: await this.row('sessions', 'sessions').sessions(undefined, sourceOf(request?.['source'])) }))
  }

  importSession(request: Record<string, unknown>): Promise<unknown> {
    return this.guard('importSession', () => this.row('sessions', 'importSession').importSession(
      required(request, 'path', 'importSession'),
      text(request, 'targetId') || undefined,
      sourceOf(request['source']),
      text(request, 'sourceId') || undefined,
    ))
  }

  /** Who imports sessions (`{ provider: 'harness-forge' | 'dsh-chat-import', canInstall, command }`). */
  sessionImport(): Promise<unknown> {
    return this.guard('sessionImport', () => sessionImportStatus(this.forge.ctx))
  }

  /** Install and enable dsh-chat-import through DSH's plugin manager; the browser asks the person first. */
  installChatImport(): Promise<unknown> {
    return this.guard('installChatImport', () => installChatImport(this.forge.ctx))
  }

  // --- mod surfaces -------------------------------------------------------------

  /**
   * A session's mod drawings: the current one, then every new one, until the
   * browser stops reading. Ends at once when the session's mods draw nothing.
   */
  async *modSurfaces(request: Record<string, unknown>, signal?: AbortSignal): AsyncIterable<unknown> {
    const session = text(request, 'session')
    const queue: unknown[] = []
    let wake: (() => void) | undefined
    const stop = this.forge.lookup('mods')?.watch(session, (snapshot) => {
      queue.push(snapshot)
      wake?.()
    })
    if (stop === undefined) return
    const aborted = new Promise<void>((resolve) => {
      if (signal?.aborted === true) resolve()
      signal?.addEventListener('abort', () => { resolve() }, { once: true })
    })
    try {
      while (signal?.aborted !== true) {
        while (queue.length > 0) yield queue.shift()
        await Promise.race([new Promise<void>((resolve) => { wake = resolve }), aborted])
        wake = undefined
      }
    } finally {
      stop()
    }
  }

  modAct(request: Record<string, unknown>): Promise<unknown> {
    return this.guard('modAct', () => this.row('mods', 'modAct').act(text(request, 'session'), Number(request['generation']), text(request, 'action'), request['value']))
  }

  modClose(request: Record<string, unknown>): Promise<unknown> {
    return this.guard('modClose', () => this.row('mods', 'modClose').closePane(text(request, 'session'), text(request, 'pane')))
  }

  modMove(request: Record<string, unknown>): Promise<unknown> {
    return this.guard('modMove', () => {
      const kind = request['kind'] === 'scroll' ? 'scroll' : 'focus'
      return this.row('mods', 'modMove').move(text(request, 'session'), kind, request)
    })
  }

  // --- adapter surfaces ---------------------------------------------------------

  /**
   * For an adapter's Node half (not a Remote method): publish a surface its
   * browser half reads through `adapterSurface`, so an adapter needs no HTTP
   * route of its own. `read` gives what the surface shows for one session;
   * `changed(session)` tells the browser to read again.
   */
  registerAdapterSurface(id: string, source: AdapterSurfaceSource): { changed(sessionId: string): void; dispose(): void } {
    this.adapterSurfaces.set(id, source)
    const listeners = this.adapterListeners.get(id) ?? new Set<(sessionId: string) => void>()
    this.adapterListeners.set(id, listeners)
    return {
      changed: (sessionId) => { for (const listener of [...listeners]) listener(sessionId) },
      dispose: () => {
        if (this.adapterSurfaces.get(id) === source) this.adapterSurfaces.delete(id)
      },
    }
  }

  /** What an adapter's surface shows for a session now, read once (a browser half that sets its own pace). */
  async adapterRead(request: Record<string, unknown>): Promise<unknown> {
    const id = required(request, 'adapter', 'adapterRead')
    const source = this.adapterSurfaces.get(id)
    if (source === undefined) throw new RemoteError('harness-forge/failed', `no adapter surface "${id}" is registered in this DSH`, { operation: 'adapterRead' })
    return this.guard('adapterRead', () => source.read(text(request, 'session'), request))
  }

  /**
   * What an adapter's surface shows for a session: now, then again each time
   * the adapter says it changed, until the browser stops reading.
   */
  async *adapterSurface(request: Record<string, unknown>, signal?: AbortSignal): AsyncIterable<unknown> {
    const id = required(request, 'adapter', 'adapterSurface')
    const session = text(request, 'session')
    if (!this.adapterSurfaces.has(id)) throw new RemoteError('harness-forge/failed', `no adapter surface "${id}" is registered in this DSH`, { operation: 'adapterSurface' })
    let pending = true
    let wake: (() => void) | undefined
    const listener = (changed: string): void => {
      if (changed !== session) return
      pending = true
      wake?.()
    }
    const listeners = this.adapterListeners.get(id) ?? new Set<(sessionId: string) => void>()
    this.adapterListeners.set(id, listeners)
    listeners.add(listener)
    const aborted = new Promise<void>((resolve) => {
      if (signal?.aborted === true) resolve()
      signal?.addEventListener('abort', () => { resolve() }, { once: true })
    })
    try {
      while (signal?.aborted !== true) {
        if (pending) {
          pending = false
          const source = this.adapterSurfaces.get(id)
          if (source === undefined) return
          yield await source.read(session, request)
          continue
        }
        await Promise.race([new Promise<void>((resolve) => { wake = resolve }), aborted])
        wake = undefined
      }
    } finally {
      listeners.delete(listener)
    }
  }

  // --- porting ----------------------------------------------------------------

  /**
   * The task a port session starts with (the working protocol, then the part's brief), as Markdown, to preview or
   * copy; `language` is the user's interface language, which the agent is told to talk in.
   */
  portBrief(request: Record<string, unknown>): Promise<unknown> {
    return this.guard('portBrief', () => {
      const porter = this.row('porter', 'portBrief')
      const { plugin, gaps } = this.workbench.findPlugin(required(request, 'pluginId', 'portBrief'))
      return { markdown: porter.task(plugin, gaps, required(request, 'componentId', 'portBrief'), text(request, 'language') || undefined) }
    })
  }

  /**
   * The parts being ported or ported (`{ ports: [{ pluginId, componentId, state, sessionId?, verifiedAt?, adapter? }] }`,
   * `state` `in-progress` or `verified`). A port whose session was deleted is dropped, so the part can be ported again.
   */
  portSessions(): Promise<unknown> {
    return this.guard('portSessions', async () => ({ ports: (await livePorts(this.forge)).map(record => ({ ...record, state: stateOf(record) })) }))
  }

  /** What `harness_verify_port` answers for a part (`{ covered, checks, adapter? }`), recorded the same way. */
  verifyPort(request: Record<string, unknown>): Promise<unknown> {
    return this.guard('verifyPort', () => verifyPort(forgeVerifyDeps(this.forge, this.workbench), required(request, 'pluginId', 'verifyPort'), required(request, 'componentId', 'verifyPort')))
  }

  /**
   * Port one part of a plugin: start a session in DSH's creation mode working
   * on its task in the adapters directory by default (or the given `workspaceId`
   * or `cwd`), and record it as the part's port session.
   */
  portGap(request: Record<string, unknown>): Promise<unknown> {
    return this.guard('portGap', async () => {
      const porter = this.row('porter', 'portGap')
      const { plugin, gaps } = this.workbench.findPlugin(required(request, 'pluginId', 'portGap'))
      const workspaceId = text(request, 'workspaceId')
      const cwd = text(request, 'cwd')
      const location = workspaceId.length > 0 ? { workspaceId } : cwd.length > 0 ? { cwd } : {}
      const { sessionId } = await porter.port(plugin, gaps, required(request, 'componentId', 'portGap'), location, text(request, 'language') || undefined)
      return { sessionId }
    })
  }
}

/** The Remote methods and whether each streams; the client contribution mirrors this list. */
export const REMOTE_METHODS: ReadonlyArray<readonly [string, 'unary' | 'stream', boolean]> = [
  // [method, mode, takes a request]
  ['overview', 'unary', false],
  ['workspaceTrust', 'unary', true],
  ['trustWorkspace', 'unary', true],
  ['trustDecisions', 'unary', false],
  ['dismissTrust', 'unary', true],
  ['discover', 'unary', false],
  ['contextStatus', 'unary', false],
  ['diagnostics', 'unary', false],
  ['settings', 'unary', false],
  ['saveSettings', 'unary', true],
  ['installPlugin', 'unary', true],
  ['migrate', 'unary', true],
  ['setPartEnabled', 'unary', true],
  ['removePlugin', 'unary', true],
  ['marketplaceScan', 'unary', true],
  ['marketplaceInstall', 'unary', true],
  ['signIns', 'unary', false],
  ['signIn', 'unary', true],
  ['sessions', 'unary', true],
  ['importSession', 'unary', true],
  ['sessionImport', 'unary', false],
  ['installChatImport', 'unary', false],
  ['modSurfaces', 'stream', true],
  ['modAct', 'unary', true],
  ['modClose', 'unary', true],
  ['modMove', 'unary', true],
  ['adapterSurface', 'stream', true],
  ['adapterRead', 'unary', true],
  ['portBrief', 'unary', true],
  ['portGap', 'unary', true],
  ['portSessions', 'unary', false],
  ['verifyPort', 'unary', true],
]

/**
 * Attach the same marker the decorator would attach. The decorator's context
 * only calls `addInitializer`; running it against a synthetic instance is the
 * public runtime equivalent.
 */
function markRemote(method: string, mode: 'unary' | 'stream'): void {
  const prototype = HarnessRemoteService.prototype
  const synthetic = Object.create(prototype) as HarnessRemoteService
  const context = {
    kind: 'method' as const,
    name: method,
    static: false,
    private: false,
    addInitializer(initializer: (this: HarnessRemoteService) => void): void {
      initializer.call(synthetic)
    },
  }
  const decorator = mode === 'stream' ? Remote({ name: method, mode: 'stream' }) : Remote(method)
  ;(decorator as unknown as (method: unknown, context: unknown) => void)(prototype[method as keyof HarnessRemoteService], context)
}

for (const [method, mode] of REMOTE_METHODS) markRemote(method, mode)
