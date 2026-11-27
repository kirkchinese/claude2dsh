/**
 * Workbench settings persisted beside the installation ledger. Settings are a
 * small, explicit JSON file rather than YAML so the UI and service agree on the
 * same source of truth.
 * @module @kirkchinese/harness-forge
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { defaultDiscoveryRoots } from '@kirkchinese/harness-forge-core'

/** User-visible workbench settings. */
export interface HarnessSettings {
  readonly schemaVersion: 1
  readonly discoveryRoots: readonly string[]
  readonly autoDiscover: boolean
  readonly contextBudgetTokens?: number
}

/** Default roots: common harness caches plus the current workspace. */
export function defaultSettings(): HarnessSettings {
  return {
    schemaVersion: 1,
    discoveryRoots: [...defaultDiscoveryRoots(), resolve(process.cwd())],
    autoDiscover: true,
  }
}

/** Settings file lives beside `state.json`/`receipts/`. */
export function settingsPathFor(statePath: string): string {
  return join(dirname(statePath), 'settings.json')
}

/** Read settings, falling back to defaults when the file is absent/invalid. */
export function readSettings(statePath: string): HarnessSettings {
  const defaults = defaultSettings()
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(settingsPathFor(statePath), 'utf8')) as unknown
  } catch {
    return defaults
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return defaults
  const record = raw as Record<string, unknown>
  const roots = Array.isArray(record['discoveryRoots'])
    ? [...new Set(record['discoveryRoots'].filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map(value => resolve(value)))]
    : defaults.discoveryRoots
  const autoDiscover = typeof record['autoDiscover'] === 'boolean' ? record['autoDiscover'] : defaults.autoDiscover
  const contextBudgetTokens = typeof record['contextBudgetTokens'] === 'number' && Number.isFinite(record['contextBudgetTokens']) && record['contextBudgetTokens'] > 0
    ? Math.round(record['contextBudgetTokens'])
    : undefined
  return {
    schemaVersion: 1,
    discoveryRoots: roots.length > 0 ? roots : defaults.discoveryRoots,
    autoDiscover,
    ...(contextBudgetTokens !== undefined ? { contextBudgetTokens } : {}),
  }
}

/** Persist settings atomically. */
export function writeSettings(statePath: string, settings: HarnessSettings): void {
  const path = settingsPathFor(statePath)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
}
