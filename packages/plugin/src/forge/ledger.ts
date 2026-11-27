/**
 * The ledger: installing, restoring, undoing and removing plugins, the record
 * that survives restarts, and the mounters each row registers for its kind
 * of component. A component whose row is off waits as `inactive` and mounts
 * as soon as the row's mounter is registered; a row that goes away withdraws
 * its components back to `inactive`.
 * @module @kirkchinese/harness-forge
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  assess,
  dialects,
  fingerprintPlugin,
  HarnessError,
  planPlugin,
  scanRoot,
  shortHash,
  type CompatibilityVector,
  type ComponentOutcome,
  type ForeignComponent,
  type ForeignPlugin,
  type Observation,
  type Plan,
  type Receipt,
  type ReceiptAction,
  type ReceiptComponent,
} from '@kirkchinese/harness-forge-core'
import { pluginDataDir } from '../mcp/mount.js'
import { writeReceipt, readReceipt } from './receipts.js'
import { messageOf } from '../shared/util.js'
import { mountKindOf, ROW_OF_KIND, type MountKind, type Mounter, type MountScope } from './contract.js'
import { LiveMounts } from './live-mounts.js'
import {
  isTransient,
  readState,
  receiptsDirectory,
  retryFile,
  writeState,
  type CompatState,
  type InstalledComponentRecord,
  type InstalledPluginRecord,
  type MountRecord,
} from './state.js'

/** One MCP mount outcome. */
export interface McpReport {
  readonly name: string
  readonly status: 'mounted' | 'failed'
  readonly error?: string
}

/** One hooks mount outcome. */
export interface HookReport {
  readonly name: string
  readonly dialect: 'claude-code' | 'codex'
  readonly status: 'mounted' | 'failed'
  readonly error?: string
}

/** One agent preset outcome. */
export interface AgentReport {
  readonly name: string
  readonly presetId: string
  readonly status: 'mounted' | 'failed'
  readonly error?: string
}

/** Result of one apply. */
export interface ApplyResult {
  readonly plugin: ForeignPlugin
  readonly compat: CompatibilityVector
  readonly receipt: Receipt
  readonly outcomes: readonly ComponentOutcome[]
  readonly alreadyInstalled: boolean
}

/** Result of installing one plugin (plan + apply). */
export interface InstallReport extends ApplyResult {
  readonly skillRoots: readonly string[]
  readonly commands: readonly string[]
  readonly mcp: readonly McpReport[]
  readonly hooks: readonly HookReport[]
  readonly agents: readonly AgentReport[]
}

/** One live installation and its live registrations, by plan action. */
export interface LiveInstall {
  record: InstalledPluginRecord
  readonly mounts: LiveMounts
  readonly outcomes: Map<string, ComponentOutcome>
  plan?: Plan
  /** A first install that failed but left registrations live: listed, never written, withdrawn on removal or the next install. */
  readonly unrecorded?: true
}

/** Observations kept per component: the newest per signal, bounded. */
const MAX_OBSERVATIONS = 96
const PERSIST_DELAY_MS = 500
const GLOBAL_SCOPE: MountScope = {}

/** The outcome of a component whose row is off. */
export function inactive(componentId: string, kind: MountKind): ComponentOutcome {
  return { componentId, status: 'inactive', level: 'L0', evidence: 'source', message: `inactive because the ${ROW_OF_KIND[kind]} row is off` }
}

/** What an outcome's message says when the person switched the component off. */
export const SWITCHED_OFF = 'switched off'

/** The outcome of a component the person switched off. */
export function switchedOff(componentId: string): ComponentOutcome {
  return { componentId, status: 'inactive', level: 'L0', evidence: 'source', message: SWITCHED_OFF }
}

/** The outcome of a component whose withdrawal failed: it stays live, and switching it off again retries. */
export function failedToSwitchOff(componentId: string, reason: string): ComponentOutcome {
  return { componentId, status: 'failed', level: 'L0', evidence: 'runtime', message: `failed to switch off: ${reason}` }
}

