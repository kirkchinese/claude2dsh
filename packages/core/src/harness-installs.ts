/**
 * What each harness has installed right now, by the key it knows an install
 * by across updates: the readers discovery uses (`installed_plugins.json`,
 * Codex's `config.toml`, the OpenCode inventory), read for every harness
 * whatever the discovery folders are. A migrated plugin follows its harness
 * through this: to the folder of a new version, or out when it is uninstalled.
 * @module @kirkchinese/harness-forge-core
 */
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { dialects } from './dialects/registry.js'
import type { SourceId } from './types.js'

/** One plugin a harness has installed. */
export interface HarnessInstall {
  readonly harness: SourceId
  /** `HarnessPluginEntry.key`: `<name>@<marketplace>`, or OpenCode's package folder. */
  readonly key: string
  readonly root: string
  /** `false` when the harness has it switched off; absent when on, or when that cannot be told. */
  readonly enabled?: false
}

/** Every harness's installs, and how much of each harness's record could be read. */
export interface HarnessInstalls {
  readonly installs: readonly HarnessInstall[]
  /**
   * Harnesses whose record, or one of its entries, could not be read: a plugin missing from what they list may only
   * be unreadable, so its absence proves nothing. Why is in `unread`.
   */
  readonly uncertain: ReadonlySet<SourceId>
  /** Installs a harness records whose files are not where it says: still installed, not followable now. */
  readonly unresolved: ReadonlyArray<{ readonly harness: SourceId; readonly key: string; readonly message: string }>
  /** What of each harness's record could not be read, each saying why. */
  readonly unread: ReadonlyArray<{ readonly harness: SourceId; readonly message: string }>
}

/** Read what every harness has installed now. */
export function harnessInstalls(home = homedir()): HarnessInstalls {
  const installs: HarnessInstall[] = []
  const unresolved: Array<{ harness: SourceId; key: string; message: string }> = []
  const unread: Array<{ harness: SourceId; message: string }> = []
  for (const dialect of dialects()) {
    const recorded = dialect.harnessPlugins
    if (recorded === undefined) continue
    for (const folder of recorded.roots(home)) {
      try {
        const listed = recorded.list(home, folder)
        for (const message of listed.unread) unread.push({ harness: dialect.id, message })
        for (const item of listed.unresolved) unresolved.push({ harness: dialect.id, ...item })
        for (const entry of listed.entries) {
          if (installs.some(known => known.harness === dialect.id && known.key === entry.key)) continue
          installs.push({ harness: dialect.id, key: entry.key, root: resolve(entry.root), ...(entry.enabled === false ? { enabled: false as const } : {}) })
        }
      } catch (error: unknown) {
        unread.push({ harness: dialect.id, message: `${folder}: ${error instanceof Error ? error.message : String(error)}` })
      }
    }
  }
  return { installs, uncertain: new Set(unread.map(item => item.harness)), unresolved, unread }
}

/**
 * The harness install a plugin folder is: one a harness lists at that folder, else one its layout spells out
 * (`inferred`: a version the harness may no longer list, or a marketplace offer it never installed).
 * @param name - the plugin's own name, for a layout that does not spell it.
 */
export function identifyHarnessInstall(
  root: string,
  name: string,
  current: HarnessInstalls,
  home = homedir(),
): { readonly harness: SourceId; readonly key: string; readonly inferred?: true } | undefined {
  const listed = current.installs.find(install => samePath(install.root, root))
  if (listed !== undefined) return { harness: listed.harness, key: listed.key }
  for (const dialect of dialects()) {
    const key = dialect.harnessPlugins?.identify?.(home, root, name)
    if (key !== undefined) return { harness: dialect.id, key, inferred: true }
  }
  return undefined
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)
}
