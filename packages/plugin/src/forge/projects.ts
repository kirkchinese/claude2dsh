/**
 * Project assets, loaded for each session from the directory it starts in:
 * Claude Code's `.claude/` and `.mcp.json`, and Codex's `.codex/`
 * (`config.toml` MCP servers and agent roles, `agents/*.toml`).
 * Nothing is installed: a session in a project gets that project's commands,
 * agents, MCP servers, hooks, permission rules and `env`, scoped to its own
 * agent context, and loses them when it ends. Skills of the project are
 * listed to every session whose directory is inside it.
 *
 * Parts that run code or reach the network (hooks, MCP servers, `!` shell
 * lines, settings that grant tools or set the environment) wait until the
 * workspace is trusted: see `trust.ts`. Restrictions never wait: a settings
 * file's `deny` and `ask` rules and `disableAllHooks: true` apply at once,
 * and only its `allow` rules and `env` wait.
 *
 * The mount runs from the broker's `agent/created` listener before any
 * SessionStart hook, and DSH holds the first turn until that listener
 * returns, so the first model request already sees the project.
 * @module @kirkchinese/harness-forge
 */
import type { Context } from '@deepseek-ai/cordis'
import { appendRecord } from '../dsh/session-records.js'
import { homedir } from 'node:os'
import {
  claudeMcpApproval,
  dialects,
  isInside,
  planPlugin,
  restrictiveSettings,
  trustRequirement,
  type ComponentOutcome,
  type ForeignComponent,
  type ForeignPlugin,
  type PlanAction,
} from '@kirkchinese/harness-forge-core'
import { appendNotice } from '../hooks/notice.js'
import { pluginDataDir } from '../mcp/mount.js'
import { messageOf } from '../shared/util.js'
import { mountKindOf, type MountKind, type Mounter, type MountScope } from './contract.js'
import { failedToSwitchOff, inactive, type Ledger } from './ledger.js'
import { LiveMounts } from './live-mounts.js'
import { WAITING_FOR_APPROVAL, WAITING_FOR_TRUST, type WorkspaceTrust, type WorkspaceTrustState } from './trust.js'

interface AgentLike {
  readonly ctx?: unknown
  readonly session: { readonly header: { readonly id: string; readonly cwd?: string; readonly delegationDepth?: number } }
}

/** The project assets one session runs with. */
export interface ProjectSession {
  readonly sessionId: string
  readonly root: string
  readonly plugin: ForeignPlugin
  readonly outcomes: readonly ComponentOutcome[]
}

/** A project part that waits for the workspace to be trusted (or its MCP server approved). */
export interface WaitingPart {
  readonly pluginId: string
  readonly componentId: string
  readonly kind: ForeignComponent['kind']
  readonly name: string
  /** What it would do: run hook commands, start an MCP server, … */
  readonly does: string
  readonly message: string
}

interface Mount extends ProjectSession {
  readonly agent: AgentLike
  readonly scope: MountScope
  readonly cwd: string
  readonly workspace: string
  readonly outcomes: ComponentOutcome[]
  readonly live: LiveMounts
  readonly commandNames: Map<string, string>
  /** Parts held back, by component id. */
  readonly waiting: Set<string>
  /** Parts whose mount went stale (trust changed while it ran) and were rolled back: the next reconcile decides them again. */
  readonly unsettled: Set<string>
}

export type { ProjectRecord } from '../dsh/session-records.js'

/** Whether a project part may run now: undefined when it may, else the outcome it gets instead. */
function gate(component: ForeignComponent, plugin: ForeignPlugin, cwd: string, trust: WorkspaceTrustState): ComponentOutcome | undefined {
  if (trustRequirement(component) === undefined) return undefined
  const waiting = (message: string): ComponentOutcome => ({ componentId: component.id, status: 'inactive', level: 'L0', evidence: 'source', message })
  if (!trust.trusted) return waiting(WAITING_FOR_TRUST)
  // A `.mcp.json` server: Claude Code's rejection always holds; its approval is needed unless the person trusted the workspace here.
  if (component.kind === 'mcp' && plugin.source === 'claude-code' && component.metadata?.['scope'] === 'project') {
    const approval = claudeMcpApproval(component.name, trust.workspace, cwd, true, homedir())
    if (approval === 'disabled') return { componentId: component.id, status: 'skipped', level: 'L0', evidence: 'source', message: 'disabled in Claude Code (disabledMcpjsonServers)', skippedBy: 'disabled-in-claude-code' }
    if (approval === 'pending' && !trust.sources.includes('forge')) return waiting(WAITING_FOR_APPROVAL)
  }
  return undefined
}

