/**
 * The sessions' drawings as the workbench sees them: watching, drawing
 * afresh, and the person's actions on them.
 * @module @kirkchinese/harness-forge/mods
 */
import type { SurfaceSnapshot } from '../surfaces.js'
import { messageOf } from '../values.js'
import type { SessionRegistry } from './sessions.js'

/** The band and panes of the sessions' mods. */
export class ModDrawings {
  constructor(private readonly registry: SessionRegistry) {}

  /**
   * Watch the band and panes of a session, across the agents it is given (a
   * resumed session gets a new agent when the person acts). Undefined when no
   * mod is loaded at all.
   */
  watch(sessionId: string, listener: (snapshot: SurfaceSnapshot) => void): (() => void) | undefined {
    if (this.registry.sources.size === 0 && !this.registry.sessions.has(sessionId)) return undefined
    const set = this.registry.watchers.get(sessionId) ?? new Set()
    set.add(listener)
    this.registry.watchers.set(sessionId, set)
    const current = this.registry.sessions.get(sessionId)
    if (current !== undefined) listener(current.surfaces.current())
    return () => {
      set.delete(listener)
      if (set.size === 0) this.registry.watchers.delete(sessionId)
    }
  }

  /** A session's drawings, drawn afresh; undefined when the session has no mods. */
  async drawn(sessionId: string): Promise<SurfaceSnapshot | undefined> {
    const session = this.registry.sessions.get(sessionId)
    if (session === undefined) return undefined
    await session.ready
    return session.surfaces.refresh()
  }

  /** The person acted on a control of a session's drawing. */
  async act(sessionId: string, generation: number, actionId: string, value?: unknown): Promise<SurfaceSnapshot> {
    const session = this.registry.sessions.get(sessionId)
    if (session === undefined) throw new Error('that session has no mods loaded')
    return session.surfaces.act(generation, actionId, value)
  }

  /**
   * The person closed a pane: `ui.close` with origin `person`; a hook may
   * keep it open with `{ deny }`.
   * @returns the drawing after, and the refusal when a hook kept the pane.
   */
  async closePane(sessionId: string, id: string): Promise<{ snapshot: SurfaceSnapshot; refused?: string }> {
    const session = this.registry.sessions.get(sessionId)
    if (session === undefined) throw new Error('that session has no mods loaded')
    const result = await session.engine.raise('ui.close', { id, origin: { kind: 'person' } }).catch((error: unknown) => ({ deny: messageOf(error) })) as Record<string, unknown>
    const refused = typeof result['deny'] === 'string' ? result['deny'] : undefined
    const snapshot = await session.surfaces.refresh()
    return { snapshot, ...(refused !== undefined ? { refused } : {}) }
  }

  /** The person moved focus or scrolled in a session's drawing. */
  async move(sessionId: string, kind: 'focus' | 'scroll', target: Readonly<Record<string, unknown>>): Promise<{ snapshot: SurfaceSnapshot; refused?: string }> {
    const session = this.registry.sessions.get(sessionId)
    if (session === undefined) throw new Error('that session has no mods loaded')
    return session.surfaces.move(kind, target)
  }
}
