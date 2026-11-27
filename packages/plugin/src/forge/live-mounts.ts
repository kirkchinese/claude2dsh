/**
 * The live registrations of one installed plugin: each mounted action's
 * withdrawal, kept with the component and kind it mounted. Withdrawing reads
 * this snapshot only, so a source that moved, changed or no longer scans is
 * still torn down.
 * @module @kirkchinese/harness-forge
 */
import { messageOf } from '../shared/util.js'
import type { MountKind } from './contract.js'

/** One mounted action that is live. */
export interface LiveMount {
  readonly componentId: string
  readonly kind: MountKind
  readonly dispose: () => Promise<void>
}

/** What a release did: the mounts withdrawn, and those whose withdrawal failed (they stay live). */
export interface Release {
  readonly released: LiveMount[]
  readonly failed: Array<{ readonly actionId: string; readonly mount: LiveMount; readonly reason: string }>
}

/** A plugin's live mounts, by plan action id. */
export class LiveMounts {
  private readonly mounts = new Map<string, LiveMount>()
  /** Withdrawals running now, by action id: an overlapping release waits for the same one. */
  private readonly withdrawing = new Map<string, Promise<string | undefined>>()
  /** Why the last withdrawal of a mount still live failed, by action id. */
  private readonly failures = new Map<string, string>()

  /** @param fault - where a withdrawal that failed is recorded. */
  constructor(private readonly fault?: (error: unknown) => void) {}

  /** Whether the action has a live registration (one being withdrawn, or whose withdrawal failed, still counts). */
  has(actionId: string): boolean {
    return this.mounts.has(actionId)
  }

  /** Why the last withdrawal of a live action failed, if it did. */
  failure(actionId: string): string | undefined {
    return this.failures.get(actionId)
  }

  /** The mounts still live because their last withdrawal failed, with why. */
  stuck(): Array<{ readonly componentId: string; readonly reason: string }> {
    return [...this.failures].flatMap(([actionId, reason]) => {
      const mount = this.mounts.get(actionId)
      return mount === undefined ? [] : [{ componentId: mount.componentId, reason }]
    })
  }

  /** Register a mount. An action still live is never replaced: withdraw it first. */
  add(actionId: string, mount: LiveMount): void {
    if (this.mounts.has(actionId)) throw new Error(`${actionId} is still live: withdraw it first`)
    this.mounts.set(actionId, mount)
  }

  get size(): number {
    return this.mounts.size
  }

  /**
   * Withdraw the mounts that match, each once. A mount leaves the set only
   * when its disposer succeeds; one that fails is recorded as a fault and
   * stays, so a later release retries it. A failing disposer does not stop the others.
   */
  async release(match: (mount: LiveMount, actionId: string) => boolean = () => true): Promise<Release> {
    const result: Release = { released: [], failed: [] }
    for (const [actionId, mount] of [...this.mounts]) {
      if (!match(mount, actionId)) continue
      let withdrawal = this.withdrawing.get(actionId)
      if (withdrawal === undefined) {
        withdrawal = mount.dispose().then(() => {
          if (this.mounts.get(actionId) === mount) this.mounts.delete(actionId)
          this.failures.delete(actionId)
          return undefined
        }, (error: unknown) => {
          this.fault?.(error)
          const reason = messageOf(error)
          this.failures.set(actionId, reason)
          return reason
        }).finally(() => { this.withdrawing.delete(actionId) })
        this.withdrawing.set(actionId, withdrawal)
      }
      const reason = await withdrawal
      if (reason === undefined) result.released.push(mount)
      else result.failed.push({ actionId, mount, reason })
    }
    return result
  }
}
