/**
 * The dialect contract: everything Harness Forge needs to know about one
 * harness's on-disk formats. A community dialect implements this interface and
 * is added with `registerDialect`; discovery, detection and scanning go
 * through the registry instead of naming harnesses.
 * @module @kirkchinese/harness-forge-core
 */
import type { ForeignPlugin, SourceId } from '../types.js'
import type { SessionSourceAdapter } from '../sessions/adapter.js'
import type { PluginIdProblem } from './opencode/plugin-id.js'

/**
 * Something at a directory that says which dialect it speaks. Detection takes
 * the first match of the strongest tier, in registry order: a manifest beats
 * a bare layout, which beats a fallback format.
 */
export interface DialectMarker {
  readonly tier: 'manifest' | 'layout' | 'fallback'
  /**
   * Whether discovery treats a directory with this marker as a plugin root
   * (default true). A bare layout only decides the dialect of a root found
   * otherwise.
   */
  readonly pluginRoot?: boolean
  /** Discovery checks it only on a folder the user listed, not on the folders below it. */
  readonly listedOnly?: boolean
  test(directory: string): boolean
}

/** One plugin the harness itself has installed. */
export interface HarnessPluginEntry {
  readonly root: string
  /**
   * What the harness knows the install by, stable across its updates: Claude Code and Codex `<name>@<marketplace>`
   * (a new version goes into a folder of its own), OpenCode the package folder (an update rewrites it in place).
   */
  readonly key: string
  readonly enabled?: boolean
  /** Set instead of `enabled` when whether the harness runs it cannot be told: why (an OpenCode plugin id its source does not settle). */
  readonly enabledUnknown?: PluginIdProblem
  readonly marketplace?: string
}

/** An install the harness records whose files are not where the record says: still installed, not readable now. */
export interface UnresolvedHarnessPlugin {
  readonly key: string
  readonly message: string
}

/**
 * The plugins a harness records, and how much of its record could be read. A plugin missing from `entries` is not
 * installed only when `unread` is empty (a complete read) and it is not `unresolved`.
 */
export interface HarnessPluginList {
  readonly entries: readonly HarnessPluginEntry[]
  readonly unresolved: readonly UnresolvedHarnessPlugin[]
  /** What of the record could not be read (a malformed or cut-off file, a folder that could not be listed), each saying why. */
  readonly unread: readonly string[]
}

/** Whether a harness runs the person's own assets, or why that cannot be told. */
export type UserEnablement = { readonly enabled: boolean } | { readonly enabledUnknown: PluginIdProblem }

/** A marketplace the harness added that has a local copy: what it offers can be installed one by one. */
export interface HarnessMarketplace {
  readonly name: string
  /** The marketplace's root folder (it holds `.claude-plugin/marketplace.json` or `.agents/plugins/marketplace.json`). */
  readonly root: string
}

/** Options of {@link Dialect.scan}. */
export interface DialectScanOptions {
  /** Plugin name to use instead of the manifest's (a second plugin of the same name). */
  readonly name?: string
}

/** One harness's formats. */
export interface Dialect {
  /** The `source` of the plugins it reads, e.g. `claude-code`. */
  readonly id: SourceId
  /** Product name shown to the user; not translated. */
  readonly label: string
  readonly markers: readonly DialectMarker[]
  /** Read one plugin root of this dialect. Read-only and tolerant: problems become warnings. */
  scan(root: string, options?: DialectScanOptions): ForeignPlugin
  /** Folders discovery lists by default: where this harness installs plugins. */
  discoveryRoots?(home: string): string[]
  /**
   * The user's own assets (`~/.claude`): read as one plugin. They are listed
   * whenever `anchor` is a discovery root, even when it does not exist.
   */
  readonly user?: {
    /** The directory a user installs to mean "my own assets". */
    root(home: string): string
    /** The discovery root that lists them. */
    anchor(home: string): string
    scan(home: string): ForeignPlugin | undefined
    /**
     * Whether the harness runs them: off when it switches off every one (OpenCode's `-*`), or not known, with why.
     * Absent: on. Discovery lists them either way.
     */
    enablement?(home: string): UserEnablement
    /** What the directory lacks when `scan` finds nothing, for the error. */
    readonly emptyMessage: string
  }
  /**
   * The plugins the harness has installed, as it records them. A folder of
   * `roots` that is a discovery root is read through `list` instead of being
   * walked, so a cached version or a marketplace offer the person never
   * installed is not listed (nor migrated). Each plugin is read through this
   * dialect: the harness that installed it is the one it belongs to.
   */
  readonly harnessPlugins?: {
    roots(home: string): string[]
    /**
     * The plugins recorded for `root`. A record entry that cannot be read is skipped and reported in `unread`, naming
     * it: it must not cost the others, nor the other harnesses' plugins.
     */
    list(home: string, root: string): HarnessPluginList
    /** The marketplaces the harness added, with a local copy, to browse under "Get plugins". */
    marketplaces?(home: string): HarnessMarketplace[]
    /**
     * The key ({@link HarnessPluginEntry.key}) a folder of the harness's own install layout stands for, whether or
     * not the harness still lists it: how a ledger written before installs carried their key learns it.
     * @param name - the plugin's own name, for a layout that does not spell it.
     */
    identify?(home: string, root: string, name: string): string | undefined
  }
  /** The project assets of a session starting in `cwd`, as one plugin. */
  projectAssets?(cwd: string, home: string): ForeignPlugin | undefined
  /** Session import, when it can be done without the host. */
  readonly sessions?: SessionSourceAdapter
}