/** The outcome of a component a failed install could not withdraw: it stays live until removing the plugin (or installing it again) withdraws it. */
export function failedToCleanUp(componentId: string, reason: string): ComponentOutcome {
  return { componentId, status: 'failed', level: 'L0', evidence: 'runtime', message: `failed to clean up after a failed install: ${reason}` }
}

function skipped(componentId: string, message: string): ComponentOutcome {
  return { componentId, status: 'skipped', level: 'L0', evidence: 'source', message }
}

/**
 * The installations: the in-memory registry, plan application, undo and
 * teardown, runtime evidence and the durable ledger, every mutation through
 * one queue.
 */
export class Ledger {
  readonly live = new Map<string, LiveInstall>()
  readonly plans = new Map<string, Plan>()
  readonly mounters = new Map<MountKind, Mounter>()
  disposed = false
  queue: Promise<unknown> = Promise.resolve()
  persistTimer: NodeJS.Timeout | undefined
  /** Why the ledger could not be read at startup; while set, it is never written. */
  private unreadLedger: string | undefined

  constructor(
    readonly ctx: Context,
    readonly statePath: string,
    readonly dataRoot: string,
    /** Where a withdrawal that failed is recorded (the shared service's faults). */
    private readonly fault?: (error: unknown) => void,
  ) {}

  private readonly faultOf = (error: unknown): void => { this.fault?.(error) }

  /**
   * Register the mounter of one kind: components of that kind waiting as
   * inactive mount now. The disposer withdraws them back to inactive.
   */
  registerMounter(kind: MountKind, mounter: Mounter): () => void {
    if (this.mounters.has(kind)) throw new HarnessError('internal', `a mounter for ${kind} is already registered`)
    this.mounters.set(kind, mounter)
    this.reapply()
    return () => {
      if (this.mounters.get(kind) !== mounter) return
      this.mounters.delete(kind)
      if (!this.disposed) void this.exclusive(() => this.withdraw(kind))
    }
  }

  /**
   * Re-apply installed plans; only actions without a live registration run.
   * Called when a mounter appears.
   */
  reapply(): void {
    if (this.disposed) return
    void this.exclusive(async () => {
      if (this.disposed) return
      for (const install of [...this.live.values()]) {
        if (install.plan === undefined) continue
        try {
          await this.applyNow(install.plan)
        } catch {
          // The ledger keeps the previous outcome; the next re-apply runs again.
        }
      }
    })
  }

  /**
   * Withdraw every mount of one kind (its row went away): those components
   * wait as inactive. The live registrations say what to withdraw, so a source
   * that no longer scans is withdrawn as well.
   */
  private async withdraw(kind: MountKind): Promise<void> {
    if (this.disposed) return
    let changed = false
    for (const install of this.live.values()) {
      const components = new Set<string>()
      const { released, failed } = await install.mounts.release(candidate => candidate.kind === kind)
      for (const mount of released) components.add(mount.componentId)
      const stuck = new Set(failed.map(failure => failure.mount.componentId))
      // A component of the kind that mounted nothing to withdraw (it failed, say) waits as inactive too.
      const plugin = this.tryScan(install)
      if (plugin !== undefined) {
        const byId = new Map(plugin.components.map(component => [component.id, component]))
        for (const action of install.plan?.actions ?? []) {
          const component = action.componentId === undefined ? undefined : byId.get(action.componentId)
          if (component !== undefined && mountKindOf(action, component) === kind) components.add(component.id)
        }
      }
      let touched = false
      for (const componentId of components) {
        if (install.record.disabled?.includes(componentId) === true || stuck.has(componentId)) continue
        install.outcomes.set(componentId, inactive(componentId, kind))
        touched = true
      }
      for (const { mount, reason } of failed) {
        install.outcomes.set(mount.componentId, failedToSwitchOff(mount.componentId, reason))
        touched = true
      }
      if (touched) {
        this.refreshRecord(install, plugin)
        changed = true
      }
    }
    if (changed) this.persist()
  }

  /** The plugin as its source scans now, or undefined when it no longer does. */
  private tryScan(install: LiveInstall): ForeignPlugin | undefined {
    try {
      return this.scanRoot(install.record.root, install.record.source)
    } catch {
      return undefined
    }
  }

