/**
 * `harness_verify_port`: whether an installed adapter now covers a plugin
 * part. It reads the adapter packages again, asks DSH's plugin manager whether
 * that package is enabled and its plugins started without a fault, and records
 * the answer for the Gaps screen ("Done — verified", or back to in progress).
 * The creation-mode agent calls it before it reports a port done.
 * @module @kirkchinese/harness-forge/porting
 */
import { adapterPackageName, type ForeignPlugin } from '@kirkchinese/harness-forge-core'
import { coveringAdapter, type AdapterCoverage } from '../workbench/overview.js'
import { bundleState, type PluginManagerLike } from '../workbench/adapter-coverage.js'
import { PortSessions, type PortRecord } from './port-sessions.js'
import { dshService } from '../dsh/host.js'
import type { HarnessForge } from '../forge/service.js'
import type { Workbench } from '../workbench/workbench.js'

export type { PluginManagerLike }

/** What verification reads. */
export interface VerifyDeps {
  findPlugin(id: string): { readonly plugin: ForeignPlugin }
  adapters(): readonly AdapterCoverage[]
  /** Absent when the profile composes no plugin manager. */
  readonly pluginManager: PluginManagerLike | undefined
  readonly sessions: PortSessions
}

export interface PortCheck {
  readonly check: 'declared' | 'enabled' | 'loaded'
  readonly ok: boolean
  readonly detail: string
}

/** The tool's answer. */
export interface PortVerification {
  /** All checks passed: the Gaps screen now shows the part as done. */
  readonly covered: boolean
  readonly pluginId: string
  readonly componentId: string
  readonly plugin: string
  readonly part: string
  readonly adapter?: string
  readonly checks: readonly PortCheck[]
}

const check = (name: PortCheck['check'], ok: boolean, detail: string): PortCheck => ({ check: name, ok, detail })

/** Whether the package's plugins started: every row it declares has a live entry, active, without a startup failure. */
async function loaded(manager: PluginManagerLike, rows: ReadonlyArray<{ readonly rowId: string; readonly entryId?: string }>): Promise<PortCheck> {
  if (rows.length === 0) return check('loaded', true, 'its bundle declares no plugin rows, so nothing has to start')
  const entries = new Map((await manager.listPlugins()).map(entry => [entry.entryId, entry]))
  const problems: string[] = []
  for (const row of rows) {
    const entry = row.entryId === undefined ? undefined : entries.get(row.entryId)
    if (entry === undefined) problems.push(`row "${row.rowId}" has no running entry`)
    else if (entry.diagnostic !== undefined) problems.push(`row "${row.rowId}" failed to start: ${entry.diagnostic}`)
    else if (!entry.enabled) problems.push(`row "${row.rowId}" is disabled`)
    else if (entry.fiberPhase !== 'active') problems.push(`row "${row.rowId}" is ${entry.fiberPhase ?? 'not running'}`)
  }
  return problems.length === 0
    ? check('loaded', true, `all ${String(rows.length)} plugin row(s) of its bundle are active, without startup failures`)
    : check('loaded', false, problems.join('; '))
}

/**
 * Verify that an adapter covers one part, and record the answer.
 * @param callerSession - the session that asked, linked to the part when no port session was recorded for it.
 */
export async function verifyPort(deps: VerifyDeps, pluginId: string, componentId: string, callerSession?: string): Promise<PortVerification> {
  const { plugin } = deps.findPlugin(pluginId)
  const component = plugin.components.find(item => item.id === componentId)
  if (component === undefined) throw new Error(`${plugin.name} has no part ${componentId}; its parts are ${plugin.components.map(item => item.id).join(', ')}`)
  const base = { pluginId, componentId, plugin: plugin.name, part: component.name }
  const adapters = deps.adapters()
  const name = coveringAdapter(plugin, component, adapters)
  const checks: PortCheck[] = []
  if (name === undefined) {
    checks.push(check('declared', false, `no package installed in this DSH profile declares this part: its package.json needs "harnessForge": { "ports": [${JSON.stringify({ plugin: plugin.name, component: component.name })}] } (or the package is named ${adapterPackageName(plugin, component)}), and it must be installed with plugin_manager install_bundle`))
  } else {
    const dir = adapters.find(adapter => adapter.name === name)?.dir
    checks.push(check('declared', true, `${name}${dir !== undefined ? ` (${dir})` : ''} declares it`))
    if (deps.pluginManager === undefined) {
      checks.push(check('enabled', false, 'this DSH profile composes no plugin manager, so whether the adapter is enabled cannot be checked'))
    } else {
      // The criterion the workbench overview counts an adapter by (`bundleState`).
      const status = bundleState(name, await deps.pluginManager.listBundles())
      if (status.state === 'unlisted') checks.push(check('enabled', false, `${name} is on disk but DSH does not list it as an installed bundle: install it with plugin_manager install_bundle (a link left by a failed install does not count), and check that its package.json declares a bundle (dsh-doc references/host-plugin.md)`))
      else if (status.state === 'off') checks.push(check('enabled', false, `${name} is installed but switched off: enable it with plugin_manager set_bundle`))
      else if (status.state === 'broken') checks.push(check('enabled', false, `${name} is enabled but its bundle cannot load: ${status.error.code}${status.error.diagnostic !== undefined ? ` — ${status.error.diagnostic}` : ''}`))
      else {
        checks.push(check('enabled', true, `${name} is enabled`))
        checks.push(await loaded(deps.pluginManager, status.bundle.rows))
      }
    }
  }
  const covered = checks.every(item => item.ok)
  if (covered && name !== undefined) {
    if (deps.sessions.get(pluginId, componentId) === undefined && callerSession !== undefined) deps.sessions.started(pluginId, componentId, callerSession)
    deps.sessions.verified(pluginId, componentId, name)
  } else {
    deps.sessions.unverified(pluginId, componentId)
  }
  return { covered, ...base, ...(name !== undefined ? { adapter: name } : {}), checks }
}

/** Verification against this Harness Forge and the DSH it runs in. */
export function forgeVerifyDeps(forge: HarnessForge, workbench: Workbench): VerifyDeps {
  return {
    findPlugin: id => workbench.findPlugin(id),
    adapters: () => workbench.adapters(),
    pluginManager: dshService(forge.ctx, 'pluginManager') as PluginManagerLike | undefined,
    sessions: new PortSessions(forge.statePath),
  }
}

/**
 * The recorded port sessions, without those whose session was deleted (when
 * the profile composes a session controller that can list them).
 */
export async function livePorts(forge: HarnessForge): Promise<PortRecord[]> {
  const sessions = new PortSessions(forge.statePath)
  const controller = dshService(forge.ctx, 'sessionController') as { list?(request: object, signal: AbortSignal): Promise<{ items: ReadonlyArray<{ sessionId: string }> }> } | undefined
  if (controller?.list === undefined) return sessions.list()
  const existing = new Set((await controller.list({}, AbortSignal.timeout(30_000))).items.map(item => item.sessionId))
  return sessions.prune(id => existing.has(id))
}
