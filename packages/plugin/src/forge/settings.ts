/**
 * Imported harness settings (Claude Code's `settings.json`, Codex's config):
 * their environment reaches every hook, MCP server and shell command, their
 * permission rules gate tool calls, `disableAllHooks` silences the hooks, and
 * `outputStyle` is the starting style. Several rows read them, so the shared
 * service keeps them.
 * @module @kirkchinese/harness-forge
 */
import { readFileSync } from 'node:fs'
import type { PermissionRules, SettingsComponent } from '@kirkchinese/harness-forge-core'

/** The session facts settings scoping reads. */
export interface SessionHeaderLike {
  readonly id: string
  readonly parentSession?: string
}

interface Entry {
  readonly component: SettingsComponent
  readonly sessionId?: string
}

/** The settings in effect, process-wide and per session. */
export class ImportedSettings {
  private readonly entries = new Map<string, Entry>()

  /**
   * @param turnRules - the allow and deny rules of a session's turn (an invoked skill's `allowed-tools`).
   */
  constructor(private readonly turnRules: (sessionId: string) => { readonly allow: readonly string[]; readonly deny: readonly string[] }) {}

  /** Apply one settings component, process-wide or for one session. Returns the withdrawal. */
  apply(component: SettingsComponent, sessionId?: string): () => void {
    const key = sessionId === undefined ? component.id : `${component.id}@${sessionId}`
    const entry: Entry = { component, ...(sessionId !== undefined ? { sessionId } : {}) }
    this.entries.set(key, entry)
    return () => { if (this.entries.get(key) === entry) this.entries.delete(key) }
  }

  /** The `outputStyle` the process-wide settings name, the latest winning. */
  outputStyle(): string | undefined {
    let style: string | undefined
    for (const { component, sessionId } of this.entries.values()) if (sessionId === undefined && component.outputStyle !== undefined) style = component.outputStyle
    return style
  }

  /** The settings in effect for a session: global ones, then the session's (project) ones. */
  private settingsFor(session?: SessionHeaderLike): Entry[] {
    const entries = [...this.entries.values()]
    const applies = (sessionId: string | undefined): boolean => sessionId === undefined
      || (session !== undefined && (session.id === sessionId || session.parentSession === sessionId))
    return [...entries.filter(entry => entry.sessionId === undefined), ...entries.filter(entry => entry.sessionId !== undefined && applies(entry.sessionId))]
  }

  /**
   * Claude settings as `$.settings.read` returns them: every imported
   * settings file in effect merged (later files win, objects merged), or one
   * source's (`user`, `project`, `local`; `policy` is managed settings,
   * which DSH has none of).
   */
  claudeSettings(session: SessionHeaderLike | undefined, source: string | undefined): Record<string, unknown> {
    if (source === 'policy' || source === 'flag') return {}
    const merged: Record<string, unknown> = {}
    for (const { component } of this.settingsFor(session)) {
      for (const file of component.files) {
        const kind = /settings\.local\.json$/u.test(file) ? 'local' : component.id.startsWith('claude-code:user') ? 'user' : 'project'
        if (source !== undefined && kind !== source) continue
        try {
          deepMerge(merged, JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>)
        } catch {
          // An unreadable file adds nothing.
        }
      }
    }
    return merged
  }

  /** The environment imported settings declare, later (project) settings winning. */
  env(session?: SessionHeaderLike): Record<string, string> {
    const env: Record<string, string> = {}
    for (const { component } of this.settingsFor(session)) Object.assign(env, component.env)
    return env
  }

  /**
   * The Claude-syntax permission rules in effect for a session; deny from any
   * scope holds. An invoked skill's `allowed-tools` and `disallowed-tools`
   * count for the rest of its turn.
   */
  permissionRules(session?: SessionHeaderLike): PermissionRules {
    const allow: string[] = []
    const deny: string[] = []
    const ask: string[] = []
    for (const { component } of this.settingsFor(session)) {
      allow.push(...component.permissions.allow)
      deny.push(...component.permissions.deny)
      ask.push(...component.permissions.ask)
    }
    if (session !== undefined) {
      const turn = this.turnRules(session.id)
      allow.push(...turn.allow)
      deny.push(...turn.deny)
    }
    return { allow, deny, ask }
  }

  /** `disableAllHooks` from the settings in effect, the most specific scope winning. */
  hooksDisabled(session?: SessionHeaderLike): boolean {
    let disabled = false
    for (const { component } of this.settingsFor(session)) if (component.disableAllHooks !== undefined) disabled = component.disableAllHooks
    return disabled
  }
}

function deepMerge(into: Record<string, unknown>, from: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(from)) {
    const current = into[key]
    if (typeof value === 'object' && value !== null && !Array.isArray(value) && typeof current === 'object' && current !== null && !Array.isArray(current)) {
      deepMerge(current as Record<string, unknown>, value as Record<string, unknown>)
    } else {
      into[key] = value
    }
  }
}
