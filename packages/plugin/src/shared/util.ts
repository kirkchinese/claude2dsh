/**
 * Small helpers every part of Harness Forge shares: error text, and the
 * isolation of one part's start and teardown from the others'.
 * @module @kirkchinese/harness-forge
 */

/** Human-safe error text. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A disposer, synchronous or not. */
export type Disposer = () => unknown

/** Where a part's failure goes: the plugin's log. */
export interface FaultLog {
  warn?(...args: unknown[]): void
  info?(...args: unknown[]): void
}

/** The logger of a Cordis context, when it has one. */
export function loggerOf(ctx: object): FaultLog | undefined {
  try {
    return (ctx as { logger?: FaultLog }).logger
  } catch {
    return undefined
  }
}

/**
 * Run every disposer, in order, each awaited and each isolated: one that
 * throws is logged and the rest still run.
 */
export async function disposeAll(log: FaultLog | undefined, label: string, disposers: readonly Disposer[]): Promise<void> {
  for (const dispose of disposers) {
    try {
      await dispose()
    } catch (error: unknown) {
      log?.warn?.(`harness-forge: ${label} teardown step failed: ${messageOf(error)}`)
    }
  }
}
