/**
 * The shared service every Harness Forge row reaches as `harnessForge`: the
 * ledger and its mounters, runtime evidence, the imported settings and the
 * turn-scoped effects of invoked skills and commands (both read by several
 * rows), per-session project assets, and the optional APIs rows offer each
 * other. It holds no DSH listener of its own; the `harness-forge` row does.
 * @module @kirkchinese/harness-forge
 */
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  detectSource,
  dialectOf,
  HarnessError,
  readMarketplace,
  type ForeignPlugin,
  type MarketplaceIndex,
  type Observation,
  type Plan,
} from '@kirkchinese/harness-forge-core'
import { createForeignShell, type ForeignShell } from '../hooks/shell.js'
import { Invocations } from '../shared/invocation.js'
import { fetchGitSource } from './marketplace-install.js'
import { sessionDirectory } from '../dsh/host.js'
import type { InstalledPluginRecord } from './state.js'
import { loggerOf, messageOf } from '../shared/util.js'
import type { Disposer, MountKind, Mounter, RowApis } from './contract.js'
import { Ledger, type ApplyResult, type InstallReport } from './ledger.js'
import { ProjectAssets } from './projects.js'
import { WorkspaceTrust } from './trust.js'
import { ImportedSettings } from './settings.js'

export type { AgentReport, ApplyResult, HookReport, InstallReport, McpReport } from './ledger.js'

/** The service name the `harness-forge` row provides. */
export const FORGE_SERVICE = 'harnessForge'

declare module '@deepseek-ai/cordis' {
  interface Context {
    harnessForge: HarnessForge
  }
}

/** A failure of one row's listener or part, kept for the workbench. */
export interface RowFault {
  readonly row: string
  readonly at: string
  readonly message: string
}

const MAX_FAULTS = 50

/** The shared service. */
export class HarnessForge {
  /** The shell imported hooks, commands and mods run in. */
  readonly shell: ForeignShell
  readonly settings: ImportedSettings
  /** Turn-scoped effects of invoked skills and commands (`allowed-tools`, `model`, `context: fork`, ...). */
  readonly invocations: Invocations
  /** Claude Code and Codex project assets per session. */
  readonly projects: ProjectAssets
  readonly ledger: Ledger
  private readonly apis = new Map<keyof RowApis, unknown>()
  private readonly watchers = new Map<keyof RowApis, Set<{ use: (api: never) => Disposer | void; release?: Disposer | void }>>()
  private readonly recentFaults: RowFault[] = []

  /**
   * @param ctx - the `harness-forge` row's context.
   * @param statePath - the ledger file.
   * @param dataRoot - profile-local writable directory (shims, OAuth state, mod store).
   */
  constructor(readonly ctx: Context, readonly statePath: string, readonly dataRoot: string) {
    this.shell = createForeignShell(process.env, dataRoot)
    this.invocations = new Invocations(ctx, name => this.lookup('agents')?.presetOf(name), (agent, signal) => sessionDirectory(ctx, agent, signal))
    this.settings = new ImportedSettings(sessionId => this.invocations.rules(sessionId))
    this.ledger = new Ledger(ctx, statePath, dataRoot, error => this.fault('ledger', error))
    this.projects = new ProjectAssets(this.ledger, dataRoot, new WorkspaceTrust(statePath), error => this.fault('projects', error))
    this.ledger.registerMounter('settings', {
      mount: async ({ component, scope }) => {
        if (component.kind !== 'settings') throw new HarnessError('component-failed', `action expects settings: ${component.id}`)
        const dispose = this.settings.apply(component, scope.sessionId)
        return {
          outcome: { componentId: component.id, status: 'mounted', level: 'L1b', evidence: 'source', ...(component.description !== undefined ? { message: component.description } : {}) },
          disposer: async () => { dispose() },
        }
      },
    })
  }

  /** A session's working directory, as hooks and commands see it. */
  directory(agent: unknown, signal: AbortSignal): Promise<string> {
    return sessionDirectory(this.ctx, agent, signal)
  }

  // ---------------------------------------------------------------------------
  // Rows
  // ---------------------------------------------------------------------------

  /** Register the mounter of one kind of component; see {@link Ledger.registerMounter}. */
  registerMounter(kind: MountKind, mounter: Mounter): Disposer {
    return this.ledger.registerMounter(kind, mounter)
  }

