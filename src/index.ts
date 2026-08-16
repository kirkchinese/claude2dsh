/**
 * In-memory session-source adapter registry and read-only Cordis plugin.
 *
 * This stage defines registration and lifecycle behavior only. It does not
 * discover, parse, import, or write session data.
 *
 * @module claude2dsh
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Session-source adapters available to import-capable plugins. */
    sessionSources: SessionSourceRegistry
  }
}

/** Stable identity and display metadata for one session-source adapter. */
export interface SessionSourceAdapter {
  /** Case-sensitive registry key owned by the adapter implementation. */
  readonly id: string
  /** Human-readable source name for diagnostics and future selection UIs. */
  readonly displayName: string
}

/** Releases one adapter registration and settles after Cordis cleanup. */
export type SessionSourceRegistration = () => Promise<void>

/** Error raised when an adapter attempts to claim an occupied source id. */
export class DuplicateSessionSourceError extends Error {
  /** Stable machine-readable duplicate-registration code. */
  readonly code = 'DUPLICATE_SESSION_SOURCE' as const

  /**
   * @param id - source id already owned by another live registration.
   */
  constructor(readonly id: string) {
    super(
      `a session-source adapter with id ${JSON.stringify(id)} is already registered`,
    )
    this.name = 'DuplicateSessionSourceError'
  }
}

/**
 * Lifecycle-aware registry for future session-source adapters.
 *
 * Registrations are Cordis effects. Explicit disposal or disposal of the
 * registering plugin fiber removes the adapter.
 */
export class SessionSourceRegistry extends Service {
  private readonly adapters = new Map<string, SessionSourceAdapter>()

  /** Explicit operating mode validated from the plugin configuration. */
  readonly mode: Config['mode']

  /**
   * @param ctx - provider context whose fiber owns the service.
   * @param mode - validated operating mode; this release accepts read-only only.
   */
  constructor(ctx: Context, mode: Config['mode']) {
    super(ctx, 'sessionSources')
    this.mode = mode
  }

  /**
   * Register an adapter until its disposer or owning plugin fiber is disposed.
   *
   * @param adapter - adapter identity and display metadata.
   * @returns an idempotent lifecycle disposer.
   * @throws {DuplicateSessionSourceError} when the id is already registered.
   */
  register(adapter: SessionSourceAdapter): SessionSourceRegistration {
    const adapters = this.adapters
    return this.ctx.effect(() => {
      if (adapters.has(adapter.id)) {
        throw new DuplicateSessionSourceError(adapter.id)
      }

      adapters.set(adapter.id, adapter)
      return () => {
        if (adapters.get(adapter.id) === adapter) {
          adapters.delete(adapter.id)
        }
      }
    }, 'sessionSources.register()')
  }

  /**
   * Resolve one live adapter by its exact id.
   *
   * @param id - case-sensitive adapter id.
   * @returns the live adapter, or `undefined` when the id is unregistered.
   */
  get(id: string): SessionSourceAdapter | undefined {
    return this.adapters.get(id)
  }

  /**
   * Snapshot live adapters in registration order.
   *
   * @returns a detached array of live adapter references.
   */
  list(): readonly SessionSourceAdapter[] {
    return [...this.adapters.values()]
  }
}

/** Required plugin configuration; no value is defaulted at runtime. */
export interface Config {
  /** Safety mode for this skeleton. Write-capable modes are unsupported. */
  mode: 'read-only'
}

/** Schemastery validation for the explicit read-only safety mode. */
export const Config: z<Config> = z.object({
  mode: z.const('read-only').required(),
})

/** Cordis object-plugin name. */
export const name = 'claude2dsh'

/** Service advertised by this object plugin. */
export const provide = ['sessionSources']

/**
 * Activate the in-memory session-source registry.
 *
 * @param ctx - Cordis plugin context.
 * @param config - validated explicit safety configuration.
 */
export function apply(ctx: Context, config: Config): void {
  new SessionSourceRegistry(ctx, config.mode)
}