  /**
   * The record's derived fields after its outcomes changed. Without the
   * scanned plugin (its source is gone) only the outcomes are updated.
   */
  private refreshRecord(install: LiveInstall, plugin: ForeignPlugin | undefined = this.tryScan(install)): void {
    if (plugin === undefined) {
      install.record = { ...install.record, outcomes: [...install.outcomes.values()] }
      return
    }
    install.record = {
      ...install.record,
      skillRoots: skillRootsOf(plugin, install.outcomes),
      outcomes: [...install.outcomes.values()],
      compat: assess(plugin, [...install.outcomes.values()]),
      mounts: mountsFor(plugin, install.outcomes),
    }
  }

  /** Scan one plugin without writing anything. */
  scan(root: string, source?: string): ForeignPlugin {
    return this.scanRoot(resolve(root), source)
  }

  /** List current installations in stable name order. */
  list(): readonly InstalledPluginRecord[] {
    return [...this.live.values()].map(install => install.record).sort((a, b) => a.name.localeCompare(b.name, 'en'))
  }

  // ---------------------------------------------------------------------------
  // Queue-owned operations
  // ---------------------------------------------------------------------------

  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation)
    this.queue = run.catch(() => undefined)
    return run
  }

  async restoreNow(): Promise<void> {
    let state: CompatState
    try {
      state = await retryFile(() => readState(this.statePath))
    } catch (error: unknown) {
      // Writing now would replace the ledger with what is live: nothing. Every write is refused until it is read.
      this.unreadLedger = messageOf(error)
      throw error
    }
    this.unreadLedger = undefined
    for (const record of state.plugins) {
      if (this.live.has(record.id)) continue
      if (!existsSync(record.root)) {
        this.keepUnrestored(record, `source directory is missing: ${record.root}`)
        continue
      }
      try {
        const plan = this.planNow(record.root, record.source)
        if (record.fingerprint !== undefined && plan.fingerprint.digest !== record.fingerprint.digest) {
          // The source changed while DSH was closed; apply its current content.
          this.live.set(record.id, { record, mounts: new LiveMounts(this.faultOf), outcomes: new Map() })
        } else {
          this.live.set(record.id, {
            record,
            mounts: new LiveMounts(this.faultOf),
            outcomes: new Map((record.outcomes ?? []).map(outcome => [outcome.componentId, outcome])),
          })
        }
        await this.applyNow(plan)
      } catch (error: unknown) {
        this.keepUnrestored(record, messageOf(error))
      }
    }
    this.persist()
  }

  /** Keep a record that could not be restored visible, with the reason. */
  private keepUnrestored(record: InstalledPluginRecord, reason: string): void {
    const outcomes = (record.outcomes ?? []).map(outcome => ({ ...outcome, status: 'failed' as const, message: `not restored: ${reason}` }))
    this.live.set(record.id, {
      record: { ...record, outcomes, mounts: [] },
      mounts: new LiveMounts(this.faultOf),
      outcomes: new Map(outcomes.map(outcome => [outcome.componentId, outcome])),
    })
  }

  planNow(root: string, source?: string): Plan {
    const plugin = this.scanRoot(resolve(root), source)
    // A manifest that does not parse means the plugin is not what its author wrote: nothing of it is installed.
    const invalid = plugin.warnings.find(warning => warning.code === 'manifest-invalid' || warning.code === 'manifest-schema-unknown')
    if (invalid !== undefined) {
      throw new HarnessError('manifest-invalid', `${plugin.root}: ${invalid.message}; the plugin was not imported`, { suggestion: 'Fix the manifest and import it again.' })
    }
    const plan = planPlugin(plugin)
    this.plans.set(plan.id, plan)
    return plan
  }

  async applyNow(plan: Plan): Promise<ApplyResult> {
    this.assertAlive()
    const plugin = this.scanRoot(plan.root, plan.source)
    const fingerprint = fingerprintPlugin(plugin)
    if (fingerprint.digest !== plan.fingerprint.digest) {
      throw new HarnessError('fingerprint-mismatch', `source changed since the plan was created: ${plan.root}`, {
        suggestion: 'Scan again and review the new plan.',
      })
    }
    // A failed install left registrations live: they are withdrawn before anything is installed over them.
    if (this.live.get(plan.pluginId)?.unrecorded === true) await this.teardown(plan.pluginId)
    const existing = this.live.get(plan.pluginId)
    const components = new Map(plugin.components.map(component => [component.id, component]))
    const outcomes = new Map<string, ComponentOutcome>(existing?.outcomes ?? [])
    const mounts = existing?.mounts ?? new LiveMounts(this.faultOf)
    /** The actions this apply registered: withdrawn again when the apply cannot be recorded. */
    const added = new Set<string>()
    const disabled = new Set(existing?.record.disabled ?? [])
    const commandNames = new Map<string, string>()
    for (const component of plugin.components) {
      const prior = outcomes.get(component.id)
      // A mounted command keeps its name across restarts; a failed one carries an error instead.
      if (component.kind === 'command' && (prior?.status === 'mounted' || prior?.status === 'verified') && prior.message !== undefined) {
        commandNames.set(component.id, prior.message)
      }
    }
    const receiptId = randomUUID()
    const startedAt = new Date().toISOString()
    const receiptActions: ReceiptAction[] = []
    const used = new Set<Mounter>()

    for (const action of plan.actions) {
      const component = action.componentId === undefined ? undefined : components.get(action.componentId)
      if (component === undefined) {
        receiptActions.push({ actionId: action.id, kind: action.kind, name: action.name, status: 'failed' })
        continue
      }
      if (mounts.has(action.id)) {
        receiptActions.push({ actionId: action.id, kind: action.kind, name: action.name, status: 'skipped' })
        continue
      }
      if (disabled.has(component.id)) {
        outcomes.set(component.id, switchedOff(component.id))
        receiptActions.push({ actionId: action.id, kind: action.kind, name: action.name, status: 'skipped' })
        continue
      }
      const prior = outcomes.get(component.id)
      const kind = mountKindOf(action, component)
      if (typeof kind !== 'string') {
        outcomes.set(component.id, skipped(component.id, kind.skipped))
        receiptActions.push({ actionId: action.id, kind: action.kind, name: action.name, status: 'skipped' })
        continue
      }
      const mounter = this.mounters.get(kind)
      if (mounter === undefined) {
        outcomes.set(component.id, inactive(component.id, kind))
        receiptActions.push({ actionId: action.id, kind: action.kind, name: action.name, status: 'skipped' })
        continue
      }
      used.add(mounter)
      try {
        const applied = await mounter.mount({
          action,
          component,
          plugin,
          dataDir: pluginDataDir(this.dataRoot, plugin.id),
          scope: GLOBAL_SCOPE,
          commandNames,
          takenNames: () => this.allCommandNames(plugin.id),
        })
        if (applied.disposer !== undefined) {
          mounts.add(action.id, { componentId: component.id, kind, dispose: applied.disposer })
          added.add(action.id)
        }
        // Runtime evidence gathered before a restart stays attached to the component.
        outcomes.set(component.id, prior?.observations === undefined || applied.outcome.status === 'skipped'
          ? applied.outcome
          : withObservations(applied.outcome, prior.observations))
        receiptActions.push({
          actionId: action.id,
          kind: action.kind,
          name: action.name,
          status: applied.outcome.status === 'skipped' ? 'skipped' : 'applied',
          ...(applied.outcome.message !== undefined ? { undoToken: applied.outcome.message } : {}),
        })
      } catch (error: unknown) {
        const info = error instanceof HarnessError ? error.toJSON() : { code: 'runtime-failed' as const, message: messageOf(error) }
        outcomes.set(component.id, { componentId: component.id, status: 'failed', level: 'L0', evidence: 'runtime', message: info.message })
        receiptActions.push({ actionId: action.id, kind: action.kind, name: action.name, status: 'failed', error: info })
      }
    }

    // The delegation tool restarts on each agent change; the next request must see them all.
    for (const mounter of used) await mounter.settle?.(GLOBAL_SCOPE).catch(() => undefined)
    let record: InstalledPluginRecord
    let receipt: Receipt
    let applied: boolean
    try {
      record = this.buildRecord(plugin, plan, existing, outcomes, commandNames, receiptId)
      const receiptComponents: ReceiptComponent[] = [...outcomes.values()].map(outcome => ({
        componentId: outcome.componentId,
        status: outcome.status,
        level: outcome.level,
        ...(outcome.message !== undefined ? { message: outcome.message } : {}),
      }))
      const failed = receiptActions.some(action => action.status === 'failed')
      applied = receiptActions.some(action => action.status === 'applied')
      receipt = {
        id: receiptId,
        planId: plan.id,
        pluginId: plugin.id,
        root: plugin.root,
        status: failed ? (applied ? 'partial' : 'failed') : 'applied',
        startedAt,
        finishedAt: new Date().toISOString(),
        actions: receiptActions,
        components: receiptComponents,
        achieved: record.compat?.achieved ?? assess(plugin, [...outcomes.values()]).achieved,
      }
      await retryFile(() => writeReceipt(receipt, receiptsDirectory(this.statePath)))
      this.live.set(plugin.id, { record, mounts, outcomes, plan })
      await retryFile(() => this.writeLedger())
    } catch (error: unknown) {
      // Nothing of this apply is recorded: what it registered is withdrawn, so no live code is left untracked.
      const { failed } = await mounts.release((_mount, actionId) => added.has(actionId))
      for (const mounter of used) await mounter.settle?.(GLOBAL_SCOPE).catch(() => undefined)
      if (failed.length > 0) {
        // A registration whose withdrawal failed is never dropped: its install stays listed, with why, and owns it.
        const kept: LiveInstall = existing ?? { record: { ...this.buildRecord(plugin, plan, undefined, new Map(), commandNames, receiptId), receipts: [] }, mounts, outcomes: new Map(), unrecorded: true }
        for (const { mount, reason } of failed) kept.outcomes.set(mount.componentId, failedToCleanUp(mount.componentId, reason))
        this.refreshRecord(kept, plugin)
        this.live.set(plugin.id, kept)
      } else if (existing !== undefined) this.live.set(plugin.id, existing)
      else this.live.delete(plugin.id)
      throw error
    }
    return {
      plugin,
      compat: record.compat ?? assess(plugin, [...outcomes.values()]),
      receipt,
      outcomes: [...outcomes.values()],
      alreadyInstalled: existing !== undefined && !applied,
    }
  }

  async undoNow(receiptId: string): Promise<boolean> {
    let found: { install: LiveInstall; receipt: Receipt } | undefined
    for (const install of this.live.values()) {
      if (!install.record.receipts?.includes(receiptId)) continue
      const receipt = readReceipt(receiptId, receiptsDirectory(this.statePath))
      if (receipt !== undefined) {
        found = { install, receipt }
        break
      }
    }
    if (found === undefined) return false
    const { install, receipt } = found
    const planActions = new Map(install.plan?.actions.map(action => [action.id, action]) ?? [])
    const stuck: string[] = []
    for (const action of receipt.actions) {
      const componentId = planActions.get(action.actionId)?.componentId
      if (action.status !== 'applied') {
        if (componentId !== undefined && install.outcomes.get(componentId)?.status === 'skipped') install.outcomes.delete(componentId)
        continue
      }
      const { failed } = await install.mounts.release((_mount, actionId) => actionId === action.actionId)
      for (const { mount, reason } of failed) {
        install.outcomes.set(mount.componentId, failedToSwitchOff(mount.componentId, reason))
        stuck.push(`${mount.componentId}: failed to switch off: ${reason}`)
      }
      if (componentId !== undefined && failed.length === 0) install.outcomes.delete(componentId)
    }
    if (stuck.length > 0) {
      // The receipt stays applied: undoing it again retries.
      this.refreshRecord(install)
      this.persist()
      throw new HarnessError('runtime-failed', `undo incomplete: ${stuck.join('; ')}`, { suggestion: 'Undo it again to retry.' })
    }
    await retryFile(() => writeReceipt({ ...receipt, status: 'undone', finishedAt: new Date().toISOString() }, receiptsDirectory(this.statePath)))
    if (install.outcomes.size === 0) {
      this.live.delete(install.record.id)
      this.persist()
      return true
    }
    this.refreshRecord(install)
    install.record = { ...install.record, receipts: install.record.receipts?.filter(id => id !== receiptId) ?? [] }
    this.persist()
    return true
  }

  /**
   * Switch one component of an installed plugin off (its registrations are
   * released and it stays off across restarts) or on again (it mounts as at
   * install). Returns whether anything changed.
   */
  async setEnabledNow(pluginId: string, componentId: string, enabled: boolean): Promise<boolean> {
    this.assertAlive()
    const install = this.live.get(pluginId)
    if (install === undefined) throw new HarnessError('not-installed', `no installed plugin ${pluginId}`)
    // Switching off needs no scan: a source that changed or went away is still switched off.
    const known = install.outcomes.has(componentId)
      || install.plan?.actions.some(action => action.componentId === componentId) === true
      || (enabled && this.scanRoot(install.record.root, install.record.source).components.some(candidate => candidate.id === componentId))
    if (!known) throw new HarnessError('not-installed', `${pluginId} has no part ${componentId}`)
    const disabled = new Set(install.record.disabled ?? [])
    if (disabled.has(componentId) === !enabled) return false
    if (enabled) disabled.delete(componentId)
    else disabled.add(componentId)
    install.record = { ...install.record, disabled: [...disabled] }
    if (enabled) {
      install.outcomes.delete(componentId)
      await this.applyNow(install.plan ?? this.planNow(install.record.root, install.record.source))
      return true
    }
    const settle = new Set<Mounter>()
    const { released, failed } = await install.mounts.release(candidate => candidate.componentId === componentId)
    for (const mount of released) {
      const mounter = this.mounters.get(mount.kind)
      if (mounter !== undefined) settle.add(mounter)
    }
    for (const mounter of settle) await mounter.settle?.(GLOBAL_SCOPE).catch(() => undefined)
    if (failed.length > 0) {
      // Still live: it is not recorded as off, so switching it off again retries.
      disabled.delete(componentId)
      install.record = { ...install.record, disabled: [...disabled] }
      const outcome = failedToSwitchOff(componentId, failed.map(failure => failure.reason).join('; '))
      install.outcomes.set(componentId, outcome)
      this.refreshRecord(install)
      this.persist()
      throw new HarnessError('runtime-failed', `${componentId}: ${outcome.message ?? ''}`, { suggestion: 'Switch it off again to retry.' })
    }
    install.outcomes.set(componentId, switchedOff(componentId))
    this.refreshRecord(install)
    this.persist()
    return true
  }

  /** Release one installation without deciding whether the ledger survives. */
  async teardown(id: string): Promise<boolean> {
    const install = this.live.get(id)
    if (install === undefined) return false
    const { failed } = await install.mounts.release()
    if (failed.length > 0) {
      // The installation stays, with what is still live shown as failed: removing it again retries.
      const stillLive = install.unrecorded === true ? failedToCleanUp : failedToSwitchOff
      for (const { mount, reason } of failed) install.outcomes.set(mount.componentId, stillLive(mount.componentId, reason))
      this.refreshRecord(install)
      throw new HarnessError('runtime-failed', `${id}: ${failed.map(({ mount }) => `${mount.componentId}: ${install.outcomes.get(mount.componentId)?.message ?? ''}`).join('; ')}`, { suggestion: 'Remove it again to retry.' })
    }
    this.live.delete(id)
    return true
  }

  // ---------------------------------------------------------------------------
  // Evidence
  // ---------------------------------------------------------------------------

  /** Record one runtime observation; the component's status follows its evidence. */
  observe(componentId: string, observation: Observation | { readonly clear: string }): void {
    for (const install of this.live.values()) {
      const prior = install.outcomes.get(componentId)
      if (prior === undefined) continue
      const next = 'clear' in observation
        ? withObservations(prior, (prior.observations ?? []).filter(item => item.signal !== observation.clear))
        : withObservations(prior, [...prior.observations ?? [], observation])
      install.outcomes.set(componentId, next)
      this.refreshRecord(install)
      this.persistSoon()
      return
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  scanRoot(root: string, source?: string): ForeignPlugin {
    // A harness's user directory (`~/.claude`, `~/.codex`) is the user's own assets, not a plugin.
    for (const dialect of dialects()) {
      if (dialect.user === undefined || resolve(root) !== resolve(dialect.user.root(homedir())) || (source !== undefined && source !== dialect.id)) continue
      const user = dialect.user.scan(homedir())
      if (user === undefined) throw new HarnessError('manifest-not-found', `${root} ${dialect.user.emptyMessage}`)
      return user
    }
    const plugin = scanRoot(root, source)
    // Another installed plugin has this name: this one gets a stable suffix from its root, so both are installed.
    const holder = this.live.get(plugin.id)
    if (holder === undefined || samePath(holder.record.root, root)) return plugin
    const name = `${plugin.name}-${shortHash(resolve(root).toLowerCase(), 6)}`
    const renamed = scanRoot(root, plugin.source, { name })
    return { ...renamed, warnings: [...renamed.warnings, { code: 'name-conflict', message: `a plugin named ${plugin.name} is already installed from ${holder.record.root}; this one is installed as ${name}` }] }
  }

  private buildRecord(
    plugin: ForeignPlugin,
    plan: Plan,
    existing: LiveInstall | undefined,
    outcomes: Map<string, ComponentOutcome>,
    commandNames: Map<string, string>,
    receiptId: string,
  ): InstalledPluginRecord {
    const components: InstalledComponentRecord[] = plugin.components.map(component => ({
      kind: component.kind,
      name: component.kind === 'command'
        ? commandNames.get(component.id) ?? component.name
        : component.kind === 'mcp' || component.kind === 'agent'
          ? outcomes.get(component.id)?.message ?? component.name
          : component.name,
      ...(component.path !== undefined ? { path: component.path } : {}),
    }))
    return {
      id: plugin.id,
      source: plugin.source,
      name: plugin.name,
      root: plugin.root,
      ...(plugin.version !== undefined ? { version: plugin.version } : {}),
      ...(plugin.license !== undefined ? { license: plugin.license } : {}),
      installedAt: existing?.record.installedAt ?? new Date().toISOString(),
      planId: plan.id,
      fingerprint: plan.fingerprint,
      components,
      skillRoots: skillRootsOf(plugin, outcomes),
      mounts: mountsFor(plugin, outcomes),
      compat: assess(plugin, [...outcomes.values()]),
      outcomes: [...outcomes.values()],
      receipts: [...(existing?.record.receipts ?? []), receiptId],
      ...(existing?.record.disabled !== undefined && existing.record.disabled.length > 0 ? { disabled: existing.record.disabled } : {}),
    }
  }

  report(result: ApplyResult): InstallReport {
    const components = new Map(result.plugin.components.map(component => [component.id, component]))
    const mcp: McpReport[] = []
    const hooks: HookReport[] = []
    const agents: AgentReport[] = []
    for (const outcome of result.outcomes) {
      if (outcome.status === 'skipped' || outcome.status === 'inactive') continue
      const component = components.get(outcome.componentId)
      if (component === undefined) continue
      const status = outcome.status === 'failed' ? 'failed' as const : 'mounted' as const
      const error = outcome.status === 'failed' && outcome.message !== undefined ? { error: outcome.message } : {}
      if (component.kind === 'mcp') mcp.push({ name: outcome.message ?? component.name, status, ...error })
      if (component.kind === 'hooks') hooks.push({ name: component.name, dialect: result.plugin.source === 'codex' ? 'codex' : 'claude-code', status, ...error })
      if (component.kind === 'agent') agents.push({ name: component.name, presetId: outcome.message ?? '', status, ...error })
    }
    const record = this.live.get(result.plugin.id)?.record
    return {
      ...result,
      skillRoots: record?.skillRoots ?? [],
      commands: record?.components.filter(component => component.kind === 'command').map(component => component.name) ?? [],
      mcp,
      hooks,
      agents,
    }
  }

  allCommandNames(excludePluginId?: string): Set<string> {
    const names = new Set<string>()
    for (const [id, install] of this.live) {
      if (id === excludePluginId) continue
      for (const component of install.record.components) if (component.kind === 'command') names.add(component.name)
    }
    return names
  }

  private assertAlive(): void {
    if (this.disposed) throw new HarnessError('internal', 'Harness Forge service is disposed')
  }

  private persistSoon(): void {
    if (this.persistTimer !== undefined) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined
      this.persist()
    }, PERSIST_DELAY_MS)
    this.persistTimer.unref?.()
  }

  /** Write the ledger, or try again shortly when the write fails transiently. */
  persist(): void {
    try {
      this.writeLedger()
    } catch (error: unknown) {
      if (!isTransient(error)) throw error
      this.persistSoon()
    }
  }

  private writeLedger(): void {
    if (this.unreadLedger !== undefined) {
      throw new HarnessError('internal', `the ledger could not be read at startup (${this.unreadLedger}); nothing is written over it`, {
        suggestion: 'Fix or move aside .harness-forge/state.json, then restart DSH.',
      })
    }
    const state: CompatState = { schemaVersion: 2, plugins: [...this.live.values()].filter(install => install.unrecorded !== true).map(install => install.record) }
    writeState(state, this.statePath)
  }
}

