/**
 * Durable per-profile ledger. It records only what Harness Forge wrote or
 * mounted; the foreign source stays read-only. Receipts live next to it and
 * are referenced by id, never embedded wholesale.
 * @module @kirkchinese/harness-forge
 */
import { constants, copyFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pluginId } from '@kirkchinese/harness-forge-core'
import type {
  CompatibilityVector,
  ComponentOutcome,
  SourceFingerprint,
} from '@kirkchinese/harness-forge-core'

/** One installed component identity. */
export interface InstalledComponentRecord {
  readonly kind: 'skill' | 'command' | 'mcp' | 'hooks' | 'agent' | 'code' | 'ui' | 'settings' | 'other'
  readonly name: string
  readonly path?: string
}

/** One runtime mount outcome recorded for diagnostics. */
export interface MountRecord {
  readonly kind: 'mcp' | 'hooks' | 'agent' | 'code'
  readonly name: string
  /** A hooks part's events. */
  readonly events?: readonly string[]
  readonly status: 'mounted' | 'failed'
  /** Why it failed: the failing signals' details, else the mount's message. */
  readonly error?: string
}

/** The harness install a migrated plugin follows: its updates move the plugin, its removal stops it. */
export interface HarnessInstallRecord {
  readonly harness: string
  /** What the harness knows it by across updates (`HarnessInstall.key`). */
  readonly key: string
  /** Learnt from the folder's layout, for a ledger written before installs carried their key: not yet seen listed. */
  readonly inferred?: true
  /** Migrated while switched off in the harness, by the person's choice: switching it off there does not stop it. */
  readonly enabled?: false
}

/**
 * Why a followed plugin is no longer one its harness runs: `uninstalled` (the harness lists it no more),
 * `switched-off` (it is off there), `never-installed` (migrated by an earlier Harness Forge from a folder the harness
 * never installed: a marketplace offer, a cached version), `misread` (an earlier Harness Forge read the harness's
 * install as another harness's plugin). Its parts stay off until the person removes it or keeps it as their own.
 */
export const DETACHED_REASONS = ['uninstalled', 'switched-off', 'never-installed', 'misread'] as const
export type DetachedReason = typeof DETACHED_REASONS[number]

/** A followed plugin its harness no longer runs. */
export interface DetachedRecord {
  readonly reason: DetachedReason
  readonly at: string
}

/** The last time the harness updated a followed plugin: Harness Forge moved it to the new folder. */
export interface HarnessUpdateRecord {
  readonly from?: string
  readonly to?: string
  readonly at: string
}

/** One installed foreign plugin. */
export interface InstalledPluginRecord {
  readonly id: string
  readonly source: string
  readonly name: string
  /** The plugin's own name where `name` has a suffix telling it from another of the same name. */
  readonly displayName?: string
  readonly root: string
  readonly version?: string
  readonly license?: string
  readonly installedAt: string
  readonly planId?: string
  readonly fingerprint?: SourceFingerprint
  readonly components: readonly InstalledComponentRecord[]
  /** Skill roots registered for this plugin; used for exact removal. */
  readonly skillRoots?: readonly string[]
  /** Runtime mount results, retained so the workbench can explain failures. */
  readonly mounts?: readonly MountRecord[]
  /** Current honest vector; recomputed from outcomes, not copied from scan. */
  readonly compat?: CompatibilityVector
  readonly outcomes?: readonly ComponentOutcome[]
  /** Receipt ids in application order; the files live beside the ledger. */
  readonly receipts?: readonly string[]
  /** Components the person switched off: never mounted until switched on again. */
  readonly disabled?: readonly string[]
  /** The harness install it follows; absent for a plugin no harness installed (a folder, the person's own assets). */
  readonly harnessInstall?: HarnessInstallRecord
  /** Set while its harness no longer runs it: nothing of it is mounted. */
  readonly detached?: DetachedRecord
  readonly harnessUpdate?: HarnessUpdateRecord
  /** When the person kept it as their own copy: it follows no harness any more, and is never matched to one again. */
  readonly keptAt?: string
}

