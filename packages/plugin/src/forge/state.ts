/**
 * Durable per-profile ledger. It records only what Harness Forge wrote or
 * mounted; the foreign source stays read-only. Receipts live next to it and
 * are referenced by id, never embedded wholesale.
 * @module @kirkchinese/harness-forge
 */
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
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
  readonly status: 'mounted' | 'failed'
  readonly error?: string
}

/** One installed foreign plugin. */
export interface InstalledPluginRecord {
  readonly id: string
  readonly source: string
  readonly name: string
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

/** Read the ledger. A v1 ledger is migrated without trusting execution. */
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

/**
 * Read the ledger. A missing ledger is empty; one that cannot be read throws (an empty answer would be persisted
 * over the real one); one that is not JSON is kept beside it as `state.json.corrupt-<time>` and a new one starts.
 */
export function readState(path = defaultStatePath()): CompatState {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error: unknown) {
    if ((error as { code?: unknown }).code === 'ENOENT') return EMPTY
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    copyFileSync(path, `${path}.corrupt-${String(Date.now())}`)
    return EMPTY
  }
  {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return EMPTY
    const record = value as { schemaVersion?: unknown; plugins?: unknown }
    if (!Array.isArray(record.plugins)) return EMPTY
    if (record.schemaVersion === 2) {
      return { schemaVersion: 2, plugins: record.plugins.filter(isV2Record).map(stripLegacyTrust) }
    }
    if (record.schemaVersion === 1) {
      return {
        schemaVersion: 2,
        plugins: record.plugins.filter(isLegacyRecord).map(legacy => ({
          id: legacy.id,
          source: legacy.source,
          name: legacy.name,
          root: legacy.root,
          ...(typeof legacy.version === 'string' ? { version: legacy.version } : {}),
          ...(typeof legacy.license === 'string' ? { license: legacy.license } : {}),
          installedAt: legacy.installedAt,
          components: legacy.components.filter(isLegacyComponent),
          ...(Array.isArray(legacy.skillRoots) ? { skillRoots: legacy.skillRoots.filter((root): root is string => typeof root === 'string') } : {}),
          receipts: [],
        })),
      }
    }
    return EMPTY
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

function isV2Record(value: unknown): value is InstalledPluginRecord {
  return isBaseRecord(value)
}

/** Old v2 ledgers may still carry a trust object; it is no longer state. */
function stripLegacyTrust(record: InstalledPluginRecord): InstalledPluginRecord {
  const copy: Record<string, unknown> = { ...record }
  delete copy['trust']
  return copy as unknown as InstalledPluginRecord
}

function isLegacyRecord(value: unknown): value is Record<string, unknown> & {
  id: string
  source: string
  name: string
  root: string
  installedAt: string
  components: unknown[]
} {
  return isBaseRecord(value)
}

function isBaseRecord(value: unknown): value is Record<string, unknown> & {
  id: string
  source: string
  name: string
  root: string
  installedAt: string
  components: unknown[]
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record['id'] === 'string'
    && typeof record['source'] === 'string'
    && typeof record['name'] === 'string'
    && typeof record['root'] === 'string'
    && typeof record['installedAt'] === 'string'
    && Array.isArray(record['components'])
}

function isLegacyComponent(value: unknown): value is InstalledComponentRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const component = value as Record<string, unknown>
  return typeof component['kind'] === 'string' && typeof component['name'] === 'string'
}

export type { CompatibilityVector, ComponentOutcome }
