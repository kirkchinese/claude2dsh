/**
 * The porter row: porting a plugin part Harness Forge cannot run. It writes
 * the part's brief and hands it to DSH's own creation mode, which authors,
 * tests and installs the adapter. With the row off, the workbench offers no
 * porting.
 * @module @kirkchinese/harness-forge/porter
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Disposer, PorterApi } from '../forge/contract.js'
import { FORGE_SERVICE, type HarnessForge } from '../forge/service.js'
import { briefFor, briefTitle, portRuntime, startCreatorSession, taskFor } from './port-gap.js'
import { PortSessions } from './port-sessions.js'
import { rowEffect } from '../forge/row.js'

export const name = 'harness-forge-porter'
export const inject = [FORGE_SERVICE]

/** The porter row. */
export function apply(ctx: Context): void {
  rowEffect(ctx, 'porter', forge => startPorter(ctx, forge))
}

/** Start the porter row on the shared service. Returns its teardown. */
export function startPorter(ctx: Context, forge: HarnessForge): Disposer {
  const sessions = new PortSessions(forge.statePath)
  const api: PorterApi = {
    // Read for each brief: the facts are the profile and home of the session that asks.
    brief: (plugin, gaps, componentId) => briefFor(plugin, gaps, componentId, portRuntime(ctx)),
    task: (plugin, gaps, componentId, language) => taskFor(plugin, gaps, componentId, language, portRuntime(ctx)),
    port: async (plugin, gaps, componentId, location, language) => {
      const runtime = portRuntime(ctx)
      const task = taskFor(plugin, gaps, componentId, language, runtime)
      const started = await startCreatorSession(ctx, task, location, briefTitle(briefFor(plugin, gaps, componentId, runtime)))
      sessions.started(plugin.id, componentId, started.sessionId)
      return started
    },
  }
  return forge.provide('porter', api)
}