/** The project assets of a directory, one plugin per dialect that has any. */
function projectPlugins(cwd: string): ForeignPlugin[] {
  return dialects().map(dialect => dialect.projectAssets?.(cwd, homedir())).filter((plugin): plugin is ForeignPlugin => plugin !== undefined)
}

/** The parts of a directory's project assets that wait for trust (or approval) now. */
export function waitingParts(cwd: string, trust: WorkspaceTrustState): WaitingPart[] {
  return projectPlugins(cwd).flatMap(plugin => plugin.components.flatMap((component) => {
    const outcome = gate(component, plugin, cwd, trust)
    if (outcome?.status !== 'inactive') return []
    return [{ pluginId: plugin.id, componentId: component.id, kind: component.kind, name: component.name, does: trustRequirement(component) ?? '', message: outcome.message ?? '' }]
  }))
}

/**
 * Per-session project assets, mounted through the same mounters as installed
 * plugins, in the session's scope. Parts that run code or reach the network
 * wait until the workspace is trusted; trusting it here mounts them in the
 * sessions already open in it.
 */
export class ProjectAssets {
  private readonly mounts = new Map<string, Promise<Mount[]>>()
  /** Each session's mounts, once its first mount finished. */
  private readonly settled = new Map<string, Mount[]>()
  /** Mounts of ended sessions whose withdrawal failed: kept, and withdrawn again on every trust change, release and at dispose. */
  private readonly retained = new Map<string, Mount[]>()
  /** Mounting, reconciling and releasing run one at a time, in the order they were asked for. */
  private chain: Promise<unknown> = Promise.resolve()
  /** Bumped on every trust change: a mount that was running across one is stale. */
  private generation = 0
  private readonly stopTrust: () => void

  constructor(private readonly ledger: Ledger, private readonly dataRoot: string, readonly trust: WorkspaceTrust, private readonly fault?: (error: unknown) => void) {
    this.stopTrust = trust.onChange((workspace) => {
      this.generation += 1
      void this.serial(() => this.reconcile(workspace)).catch((error: unknown) => this.fault?.(error))
    })
  }

  /** A directory's trust now, with the generation it belongs to: read together, with no await between. */
  private snapshot(cwd: string): { trust: WorkspaceTrustState; generation: number } {
    return { trust: this.trust.state(cwd), generation: this.generation }
  }

  /** Run `task` after everything asked for before it. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task)
    this.chain = run.catch(() => undefined)
    return run
  }

  /**
   * Trust (or stop trusting) a workspace in Harness Forge, and return once its
   * open sessions have mounted or withdrawn what changed, with the parts in it
   * whose withdrawal failed: they are still live, and setting trust again retries.
   */
  async setTrust(cwd: string, trusted: boolean): Promise<{ decision: WorkspaceTrustState; stillLive: Array<{ readonly componentId: string; readonly reason: string }> }> {
    const { workspace } = this.trust.set(cwd, trusted)
    await this.chain
    const mounts = [...this.settled.values(), ...this.retained.values()].flat().filter(mount => isInside(workspace, mount.workspace))
    return { decision: this.trust.state(cwd), stillLive: mounts.flatMap(mount => mount.live.stuck()) }
  }

  /**
   * Mount the project assets of a new top-level session, once: every caller
   * (the `harness-forge` row, the hooks row before SessionStart) waits for
   * the same mount.
   */
  prepare(agent: AgentLike, cwd: string): Promise<void> {
    const sessionId = agent.session.header.id
    if ((agent.session.header.delegationDepth ?? 0) > 0) return Promise.resolve()
    let pending = this.mounts.get(sessionId)
    if (pending === undefined) {
      pending = this.serial(() => this.mountAll(agent, cwd))
      this.mounts.set(sessionId, pending)
    }
    return pending.then(() => undefined, () => undefined)
  }

  /** The workspaces of the open sessions, with their trust and what waits for it. */
  async workspaces(): Promise<Array<WorkspaceTrustState & { readonly cwd: string; readonly waiting: readonly WaitingPart[] }>> {
    const byWorkspace = new Map<string, string>()
    for (const pending of this.mounts.values()) {
      for (const mount of await pending.catch(() => [])) if (!byWorkspace.has(mount.workspace)) byWorkspace.set(mount.workspace, mount.cwd)
    }
    return [...byWorkspace.values()].map((cwd) => {
      const state = this.trust.state(cwd)
      return { ...state, cwd, waiting: waitingParts(cwd, state) }
    })
  }

