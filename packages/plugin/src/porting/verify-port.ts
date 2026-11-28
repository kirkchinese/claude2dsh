/**
 * `harness_verify_port`: whether an installed adapter now covers a plugin
 * part. It reads the adapter packages again, asks DSH's plugin manager whether
 * that package is enabled and its plugins started without a fault, and records
 * the answer for the Gaps screen ("Done — verified", or back to in progress).
 * It also reads the adapter's source for a hard-coded DSH home or a listing of
 * profiles (`adapter-paths.ts`), the brief's data access rules.
 * The creation-mode agent calls it before it reports a port done.
 * @module @kirkchinese/harness-forge/porting
 */
import { existsSync } from 'node:fs'
import { adapterPackageName, type ForeignPlugin } from '@kirkchinese/harness-forge-core'
import { coveringAdapter, type AdapterCoverage } from '../workbench/overview.js'
import { adapterReadiness, managerSnapshot, type PluginManagerLike, type ReadinessCheck } from '../workbench/adapter-coverage.js'
import { PortSessions, type PortRecord } from './port-sessions.js'
import { hardCodedPaths, pathsDetail } from './adapter-paths.js'
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

/** One check of the answer: the adapter's readiness, then its source's paths. */
export interface PortCheck {
  readonly check: ReadinessCheck['check'] | 'paths'
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
      // The decision the workbench overview counts an adapter by.
      checks.push(...adapterReadiness(name, await managerSnapshot(deps.pluginManager)))
    }
    // Only a package whose files are here can be read; an adapter DSH installed always has them.
    if (dir !== undefined && existsSync(dir)) {
      const findings = hardCodedPaths(dir)
      checks.push(check('paths', findings.length === 0, pathsDetail(findings)))
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