  /** Offer a row's API to the other rows while the row runs. */
  provide<K extends keyof RowApis>(name: K, api: RowApis[K]): Disposer {
    if (this.apis.has(name)) throw new Error(`the ${name} row's API is already provided`)
    this.apis.set(name, api)
    for (const watcher of this.watchers.get(name) ?? []) watcher.release = this.use(name, watcher.use as (api: RowApis[K]) => Disposer | void, api)
    return () => {
      if (this.apis.get(name) !== api) return
      this.apis.delete(name)
      for (const watcher of this.watchers.get(name) ?? []) {
        const release = watcher.release
        watcher.release = undefined
        this.release(name, release)
      }
    }
  }

  /** A row's API, or undefined while that row is off. */
  lookup<K extends keyof RowApis>(name: K): RowApis[K] | undefined {
    return this.apis.get(name) as RowApis[K] | undefined
  }

  /**
   * Use a row's API whenever it is there: `use` runs now if the row runs, and
   * again each time it starts; what `use` returns is released when the row
   * stops or the returned disposer runs.
   */
  watch<K extends keyof RowApis>(name: K, use: (api: RowApis[K]) => Disposer | void): Disposer {
    const watcher: { use: (api: never) => Disposer | void; release?: Disposer | void } = { use: use as (api: never) => Disposer | void }
    const watchers = this.watchers.get(name) ?? new Set()
    this.watchers.set(name, watchers)
    watchers.add(watcher)
    const api = this.lookup(name)
    if (api !== undefined) watcher.release = this.use(name, use, api)
    return () => {
      watchers.delete(watcher)
      this.release(name, watcher.release)
    }
  }

  private use<K extends keyof RowApis>(name: K, use: (api: RowApis[K]) => Disposer | void, api: RowApis[K]): Disposer | void {
    try {
      return use(api)
    } catch (error: unknown) {
      this.fault(name, error)
      return undefined
    }
  }

  private release(name: keyof RowApis, release: Disposer | void): void {
    try {
      release?.()
    } catch (error: unknown) {
      this.fault(name, error)
    }
  }

  /** Record a row's failure (a listener that threw, a part that did not start) for the workbench. */
  fault(row: string, error: unknown): void {
    this.recentFaults.push({ row, at: new Date().toISOString(), message: messageOf(error) })
    if (this.recentFaults.length > MAX_FAULTS) this.recentFaults.splice(0, this.recentFaults.length - MAX_FAULTS)
  }

  /** The latest row failures, oldest first. */
  faults(): readonly RowFault[] {
    return [...this.recentFaults]
  }

  /** Runtime evidence for one component. */
  observe(componentId: string, signal: string, ok: boolean, detail: string): void {
    this.ledger.observe(componentId, { signal, ok, at: new Date().toISOString(), detail } satisfies Observation)
  }

  /** Withdraw a condition that no longer holds, such as a sign-in that completed. */
  clearObservation(componentId: string, signal: string): void {
    this.ledger.observe(componentId, { clear: signal })
  }

  // ---------------------------------------------------------------------------
  // Ledger
  // ---------------------------------------------------------------------------

  /**
   * Restore the durable ledger, then install `preload` roots. An entry may
   * name the dialect to read a multi-harness root as: `codex:<path>`. It
   * takes the ledger's queue at once, so no install or removal can run
   * before the ledger is restored (and write a ledger without its records).
   */
  start(preload: readonly string[] = []): Promise<void> {
    return this.ledger.exclusive(async () => {
      await this.ledger.restoreNow()
      for (const entry of preload) {
        const prefix = /^([a-z][a-z0-9-]*):(.+)$/u.exec(entry)
        const dialect = prefix !== null && dialectOf(prefix[1]!) !== undefined ? prefix : undefined
        const root = dialect?.[2] ?? entry
        try {
          await this.ledger.applyNow(this.ledger.planNow(root, dialect?.[1] ?? detectSource(resolve(root))))
        } catch (error: unknown) {
          loggerOf(this.ctx)?.warn?.(`harness-forge: preload failed for ${root}: ${messageOf(error)}`)
        }
      }
    })
  }