  private async mountAll(agent: AgentLike, cwd: string): Promise<Mount[]> {
    const plugins = projectPlugins(cwd)
    const scoped = agent.ctx as Context | undefined
    if (plugins.length === 0 || scoped === undefined) return []
    const scope: MountScope = { ctx: scoped, sessionId: agent.session.header.id }
    const { workspace } = this.trust.state(cwd)
    const mounts: Mount[] = []
    for (const plugin of plugins) {
      const mount: Mount = {
        sessionId: agent.session.header.id,
        root: plugin.root,
        plugin,
        agent,
        scope,
        cwd,
        workspace,
        outcomes: [],
        live: new LiveMounts((error: unknown) => this.fault?.(error)),
        commandNames: new Map(),
        waiting: new Set(),
        unsettled: new Set(),
      }
      await this.mountParts(mount, this.snapshot(cwd), plugin.components.map(component => component.id))
      mounts.push(mount)
    }
    this.settled.set(agent.session.header.id, mounts)
    return mounts
  }

  /**
   * Trust changed for a workspace: mount what now may run in its open
   * sessions, and withdraw what no longer may (trust revoked). Ended
   * sessions' parts whose withdrawal failed are withdrawn again, never mounted.
   */
  private async reconcile(workspace: string): Promise<void> {
    // Runs in the chain: every session mounted before it has settled, and those after read the new trust themselves.
    for (const [sessionId, mounts] of [...this.retained]) await this.withdrawEnded(sessionId, mounts)
    for (const mount of [...this.settled.values()].flat()) {
      if (!isInside(workspace, mount.workspace) && mount.unsettled.size === 0) continue
      const trust = this.trust.state(mount.cwd)
      const changed = mount.plugin.components.filter((component) => {
        if (mount.unsettled.has(component.id)) return true
        if (trustRequirement(component) === undefined) return false
        const held = gate(component, mount.plugin, mount.cwd, trust)?.status === 'inactive'
        return held !== mount.waiting.has(component.id)
      }).map(component => component.id)
      if (changed.length === 0) continue
      // A part now held back is withdrawn first (a settings part stays, restricted); one now allowed replaces its restricted form.
      await mount.live.release(live => changed.includes(live.componentId))
      // Trust may have changed during the withdrawal: mount by what holds after it.
      await this.mountParts(mount, this.snapshot(mount.cwd), changed)
    }
  }