/** The same directory, whatever the case or separators (Windows paths are case-insensitive). */
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)
}

/**
 * Attach observations to an outcome: the newest per signal, bounded. A
 * component with any currently failing signal is `failed`; one whose every
 * observed signal succeeded is `verified`. Mount alone stays `mounted`.
 */
function withObservations(outcome: ComponentOutcome, observations: readonly Observation[]): ComponentOutcome {
  const latest = new Map<string, Observation>()
  for (const observation of observations) {
    latest.delete(observation.signal)
    latest.set(observation.signal, observation)
  }
  const kept = [...latest.values()].slice(-MAX_OBSERVATIONS)
  if (outcome.status === 'skipped' || outcome.status === 'inactive') return outcome
  if (kept.length === 0) {
    const { observations: _dropped, ...rest } = outcome
    return { ...rest, status: 'mounted', evidence: 'source' }
  }
  // `message` keeps the mount identity (command name, server, preset); the
  // failing observations carry their own details.
  return {
    ...outcome,
    observations: kept,
    status: kept.some(observation => !observation.ok) ? 'failed' : 'verified',
    evidence: 'runtime',
  }
}

/** The directory a skill provider root must contain for this skill body. */
export function skillRootOf(bodyPath: string): string {
  return /[\\/]SKILL\.md$/iu.test(bodyPath) ? dirname(dirname(bodyPath)) : dirname(bodyPath)
}

