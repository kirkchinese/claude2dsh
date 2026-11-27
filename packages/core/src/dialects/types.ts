/**
 * The dialect contract: everything Harness Forge needs to know about one
 * harness's on-disk formats. A community dialect implements this interface and
 * is added with `registerDialect`; discovery, detection and scanning go
 * through the registry instead of naming harnesses.
 * @module @kirkchinese/harness-forge-core
 */
import type { ForeignPlugin, SourceId } from '../types.js'
import type { SessionSourceAdapter } from '../sessions/adapter.js'

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

/** One plugin the harness itself has installed, or a marketplace it added offers. */
export interface HarnessPluginEntry {
  readonly root: string
  readonly origin: 'installed' | 'marketplace'
  readonly enabled?: boolean
  readonly marketplace?: string
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
    /** What the directory lacks when `scan` finds nothing, for the error. */
    readonly emptyMessage: string
  }
  /**
   * Plugins the harness keeps a record of: when `root` is a discovery root it
   * is read through this list instead of being walked.
   */
  readonly harnessPlugins?: {
    root(home: string): string
    list(home: string): HarnessPluginEntry[]
  }
  /** The project assets of a session starting in `cwd`, as one plugin. */
  projectAssets?(cwd: string, home: string): ForeignPlugin | undefined
  /** Session import, when it can be done without the host. */
  readonly sessions?: SessionSourceAdapter
}
