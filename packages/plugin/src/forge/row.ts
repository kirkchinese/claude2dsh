/**
 * What every capability row does the same way: find the shared service,
 * start isolated (a row that throws while starting is logged and recorded,
 * and the other rows go on), and report its listeners' failures.
 * @module @kirkchinese/harness-forge
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ComponentOutcome, ForeignComponent } from '@kirkchinese/harness-forge-core'
import { reportFaults } from '../dsh/host.js'
import type { Disposer } from './contract.js'
import { FORGE_SERVICE, type HarnessForge } from './service.js'
import { disposeAll, loggerOf, messageOf } from '../shared/util.js'

/** A component's outcome once mounted: `mounted` at most; only a runtime observation upgrades it. */
export function mounted(component: ForeignComponent, level: ComponentOutcome['level'], message?: string): ComponentOutcome {
  return { componentId: component.id, status: 'mounted', level, evidence: 'source', ...(message !== undefined ? { message } : {}) }
}

/**
 * Run one row on the shared service for as long as the row's context lives.
 * A start that throws is logged and recorded as the row's fault; its
 * listeners' failures are recorded too.
 */
export function rowEffect(ctx: Context, row: string, start: (forge: HarnessForge) => Disposer): void {
  ctx.effect(() => {
    const forge = ctx.get(FORGE_SERVICE) as HarnessForge | undefined
    if (forge === undefined) return () => {}
    const stopReporting = reportFaults(ctx, (error) => { forge.fault(row, error) })
    let stop: Disposer = () => {}
    try {
      stop = start(forge)
    } catch (error: unknown) {
      loggerOf(ctx)?.warn?.(`harness-forge: the ${row} row did not start: ${messageOf(error)}`)
      forge.fault(row, error)
    }
    return () => disposeAll(loggerOf(ctx), row, [stop, stopReporting])
  }, `harness-forge.${row}`)
}

/**
 * The parts one row starts, each isolated: a part that throws is logged and
 * recorded and the row's other parts start; teardown runs every part's
 * disposer, last started first, each isolated too.
 */
export class Parts {
  private readonly disposers: Disposer[] = []

  constructor(private readonly ctx: Context, private readonly forge: HarnessForge, private readonly row: string) {}

  add(label: string, start: () => Disposer | void): void {
    try {
      const dispose = start()
      if (dispose !== undefined) this.disposers.push(dispose)
    } catch (error: unknown) {
      loggerOf(this.ctx)?.warn?.(`harness-forge: ${this.row}: ${label} did not start: ${messageOf(error)}`)
      this.forge.fault(this.row, error)
    }
  }

  dispose(): Promise<void> {
    return disposeAll(loggerOf(this.ctx), this.row, this.disposers.splice(0).reverse())
  }
}