/** The skill roots of a plugin's mounted skills. */
function skillRootsOf(plugin: ForeignPlugin, outcomes: ReadonlyMap<string, ComponentOutcome>): string[] {
  const roots = new Set<string>()
  for (const component of plugin.components) {
    const status = outcomes.get(component.id)?.status
    if (component.kind === 'skill' && (status === 'mounted' || status === 'verified')) roots.add(skillRootOf(component.bodyPath))
  }
  return [...roots].sort((a, b) => a.localeCompare(b, 'en'))
}

/** Project the current component outcomes into the workbench mount list. */
export function mountsFor(plugin: ForeignPlugin, outcomes: ReadonlyMap<string, ComponentOutcome>): MountRecord[] {
  const mounts: MountRecord[] = []
  for (const [componentId, outcome] of outcomes) {
    const component: ForeignComponent | undefined = plugin.components.find(candidate => candidate.id === componentId)
    if (component === undefined) continue
    if (component.kind !== 'mcp' && component.kind !== 'hooks' && component.kind !== 'agent' && component.kind !== 'code') continue
    if (outcome.status === 'skipped' || outcome.status === 'inactive') continue
    mounts.push({
      kind: component.kind === 'agent' ? 'agent' : component.kind === 'code' ? 'code' : component.kind === 'mcp' ? 'mcp' : 'hooks',
      name: component.name,
      status: outcome.status === 'failed' ? 'failed' : 'mounted',
      ...(outcome.status === 'failed' && outcome.message !== undefined ? { error: outcome.message } : {}),
    })
  }
  return mounts
}