  /** Settles once every queued install, restore and re-apply (a row that just started mounting) is done. */
  async ready(): Promise<void> {
    let queue: Promise<unknown>
    do {
      queue = this.ledger.queue
      await queue
    } while (queue !== this.ledger.queue)
  }

  /** Build a pure plan for one plugin. */
  plan(root: string, source?: string): Plan {
    return this.ledger.planNow(root, source)
  }

  /** Apply a plan previously returned by {@link plan}. */
  applyById(planId: string): Promise<ApplyResult> {
    const plan = this.ledger.plans.get(planId)
    if (plan === undefined) {
      return Promise.reject(new HarnessError('plan-not-found', `no plan with id ${planId}`, { suggestion: 'Scan again and review the new plan.' }))
    }
    return this.apply(plan)
  }

  /** Apply one reviewed plan. Re-scans the root and refuses a changed source. */
  apply(plan: Plan): Promise<ApplyResult> {
    return this.ledger.exclusive(() => this.ledger.applyNow(plan))
  }

  /** Plan and apply one plugin root. */
  async install(root: string, source?: string): Promise<InstallReport> {
    const result = await this.ledger.exclusive(() => this.ledger.applyNow(this.ledger.planNow(root, source)))
    return this.ledger.report(result)
  }

  /** Read a marketplace index without installing anything. */
  scanMarketplace(path: string): MarketplaceIndex {
    return readMarketplace(path)
  }

  /** Install one marketplace entry from a local path or git source. */
  async installMarketplace(path: string, name: string): Promise<InstallReport> {
    const index = readMarketplace(path)
    const entry = index.entries.find(candidate => candidate.name === name)
    if (entry === undefined) throw new HarnessError('marketplace-failed', `marketplace ${index.name} has no entry "${name}"`)
    if (entry.source.kind === 'path' && entry.source.path !== undefined) return this.install(entry.source.path, marketplaceDialect(index))
    if (entry.source.kind === 'git') {
      const root = await fetchGitSource(entry.source, join(this.dataRoot, 'marketplace-cache'))
      return this.install(root, marketplaceDialect(index))
    }
    throw new HarnessError('unsupported-source', `entry "${name}" uses ${entry.source.kind}; supported marketplace sources are local path and git`)
  }

  /** Undo the actions of one receipt and remove its live registrations. */
  undo(receiptId: string): Promise<boolean> {
    return this.ledger.exclusive(() => this.ledger.undoNow(receiptId))
  }

  /** Switch one part of an installed plugin off or on again; it stays so across restarts. */
  setPartEnabled(pluginId: string, componentId: string, enabled: boolean): Promise<boolean> {
    return this.ledger.exclusive(() => this.ledger.setEnabledNow(pluginId, componentId, enabled))
  }

  /** Remove one installation and every registration it owns. */
  uninstall(id: string): Promise<boolean> {
    return this.ledger.exclusive(async () => {
      if (!await this.ledger.teardown(id)) return false
      this.ledger.persist()
      return true
    })
  }

  /** Scan one plugin without writing anything. */
  scan(root: string, source?: string): ForeignPlugin {
    return this.ledger.scan(root, source)
  }

  /** List current installations in stable name order. */
  list(): readonly InstalledPluginRecord[] {
    return this.ledger.list()
  }

  /** Drop every runtime registration without rewriting the durable ledger. */
  async dispose(): Promise<void> {
    const ledger = this.ledger
    if (ledger.disposed) return
    ledger.disposed = true
    await ledger.queue.catch(() => undefined)
    if (ledger.persistTimer !== undefined) {
      clearTimeout(ledger.persistTimer)
      ledger.persistTimer = undefined
      ledger.persist()
    }
    // A withdrawal that fails here is recorded as a fault; the others still go.
    for (const id of [...ledger.live.keys()]) await ledger.teardown(id).catch(() => undefined)
    await this.projects.dispose()
  }
}

/** Infer the dialect of a marketplace index from its manifest location. */
export function marketplaceDialect(index: MarketplaceIndex): string {
  const normalized = index.manifestPath.replace(/\\/gu, '/')
  if (normalized.includes('/.agents/plugins/')) return 'codex'
  if (normalized.includes('/.claude-plugin/')) return 'claude-code'
  return 'agent-plugins'
}
