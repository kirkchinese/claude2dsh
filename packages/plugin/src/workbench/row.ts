/**
 * The workbench row: the workbench's Host surface, as Remote methods under
 * the `harnessCompat` namespace, which the client panel calls. A method that
 * needs a row that is off fails with the row's name.
 * @module @kirkchinese/harness-forge/workbench
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Disposer } from '../forge/contract.js'
import { FORGE_SERVICE, type HarnessForge } from '../forge/service.js'
import { HarnessRemoteService } from './remote.js'
import { rowEffect } from '../forge/row.js'

export const name = 'harness-forge-workbench'
export const inject = [FORGE_SERVICE]

/** The workbench row. */
export function apply(ctx: Context): void {
  rowEffect(ctx, 'workbench', forge => startWorkbench(ctx, forge))
}

/** Start the workbench row on the shared service. Returns its teardown. */
export function startWorkbench(ctx: Context, forge: HarnessForge): Disposer {
  // The Remote service registers itself on the row's context and goes with it.
  if (typeof (ctx as { provide?: unknown }).provide === 'function') new HarnessRemoteService(ctx, forge)
  return () => {}
}