/** The complete ledger document. */
export interface CompatState {
  readonly schemaVersion: 2
  readonly plugins: readonly InstalledPluginRecord[]
}

const EMPTY: CompatState = { schemaVersion: 2, plugins: [] }

/** Resolve the Harness home without importing a DSH runtime package. */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME?.trim()
  if (configured !== undefined && configured.length > 0) {
    if (configured === '~') return homedir()
    if (configured.startsWith('~/') || configured.startsWith('~\\')) return join(homedir(), configured.slice(2))
    return configured
  }
  return join(homedir(), '.dsh')
}

/** Default ledger path. A launched profile keeps its own ledger; a bare
 * composition falls back to the shared Harness Forge directory. */
export function defaultStatePath(
  env: NodeJS.ProcessEnv = process.env,
  profile?: { readonly dir?: string; readonly name?: string },
): string {
  if (profile?.dir !== undefined && profile.dir.length > 0) {
    return join(profile.dir, '.harness-forge', 'state.json')
  }
  if (profile?.name !== undefined && profile.name.length > 0) {
    return join(resolveDshHome(env), 'harness-forge', 'profiles', profile.name, 'state.json')
  }
  return join(resolveDshHome(env), 'harness-forge', 'state.json')
}

/** Errors a file operation may outlive: the process out of handles, the file briefly locked (a scanner, a sync). */
const TRANSIENT = new Set(['EMFILE', 'ENFILE', 'EBUSY', 'EAGAIN', 'EPERM', 'EACCES'])

/** Whether a file operation failed in a way it may outlive. */
export function isTransient(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code
  return typeof code === 'string' && TRANSIENT.has(code)
}

/**
 * Run a file operation again while it fails transiently, for up to `forMs`. DSH itself can exhaust the process's
 * file handles for seconds (it opens every session's cached projection at once); the waits must not block, since
 * the handles are released by DSH's own callbacks.
 */