  /** Mount the given parts of a session's project assets that may run; the others wait. */
  private async mountParts(mount: Mount, initial: { trust: WorkspaceTrustState; generation: number }, componentIds: readonly string[]): Promise<void> {
    let { trust, generation } = initial
    const { plugin, scope, agent } = mount
    const plan = planPlugin(plugin)
    const components = new Map(plugin.components.map(component => [component.id, component]))
    const wanted = new Set(componentIds)
    const outcomes = new Map(mount.outcomes.map(outcome => [outcome.componentId, outcome]))
    const used = new Map<Mounter, MountKind>()
    const mountedNow: string[] = []
    for (const action of plan.actions) {
      const component = action.componentId === undefined ? undefined : components.get(action.componentId)
      if (component === undefined || !wanted.has(component.id)) continue
      const kind = mountKindOf(action, component)
      if (typeof kind !== 'string') {
        outcomes.set(component.id, { componentId: component.id, status: 'skipped', level: 'L0', evidence: 'source', message: kind.skipped })
        continue
      }
      // Its withdrawal failed: it stays live as it was, and the next reconcile retries.
      const stuck = mount.live.has(action.id) ? mount.live.failure(action.id) : undefined
      if (stuck !== undefined) {
        outcomes.set(component.id, failedToSwitchOff(component.id, stuck))
        mount.unsettled.add(component.id)
        continue
      }
      // Trust changed since this began: decide the rest by what holds now.
      if (generation !== this.generation) {
        trust = this.trust.state(mount.cwd)
        generation = this.generation
      }
      const held = gate(component, plugin, mount.cwd, trust)
      // Only what reduces privilege is applied while the rest waits.
      const restricted = held?.status === 'inactive' && component.kind === 'settings' ? restrictiveSettings(component) : undefined
      if (held !== undefined && restricted === undefined) {
        outcomes.set(component.id, held)
        if (held.status === 'inactive') mount.waiting.add(component.id)
        mount.unsettled.delete(component.id)
        continue
      }
      if (held !== undefined) mount.waiting.add(component.id)
      else mount.waiting.delete(component.id)
      const mounter = this.ledger.mounters.get(kind)
      if (mounter === undefined) {
        outcomes.set(component.id, inactive(component.id, kind))
        continue
      }
      used.set(mounter, kind)
      try {
        const applied = await mounter.mount({
          action,
          component: restricted ?? component,
          plugin,
          dataDir: pluginDataDir(this.dataRoot, plugin.id),
          scope,
          commandNames: mount.commandNames,
          takenNames: () => this.ledger.allCommandNames(),
        })
        if (generation !== this.generation) {
          // Trust changed while it mounted. A part that needed trust is rolled back; the reconcile queued behind decides it again.
          mount.unsettled.add(component.id)
          if (held === undefined && trustRequirement(component) !== undefined) {
            // Withdrawn through the live set, so a withdrawal that fails stays tracked and is retried.
            if (applied.disposer !== undefined) mount.live.add(action.id, { componentId: component.id, kind, dispose: applied.disposer })
            const { failed } = await mount.live.release((_live, actionId) => actionId === action.id)
            mount.waiting.add(component.id)
            outcomes.set(component.id, failed[0] !== undefined ? failedToSwitchOff(component.id, failed[0].reason) : { componentId: component.id, status: 'inactive', level: 'L0', evidence: 'source', message: WAITING_FOR_TRUST })
            continue
          }
        } else mount.unsettled.delete(component.id)
        outcomes.set(component.id, held !== undefined ? { ...held, message: `${held.message ?? ''}; its deny and ask rules already apply` } : applied.outcome)
        mountedNow.push(component.id)
        if (applied.disposer !== undefined) mount.live.add(action.id, { componentId: component.id, kind, dispose: applied.disposer })
      } catch (error: unknown) {
        outcomes.set(component.id, { componentId: component.id, status: 'failed', level: 'L0', evidence: 'runtime', message: messageOf(error) })
      }
    }
    // The first model request must offer every project agent.
    for (const [mounter, kind] of used) {
      await mounter.settle?.(scope).catch((error: unknown) => {
        for (const id of mountedNow) {
          const outcome = outcomes.get(id)
          const component = components.get(id)
          const action = plan.actions.find((candidate: PlanAction) => candidate.componentId === id)
          if (outcome?.status !== 'mounted' || component === undefined || action === undefined || mountKindOf(action, component) !== kind) continue
          outcomes.set(id, { ...outcome, status: 'failed', level: 'L0', evidence: 'runtime', message: `the ${kind} mount did not settle: ${messageOf(error)}` })
        }
      })
    }
    mount.outcomes.splice(0, mount.outcomes.length, ...plugin.components.flatMap(component => outcomes.get(component.id) ?? []))
    try {
      appendRecord(agent.session, 'plugin:harness-forge/project', {
        root: plugin.root,
        pluginId: plugin.id,
        components: plugin.components.map(component => ({ id: component.id, kind: component.kind, name: component.name })),
        outcomes: mount.outcomes,
      })
    } catch {
      // The record is informational.
    }
    const failed = mount.outcomes.filter(outcome => outcome.status === 'failed' && wanted.has(outcome.componentId))
    const names = new Map(plugin.components.map(component => [component.id, `${component.kind} ${component.name}`]))
    const harness = plugin.source === 'codex' ? 'Codex' : 'Claude Code'
    if (failed.length > 0) {
      appendNotice(agent.session, {
        kind: 'hook-error',
        event: 'ProjectAssets',
        plugin: plugin.id,
        text: `${harness} project assets of ${plugin.root}: ${failed.map(outcome => `${names.get(outcome.componentId) ?? outcome.componentId}: ${outcome.message ?? 'failed'}`).join('; ')}`,
      })
    }
    const waiting = [...mount.waiting].filter(id => wanted.has(id))
    if (waiting.length > 0) {
      appendNotice(agent.session, {
        kind: 'system-message',
        event: 'ProjectAssets',
        plugin: plugin.id,
        text: `${harness} project assets of ${plugin.root} that run code wait until you trust ${trust.workspace} (Harness Forge → Migrated): ${waiting.map(id => names.get(id) ?? id).join(', ')}`,
      })
    }
  }

  /** Withdraw a session's project assets. */
  async release(sessionId: string): Promise<void> {
    if (!this.mounts.has(sessionId) && !this.retained.has(sessionId)) return
    this.mounts.delete(sessionId)
    await this.serial(async () => {
      const mounts = this.settled.get(sessionId) ?? this.retained.get(sessionId) ?? []
      this.settled.delete(sessionId)
      await this.withdrawEnded(sessionId, mounts)
    })
  }

  /** Withdraw an ended session's mounts; those whose withdrawal fails are retained, to be tried again. */
  private async withdrawEnded(sessionId: string, mounts: readonly Mount[]): Promise<void> {
    const left: Mount[] = []
    for (const mount of mounts) if ((await mount.live.release()).failed.length > 0) left.push(mount)
    if (left.length > 0) {
      this.retained.set(sessionId, left)
      return
    }
    this.retained.delete(sessionId)
    if (mounts.length === 0) return
    for (const mounter of this.ledger.mounters.values()) await mounter.release?.({ sessionId }).catch((error: unknown) => this.fault?.(error))
  }

  async dispose(): Promise<void> {
    this.stopTrust()
    for (const id of new Set([...this.mounts.keys(), ...this.retained.keys()])) await this.release(id)
  }
}
