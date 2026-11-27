/**
 * Workspace trust: whether a project's parts that run code or reach the
 * network may run in DSH. A workspace is trusted when the person accepted
 * Claude Code's trust dialog for it, Codex marks it trusted, or they trusted
 * it in Harness Forge. Harness Forge's own grants live in `trust.json` beside
 * the ledger (per DSH profile), never in the profile's DSH configuration.
 * See `@kirkchinese/harness-forge-core` `trust.ts` for the rules.
 * @module @kirkchinese/harness-forge
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { claudeCodeTrusts, codexTrusts, trustKeys, workspaceRootOf, type TrustSource } from '@kirkchinese/harness-forge-core'

/** The outcome message of a project part held back until the workspace is trusted. */
export const WAITING_FOR_TRUST = 'waiting for you to trust this workspace'

/** The outcome message of a project `.mcp.json` server Claude Code has not approved (and Harness Forge was not asked to trust). */
export const WAITING_FOR_APPROVAL = 'waiting for approval: approve it in Claude Code, or trust this workspace in Harness Forge'

/** Why a project's command or skill runs no shell line: the reason its rendering shows. */
export function untrustedShell(workspace: string): string {
  return `the workspace ${workspace} is not trusted (trust it in Harness Forge → Migrated)`
}

/** Whether the workspace of a directory is trusted now, as commands and skills ask when they render. */
export type TrustCheck = (dir: string) => { readonly trusted: boolean; readonly workspace: string }

/** A workspace's trust as the workbench shows it. */
export interface WorkspaceTrustState {
  readonly workspace: string
  readonly trusted: boolean
  /** Where the trust comes from; empty when untrusted. */
  readonly sources: readonly TrustSource[]
  /** The person chose "Not now" for this workspace: its banner stays hidden. */
  readonly dismissed: boolean
}

/** A workspace Harness Forge has a decision on, for the Trust settings list. */
export interface TrustRecord extends WorkspaceTrustState {
  readonly trustedAt?: string
  readonly dismissedAt?: string
}

interface Stored {
  readonly schemaVersion: 1
  /** Trusted workspace roots, with when. */
  readonly workspaces: Readonly<Record<string, { readonly trustedAt: string }>>
  /** Workspace roots whose trust banner the person dismissed ("Not now"), with when. */
  readonly dismissed?: Readonly<Record<string, { readonly dismissedAt: string }>>
}

/** The per-profile store of workspaces trusted in Harness Forge. */
export class WorkspaceTrust {
  private readonly path: string
  private readonly listeners = new Set<(workspace: string, trusted: boolean) => void>()

  constructor(statePath: string, private readonly home: string = homedir()) {
    this.path = join(dirname(statePath), 'trust.json')
  }

  private read(): Stored {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as unknown
      if (typeof raw === 'object' && raw !== null && typeof (raw as Stored).workspaces === 'object' && (raw as Stored).workspaces !== null) return raw as Stored
    } catch {
      // Absent or unreadable: nothing is trusted here.
    }
    return { schemaVersion: 1, workspaces: {}, dismissed: {} }
  }

  private write(workspaces: Stored['workspaces'], dismissed: NonNullable<Stored['dismissed']>): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, workspaces, dismissed }, null, 2)}\n`, 'utf8')
    renameSync(temporary, this.path)
  }

  /** The trust of the workspace that holds `cwd`. */
  state(cwd: string): WorkspaceTrustState {
    const workspace = workspaceRootOf(resolve(cwd))
    const granted = this.read().workspaces
    const sources: TrustSource[] = []
    if (claudeCodeTrusts(workspace, this.home)) sources.push('claude-code')
    if (codexTrusts(workspace, this.home)) sources.push('codex')
    if (trustKeys(workspace, this.home).some(key => granted[key] !== undefined)) sources.push('forge')
    return { workspace, trusted: sources.length > 0, sources, dismissed: this.read().dismissed?.[workspace] !== undefined }
  }

  /** The workspaces Harness Forge holds a decision on (trusted here, or dismissed), most recent first. */
  list(): TrustRecord[] {
    const stored = this.read()
    const roots = new Set([...Object.keys(stored.workspaces), ...Object.keys(stored.dismissed ?? {})])
    return [...roots].map((root): TrustRecord => {
      const trustedAt = stored.workspaces[root]?.trustedAt
      const dismissedAt = stored.dismissed?.[root]?.dismissedAt
      return { ...this.state(root), workspace: root, ...(trustedAt !== undefined ? { trustedAt } : {}), ...(dismissedAt !== undefined ? { dismissedAt } : {}) }
    }).sort((left, right) => (right.trustedAt ?? right.dismissedAt ?? '').localeCompare(left.trustedAt ?? left.dismissedAt ?? ''))
  }

  /**
   * Trust (or stop trusting) the workspace that holds `cwd` in Harness Forge; trust kept by Claude Code or Codex stays theirs.
   * Trusting ends a dismissal; revoking leaves the workspace undecided again.
   */
  set(cwd: string, trusted: boolean): WorkspaceTrustState {
    const workspace = workspaceRootOf(resolve(cwd))
    const current = this.read()
    const workspaces = { ...current.workspaces }
    const dismissed = { ...current.dismissed }
    delete dismissed[workspace]
    if (trusted) workspaces[workspace] = { trustedAt: new Date().toISOString() }
    else delete workspaces[workspace]
    this.write(workspaces, dismissed)
    for (const listener of [...this.listeners]) listener(workspace, trusted)
    return this.state(workspace)
  }

  /** Hide (or show again) the trust banner of the workspace that holds `cwd`; this trusts nothing. */
  dismiss(cwd: string, dismissed: boolean): WorkspaceTrustState {
    const workspace = workspaceRootOf(resolve(cwd))
    const current = this.read()
    const marks = { ...current.dismissed }
    if (dismissed) marks[workspace] = { dismissedAt: new Date().toISOString() }
    else delete marks[workspace]
    this.write(current.workspaces, marks)
    return this.state(workspace)
  }

  /** Hear each change made here. */
  onChange(listener: (workspace: string, trusted: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}