export async function retryFile<T>(operation: () => T, forMs = 30_000): Promise<T> {
  const deadline = Date.now() + forMs
  for (;;) {
    try {
      return operation()
    } catch (error: unknown) {
      if (!isTransient(error) || Date.now() > deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
}

/** The ledger schema this Harness Forge reads and writes. */
export const STATE_SCHEMA_VERSION = 2

/** A ledger as read: what can be used of it, and what reading it cost. */
export interface LoadedState {
  readonly state: CompatState
  /** The file as it was, kept beside it before anything of it was dropped or repaired; never overwritten. */
  readonly backup?: string
  /** What could not be read (a record, or the whole file), each with why. */
  readonly rejected: readonly string[]
  /** Records read with a field defaulted or dropped, by id. */
  readonly repaired: readonly string[]
  /** The ledger was written by a newer Harness Forge: it is used as nothing and nothing may be written over it. */
  readonly readOnly?: string
}

/**
 * Read the ledger. A missing ledger is empty; one that cannot be read throws (an empty answer would be persisted
 * over the real one); one that is not JSON is kept beside it as `state.json.corrupt-<time>` and a new one starts.
 * Before anything else of it is dropped or repaired, the file is kept as `state.json.unreadable-<time>`: records
 * missing a field that can be defaulted or derived are repaired, records without what identifies a plugin are
 * rejected, their valid peers kept. A ledger of a newer schema is refused whole, read-only.
 */
export function loadState(path = defaultStatePath()): LoadedState {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error: unknown) {
    if ((error as { code?: unknown }).code === 'ENOENT') return { state: EMPTY, rejected: [], repaired: [] }
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { state: EMPTY, backup: keepCopy(path, 'corrupt'), rejected: ['the ledger is not JSON'], repaired: [] }
  }
  const lost = (why: string): LoadedState => ({ state: EMPTY, backup: keepCopy(path, 'unreadable'), rejected: [why], repaired: [] })
  if (!isPlainRecord(value)) return lost('the ledger is not a JSON object')
  const version = value['schemaVersion']
  if (typeof version === 'number' && Number.isInteger(version) && version > STATE_SCHEMA_VERSION) {
    return {
      state: EMPTY,
      rejected: [],
      repaired: [],
      readOnly: `${path} was written by a newer Harness Forge (ledger schema ${String(version)}; this one reads ${String(STATE_SCHEMA_VERSION)}): upgrade Harness Forge. Nothing is restored from it and nothing is written over it`,
    }
  }
  if (version !== 1 && version !== 2) return lost(`the ledger has an unknown schemaVersion ${JSON.stringify(version) ?? 'undefined'}`)
  if (!Array.isArray(value['plugins'])) return lost('the ledger\'s "plugins" is not a list')
  const plugins: InstalledPluginRecord[] = []
  const rejected: string[] = []
  const repaired: string[] = []
  const installedAt = fileTime(path)
  for (const [index, raw] of value['plugins'].entries()) {
    const read = version === 2 ? readRecord(raw, installedAt) : readLegacyRecord(raw, installedAt)
    if (typeof read === 'string') {
      rejected.push(`record ${String(index)}: ${read}`)
      continue
    }
    plugins.push(read.record)
    if (read.repaired) repaired.push(read.record.id)
  }
  // A v1 ledger is migrated (its trust is not carried over): the v1 file is kept as it was.
  const lossy = rejected.length > 0 || repaired.length > 0 || version === 1
  return { state: { schemaVersion: STATE_SCHEMA_VERSION, plugins }, ...(lossy ? { backup: keepCopy(path, 'unreadable') } : {}), rejected, repaired }
}

/** The usable part of the ledger (see {@link loadState}). */
export function readState(path = defaultStatePath()): CompatState {
  return loadState(path).state
}

/** Keep the ledger as it is now beside it, under a name no other copy has. */
function keepCopy(path: string, kind: 'corrupt' | 'unreadable'): string {
  const stamp = `${path}.${kind}-${String(Date.now())}`
  for (let attempt = 0; ; attempt++) {
    const target = attempt === 0 ? stamp : `${stamp}-${String(attempt)}`
    try {
      copyFileSync(path, target, constants.COPYFILE_EXCL)
      return target
    } catch (error: unknown) {
      if ((error as { code?: unknown }).code !== 'EEXIST') throw error
    }
  }
}

/** When the ledger was last written: a record missing its install time was installed no later. */
function fileTime(path: string): string {
  try {
    return statSync(path).mtime.toISOString()
  } catch {
    return new Date().toISOString()
  }
}

/** Persist the ledger atomically. */
export function writeState(state: CompatState, path = defaultStatePath()): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
}

/** Directory holding receipts beside the ledger. */
export function receiptsDirectory(statePath = defaultStatePath()): string {
  return join(dirname(statePath), 'receipts')
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** What identifies a plugin: its source and root, and its id or name (each derivable from the other). */
function identity(raw: Record<string, unknown>): { id: string; source: string; name: string; root: string } | string {
  const source = raw['source']
  const root = raw['root']
  if (typeof source !== 'string' || source.length === 0) return 'it has no source'
  if (typeof root !== 'string' || root.length === 0) return 'it has no root folder'
  const id = typeof raw['id'] === 'string' && raw['id'].length > 0 ? raw['id'] : undefined
  const name = typeof raw['name'] === 'string' && raw['name'].length > 0 ? raw['name'] : id?.startsWith(`${source}:`) === true ? id.slice(source.length + 1) : undefined
  if (name === undefined) return 'it has neither a name nor an id of its source'
  return { id: id ?? pluginId(source, name), source, name, root }
}

/** A v2 record, repaired where a field can be defaulted, or why it cannot be read. */
function readRecord(raw: unknown, installedAt: string): { record: InstalledPluginRecord; repaired: boolean } | string {
  if (!isPlainRecord(raw)) return 'it is not an object'
  const base = identity(raw)
  if (typeof base === 'string') return base
  const copy: Record<string, unknown> = { ...raw, ...base }
  // Old v2 ledgers may still carry a trust object; it is no longer state, and dropping it loses nothing.
  delete copy['trust']
  let repaired = base.id !== raw['id'] || base.name !== raw['name']
  const drop = (key: string): void => {
    if (key in copy) {
      delete copy[key]
      repaired = true
    }
  }
  if (typeof copy['installedAt'] !== 'string') {
    copy['installedAt'] = installedAt
    repaired = true
  }
  const components = Array.isArray(copy['components']) ? copy['components'].filter(isComponent) : []
  if (!Array.isArray(copy['components']) || components.length !== copy['components'].length) repaired = true
  copy['components'] = components
  for (const key of ['displayName', 'version', 'license', 'planId', 'keptAt']) if (key in copy && typeof copy[key] !== 'string') drop(key)
  if ('harnessInstall' in copy && !isHarnessInstall(copy['harnessInstall'])) drop('harnessInstall')
  if ('detached' in copy && !(isPlainRecord(copy['detached']) && (DETACHED_REASONS as readonly unknown[]).includes(copy['detached']['reason']) && typeof copy['detached']['at'] === 'string')) drop('detached')
  if ('harnessUpdate' in copy && !(isPlainRecord(copy['harnessUpdate']) && typeof copy['harnessUpdate']['at'] === 'string')) drop('harnessUpdate')
  for (const key of ['fingerprint', 'compat']) if (key in copy && !isPlainRecord(copy[key])) drop(key)
  for (const key of ['mounts', 'outcomes']) {
    if (!(key in copy)) continue
    if (!Array.isArray(copy[key])) drop(key)
    else if (!(copy[key] as unknown[]).every(isPlainRecord)) {
      copy[key] = (copy[key] as unknown[]).filter(isPlainRecord)
      repaired = true
    }
  }
  for (const key of ['skillRoots', 'receipts', 'disabled']) {
    if (!(key in copy)) continue
    if (!Array.isArray(copy[key])) drop(key)
    else if (!(copy[key] as unknown[]).every(item => typeof item === 'string')) {
      copy[key] = (copy[key] as unknown[]).filter(item => typeof item === 'string')
      repaired = true
    }
  }
  return { record: copy as unknown as InstalledPluginRecord, repaired }
}

/** A v1 record as v2: its identity, version, license, install time, components and skill roots. */
function readLegacyRecord(raw: unknown, installedAt: string): { record: InstalledPluginRecord; repaired: boolean } | string {
  if (!isPlainRecord(raw)) return 'it is not an object'
  const base = identity(raw)
  if (typeof base === 'string') return base
  const components = Array.isArray(raw['components']) ? raw['components'].filter(isComponent) : []
  const record: InstalledPluginRecord = {
    ...base,
    ...(typeof raw['version'] === 'string' ? { version: raw['version'] } : {}),
    ...(typeof raw['license'] === 'string' ? { license: raw['license'] } : {}),
    installedAt: typeof raw['installedAt'] === 'string' ? raw['installedAt'] : installedAt,
    components,
    ...(Array.isArray(raw['skillRoots']) ? { skillRoots: raw['skillRoots'].filter((root): root is string => typeof root === 'string') } : {}),
    receipts: [],
  }
  return { record, repaired: typeof raw['installedAt'] !== 'string' || !Array.isArray(raw['components']) || components.length !== raw['components'].length }
}

function isHarnessInstall(value: unknown): value is HarnessInstallRecord {
  return isPlainRecord(value) && typeof value['harness'] === 'string' && typeof value['key'] === 'string'
}

function isComponent(value: unknown): value is InstalledComponentRecord {
  return isPlainRecord(value) && typeof value['kind'] === 'string' && typeof value['name'] === 'string'
}

export type { CompatibilityVector, ComponentOutcome }
