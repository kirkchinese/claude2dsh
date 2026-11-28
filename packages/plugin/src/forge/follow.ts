/**
 * How a migrated plugin follows the harness that installed it. Claude Code
 * and Codex put each version of a plugin in a folder of its own and may delete
 * the old one; the ledger records the folder it migrated. Its harness install
 * (`HarnessInstallRecord`) is matched against what the harness lists now:
 *
 * | The harness lists it | Then |
 * | --- | --- |
 * | at the same folder | nothing to do (a plugin that was detached is applied again) |
 * | at another folder | the plugin moves there, keeping the parts the person switched off |
 * | not at all, or switched off | detached: nothing of it runs until the person removes or keeps it |
 *
 * A harness whose record cannot be read in full (malformed, or cut off while
 * the harness writes it) proves nothing by leaving a plugin out, nor does one
 * that records the plugin at a folder that is not there: nothing changes, and
 * the next read decides.
 * @module @kirkchinese/harness-forge
 */
import { resolve } from 'node:path'
import { identifyHarnessInstall, type HarnessInstalls } from '@kirkchinese/harness-forge-core'
import type { DetachedReason, HarnessInstallRecord, InstalledPluginRecord } from './state.js'

/** What following a plugin's harness asks of it now. */
export type Following =
  /** No harness install to follow, or its harness cannot tell. */
  | { readonly kind: 'none' }
  /** The harness runs it from the recorded folder; `identity` is the install as seen now. */
  | { readonly kind: 'current'; readonly identity: HarnessInstallRecord }
  /** The harness updated it into another folder. */
  | { readonly kind: 'moved'; readonly identity: HarnessInstallRecord; readonly root: string }
  | { readonly kind: 'detached'; readonly reason: DetachedReason }

/** What the person's record says it follows, learnt from its folder when the record predates install keys. */
export function withHarnessInstall(record: InstalledPluginRecord, current: HarnessInstalls, home?: string): InstalledPluginRecord {
  if (record.harnessInstall !== undefined || record.keptAt !== undefined) return record
  const identity = identifyHarnessInstall(record.root, record.displayName ?? record.name, current, home)
  return identity === undefined ? record : { ...record, harnessInstall: identity }
}

/** The harness install a plugin newly migrated from `root` follows: only one its harness lists there. */
export function newHarnessInstall(root: string, name: string, source: string, current: HarnessInstalls, home?: string): HarnessInstallRecord | undefined {
  const identity = identifyHarnessInstall(root, name, current, home)
  if (identity === undefined || identity.inferred === true || identity.harness !== source) return undefined
  const install = current.installs.find(item => item.harness === identity.harness && item.key === identity.key)
  // Migrated while off in its harness: the person chose it, so the harness switching it off does not stop it.
  return { harness: identity.harness, key: identity.key, ...(install?.enabled === false ? { enabled: false as const } : {}) }
}

/** What following the record's harness install asks of it (see the module table). */
export function followingOf(record: InstalledPluginRecord, current: HarnessInstalls): Following {
  const identity = record.harnessInstall
  if (identity === undefined || record.keptAt !== undefined) return { kind: 'none' }
  const install = current.installs.find(item => item.harness === identity.harness && item.key === identity.key)
  if (install === undefined) {
    // Absent only proves it is gone from a complete read, and from it entirely: not one whose files are missing now.
    if (current.uncertain.has(identity.harness)) return { kind: 'none' }
    if (current.unresolved.some(item => item.harness === identity.harness && item.key === identity.key)) return { kind: 'none' }
    return { kind: 'detached', reason: identity.inferred === true ? 'never-installed' : 'uninstalled' }
  }
  // An earlier Harness Forge read this harness's install through another dialect: it is not the plugin the harness runs.
  if (record.source !== identity.harness) return { kind: 'detached', reason: 'misread' }
  if (install.enabled === false && identity.enabled !== false) return { kind: 'detached', reason: 'switched-off' }
  const seen: HarnessInstallRecord = { harness: identity.harness, key: identity.key, ...(install.enabled === false ? { enabled: false as const } : {}) }
  return samePath(install.root, record.root) ? { kind: 'current', identity: seen } : { kind: 'moved', identity: seen, root: install.root }
}

/** Whether following asks anything of the record: a move, a new detachment, or a detachment or identity to clear. */
export function followingChanges(record: InstalledPluginRecord, following: Following): boolean {
  switch (following.kind) {
    case 'none': return false
    case 'moved': return true
    case 'detached': return record.detached?.reason !== following.reason
    case 'current': return record.detached !== undefined || !sameIdentity(record.harnessInstall, following.identity)
  }
}

function sameIdentity(a: HarnessInstallRecord | undefined, b: HarnessInstallRecord): boolean {
  return a !== undefined && a.harness === b.harness && a.key === b.key && a.inferred === b.inferred && a.enabled === b.enabled
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)
}
