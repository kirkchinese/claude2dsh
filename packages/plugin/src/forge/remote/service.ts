/**
 * Plugins from the network: open a marketplace (or a single plugin) someone
 * pasted, fetch one entry into a directory of Harness Forge's own, show what it
 * contains before anything runs, install it through the ledger like a local
 * plugin, and later check for updates, which are shown and confirmed the same
 * way. Nothing is written into `~/.claude`, `~/.codex`, OpenCode's
 * configuration or the DSH profile.
 *
 * What is installed is exactly what was shown: a prepared plugin waits in a
 * staging directory of its own, its files' digest bound to the confirmation;
 * the confirmation checks the digest again and moves it into a directory
 * named by its source, revision and digest, which is never replaced or
 * deleted while an install uses it.
 *
 * Layout under `<data>/remote/`:
 * - `state.json`: the marketplaces the person added and what was installed from where.
 * - `cache/git/<key>/<sha>/`: checkouts read to browse a marketplace and copied from.
 * - `staging/<random>/`: one prepared plugin waiting for its confirmation.
 * - `plugins/<key>/`: installed copies, keyed by source identity, revision and files.
 * @module @kirkchinese/harness-forge
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import {
  assess,
  DEFAULT_MARKETPLACES,
  describeSpec,
  detectSource,
  HarnessError,
  isInside,
  isPlainObject,
  kebabCase,
  marketplaceProblem,
  npmPage,
  pageOfSpec,
  parseMarketplace,
  parseRemoteInput,
  readMarketplace,
  specIdentity,
  specOfSource,
  type ForeignPlugin,
  type MarketplaceEntry,
  type MarketplaceIndex,
  type MarketplaceSource,
  type RemoteSpec,
} from '@kirkchinese/harness-forge-core'
import { messageOf } from '../../shared/util.js'
import { partOf } from '../../workbench/overview.js'
import { copyTree, treeDigest } from './archive.js'
import { adaptable, codePartsOf, type CodePart } from './code-parts.js'
import { dependenciesOf, RemoteFetcher, type FetchContext, type FetchDeps, type FetchLimits, type NpmDependencies } from './fetch.js'

/** How an install was reached, to fetch it again for an update. */
export type RemoteOrigin =
  /** An entry of a marketplace; `marketplace` is what was pasted for it, `marketIdentity` the source it names. */
  | { readonly kind: 'marketplace'; readonly marketplace: string; readonly marketIdentity: string; readonly marketplaceName: string; readonly entry: string }
  /** A plugin repository or package pasted directly. */
  | { readonly kind: 'direct'; readonly input: string }

/** One plugin installed from the network. */
export interface RemoteInstall {
  readonly pluginId: string
  readonly name: string
  readonly dialect: string
  readonly origin: RemoteOrigin
  /** The full source it was fetched from (marketplace source, entry and its source), not names a marketplace chose. */
  readonly identity: string
  /** Where it was fetched from, for the person. */
  readonly source: string
  readonly page?: string
  /** The full commit SHA, npm version or archive digest installed. */
  readonly revision: string
  /** The marketplace's commit it was listed at. */
  readonly marketRevision?: string
  /** An npm tarball's integrity. */
  readonly integrity?: string
  readonly registry?: string
  readonly root: string
  /** The directory this install uses; deleted once no install uses it. Absent only for a local folder installed in place before 0.4.1. */
  readonly dir?: string
  /** A digest of everything in `dir` as installed (an npm plugin's dependencies included). */
  readonly digest?: string
  readonly installedAt: string
  readonly updatedAt?: string
}

/** A marketplace the person added. */
export interface AddedSource {
  readonly input: string
  readonly name: string
  readonly harness: string
  readonly addedAt: string
}

interface RemoteState {
  readonly version: 1
  sources: AddedSource[]
  installs: RemoteInstall[]
}

/** One marketplace entry, as the workbench lists it. */
export interface EntryView {
  readonly name: string
  readonly description?: string
  readonly version?: string
  readonly category?: string
  /** Where it is fetched from (`marketplace` for a plugin inside the marketplace). */
  readonly from: string
  /** Why it cannot be installed, when it cannot. */
  readonly unsupported?: string
  /** The installed plugin's id, when this entry of this marketplace source is installed. */
  readonly installed?: string
}

/** What opening a pasted source shows. */
export interface SourceView {
  readonly kind: 'marketplace' | 'plugin'
  readonly input: string
  readonly name: string
  readonly description?: string
  readonly owner?: string
  readonly harness: string
  readonly source: string
  readonly page?: string
  readonly revision?: string
  readonly registry?: string
  readonly entries: readonly EntryView[]
  readonly warnings: readonly string[]
}

/** One part a confirmation lists. */
export interface ConfirmedPart {
  readonly kind: string
  readonly name: string
  /** Why it does not work in DSH, when it does not. */
  readonly gap?: string
  /** The same reasons the overview gives, as codes the browser words in the person's language. */
  readonly reasons?: ReadonlyArray<{ readonly code: string; readonly detail: string }>
  /** For an update: whether the part is new or its files changed. */
  readonly change?: 'new' | 'changed'
}

/** What the person confirms before an install or an update. */
export interface Confirmation {
  readonly token: string
  readonly name: string
  readonly version?: string
  readonly harness: string
  readonly source: string
  readonly page?: string
  readonly revision: string
  /** The npm registry it is downloaded from. */
  readonly registry?: string
  /** An npm plugin's dependencies: how many it declares, installed from `registry` once confirmed. */
  readonly dependencies?: number
  readonly parts: readonly ConfirmedPart[]
  /** The parts that would run code with the person's permissions, and whether each runs in DSH once installed. */
  readonly codeParts: readonly CodePart[]
  /** It has a gap an adapter could fill: the warning says an adapter would run code of its own. */
  readonly adaptable: boolean
  readonly works: number
  readonly total: number
  readonly warnings: readonly string[]
  /** The id it will have: already installed when an install of it exists. */
  readonly pluginId: string
  readonly alreadyInstalled: boolean
  /** Set for an update: the revisions, and the parts the new revision no longer has. */
  readonly update?: { readonly from: string; readonly to: string; readonly removed: readonly string[] }
}

/** One install's update status; `token` (when there is an update) is what preparing that exact update takes. */
export interface UpdateStatus {
  readonly pluginId: string
  readonly name: string
  readonly current: string
  readonly latest?: string
  readonly update: boolean
  readonly token?: string
  readonly error?: string
}

/** What a revision check found, and what an update must fetch. */
interface Pins {
  readonly revision: string
  readonly marketRevision?: string
  readonly integrity?: string
  readonly identity?: string
}

/** A fetched plugin before it is installed. */
interface Candidate {
  /** The plugin root, in its staging directory: a copy of Harness Forge's own, even for a folder on this computer. */
  readonly root: string
  /** The staging directory holding it, which nothing else uses. */
  readonly stage: string
  /** The digest of `root` when it was shown. */
  readonly digest: string
  readonly dialect: string
  readonly origin: RemoteOrigin
  readonly identity: string
  readonly source: string
  readonly page?: string
  readonly revision: string
  readonly marketRevision?: string
  readonly integrity?: string
  readonly registry?: string
  /** An npm package: its name and the dependencies to install once confirmed. */
  readonly npm?: { readonly name: string; readonly dependencies: NpmDependencies }
  /** What was left out of the copy (links). */
  readonly warnings?: readonly string[]
}

/** The installed copy a confirmation (or an update check) replaces, as it was when it was made. */
interface Base {
  readonly pluginId: string
  readonly root: string
  readonly revision: string
  readonly digest?: string
}

/** What the ledger offers this service. */
export interface RemoteHost {
  /** Scan a plugin root; with `replacing`, as the new copy of that installed plugin (its name is not taken by it). */
  scan(root: string, source: string, replacing?: string): ForeignPlugin
  /** Install a plugin root; resolves to its id. */
  install(root: string, source: string): Promise<{ pluginId: string; report: unknown }>
  /** Move an installed plugin to a new root. */
  reroot(pluginId: string, root: string, source: string): Promise<unknown>
  installed(pluginId: string): boolean
}

/** Pending confirmations and update checks are dropped after this long (and their files with them). */
const PENDING_MS = 30 * 60_000
/** The revision of a copy of a folder on this computer, which has no history to name one. */
const LOCAL_REVISION = 'local'
/** Entry fields that are the marketplace's, not the plugin manifest's. */
const ENTRY_ONLY = new Set(['source', 'strict', 'category', 'tags', 'policy', 'relevance', 'metadata', 'headers', 'headersHelper', 'defaultEnabled', 'engines'])
/** Component fields an entry adds to a `plugin.json` (Claude Code's strict mode). */
const COMPONENT_FIELDS = ['commands', 'agents', 'skills', 'hooks', 'outputStyles', 'themes'] as const

function short(revision: string): string {
  return /^[0-9a-f]{40}$/u.test(revision) ? revision.slice(0, 12) : revision
}

function safeName(value: string): string {
  return kebabCase(value).slice(0, 60) || 'plugin'
}

function marketplaceHarness(index: MarketplaceIndex): string {
  return index.manifestPath.replace(/\\/gu, '/').includes('/.agents/plugins/') ? 'codex' : 'claude-code'
}

/** Find the marketplace manifest of a checkout. */
function marketplaceIn(dir: string): MarketplaceIndex | undefined {
  for (const candidate of [join(dir, '.claude-plugin', 'marketplace.json'), join(dir, '.agents', 'plugins', 'marketplace.json')]) {
    if (existsSync(candidate)) return readMarketplace(candidate)
  }
  return undefined
}

function homePath(path: string): string {
  return resolve(path.replace(/^~(?=$|[/\\])/u, process.env['HOME'] ?? process.env['USERPROFILE'] ?? '~'))
}

function changed(what: string, now: string, checked: string): HarnessError {
  return new HarnessError('fetch-failed', `${what} changed since it was checked (now ${short(now)}, checked ${short(checked)})`, { suggestion: 'Check for updates again.' })
}

/** A part across revisions: its kind and name (ids carry the plugin's, which a copy elsewhere may not share). */
function partKey(component: { readonly kind: string; readonly name: string }): string {
  return `${component.kind}:${component.name}`
}

/** Each part's files and settings, to tell an update's new and changed parts. */
function partDigests(plugin: ForeignPlugin): Map<string, string> {
  const out = new Map<string, string>()
  for (const component of plugin.components) {
    const path = component.path === undefined ? undefined : resolve(plugin.root, component.path)
    let files = ''
    try {
      files = path !== undefined && existsSync(path) ? treeDigest(path) : ''
    } catch {
      files = ''
    }
    const settings = JSON.stringify(component.metadata ?? null).split(plugin.root).join('<root>')
    out.set(partKey(component), createHash('sha256').update(`${files}\0${settings}`).digest('hex'))
  }
  return out
}

/** The hosts in what the person pasted: what a proxy may be asked for on their say-so. */
function pastedHosts(...inputs: readonly string[]): string[] {
  return inputs.flatMap((input) => {
    try {
      const spec = parseRemoteInput(input)
      if (spec.kind !== 'git' && spec.kind !== 'json' && spec.kind !== 'archive') return []
      const scp = /^[\w.-]+@([\w.-]+):(?!\/\/)/u.exec(spec.url)
      return [scp !== null ? scp[1]! : new URL(spec.url).hostname]
    } catch {
      return []
    }
  })
}

/** An install as a confirmation or an update check binds it. */
function baseOf(install: RemoteInstall): Base {
  return { pluginId: install.pluginId, root: install.root, revision: install.revision, ...(install.digest !== undefined ? { digest: install.digest } : {}) }
}

/** Whether an install is still the copy `base` recorded. */
function sameBase(now: Base, base: Base): boolean {
  return now.pluginId === base.pluginId && now.root === base.root && now.revision === base.revision && now.digest === base.digest
}

/** What an origin's source was pasted as. */
function pastedOf(origin: RemoteOrigin): string {
  return origin.kind === 'direct' ? origin.input : origin.marketplace
}

/** A warning naming the links a copy left out, when it left any. */
function linkWarnings(skipped: readonly string[]): { warnings?: readonly string[] } {
  if (skipped.length === 0) return {}
  return { warnings: [`Links are not installed; left out: ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ` and ${String(skipped.length - 5)} more` : ''}`] }
}

/** The installed-plugins service. */
export class RemotePlugins {
  readonly fetcher: RemoteFetcher
  private state: RemoteState
  /** `base`: the installed copy the candidate replaces; `explicit` when the person asked to update it. */
  private readonly pending = new Map<string, { candidate: Candidate; name: string; at: number; base?: Base; explicit: boolean }>()
  /** `base`: the installed copy the check compared, which the update it found replaces. */
  private readonly checks = new Map<string, { pins: Pins; base: Base; at: number }>()
  private readonly statePath: string
  /** Fetching, installing and collecting run one at a time, so a collection never takes files being made or read. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(readonly root: string, private readonly host: RemoteHost, deps?: FetchDeps, limits?: FetchLimits) {
    this.fetcher = new RemoteFetcher(root, deps, limits)
    this.statePath = join(root, 'state.json')
    this.state = this.read()
  }

  private read(): RemoteState {
    try {
      const value = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<RemoteState>
      return {
        version: 1,
        sources: Array.isArray(value.sources) ? value.sources.filter(source => typeof source?.input === 'string') : [],
        installs: Array.isArray(value.installs) ? value.installs.filter(install => typeof install?.pluginId === 'string' && typeof install.root === 'string' && typeof install.identity === 'string') : [],
      }
    } catch {
      return { version: 1, sources: [], installs: [] }
    }
  }

  private persist(): void {
    mkdirSync(this.root, { recursive: true })
    const temporary = `${this.statePath}.tmp`
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8')
    renameSync(temporary, this.statePath)
  }

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }

  /**
   * The default and added marketplaces, and what was installed through Get plugins; an install taken from a
   * local marketplace's own folder names that marketplace (`localMarketplace`).
   */
  async sources(): Promise<{ defaults: typeof DEFAULT_MARKETPLACES; added: readonly AddedSource[]; installs: ReadonlyArray<RemoteInstall & { readonly localMarketplace?: string }>; git: boolean }> {
    return {
      defaults: DEFAULT_MARKETPLACES,
      added: this.state.sources.filter(source => !DEFAULT_MARKETPLACES.some(item => item.input === source.input)),
      installs: this.installs().map(install => (install.origin.kind === 'marketplace' && install.revision === LOCAL_REVISION ? { ...install, localMarketplace: install.origin.marketplaceName } : install)),
      git: await this.fetcher.hasGit(),
    }
  }

  /** Installs whose plugin is still in the ledger. */
  installs(): readonly RemoteInstall[] {
    return this.state.installs.filter(install => this.host.installed(install.pluginId))
  }

  // --- browsing ---------------------------------------------------------------

  /** Open what was pasted: a marketplace's entries, or one plugin. A marketplace opened from the network is remembered. */
  open(input: string): Promise<SourceView> {
    return this.exclusive(() => this.openNow(input))
  }

  private async openNow(input: string): Promise<SourceView> {
    this.collect()
    const spec = parseRemoteInput(input)
    const opened = await this.load(spec, this.fetcher.context('user', pastedHosts(input)))
    if (opened.index !== undefined) {
      const index = opened.index
      const harness = marketplaceHarness(index)
      if (spec.kind !== 'local' && !this.state.sources.some(source => source.input === input.trim())) {
        this.state.sources.push({ input: input.trim(), name: index.name, harness, addedAt: new Date().toISOString() })
        this.persist()
      }
      const marketIdentity = specIdentity(spec)
      const installed = new Map(this.installs().map(install => [install.identity, install.pluginId] as const))
      return {
        kind: 'marketplace',
        input: input.trim(),
        name: index.name,
        ...(index.description !== undefined ? { description: index.description } : {}),
        ...(index.owner !== undefined ? { owner: index.owner } : {}),
        harness,
        source: describeSpec(spec),
        ...(pageOfSpec(spec) !== undefined ? { page: pageOfSpec(spec)! } : {}),
        ...(opened.revision !== undefined ? { revision: short(opened.revision) } : {}),
        entries: index.entries.map(entry => this.entryView(entry, installed.get(this.entryIdentity(marketIdentity, index, entry)))),
        warnings: index.warnings,
      }
    }
    return {
      kind: 'plugin',
      input: input.trim(),
      name: opened.name ?? describeSpec(spec),
      harness: opened.harness ?? 'opencode',
      source: describeSpec(spec),
      ...(opened.page ?? pageOfSpec(spec)) !== undefined ? { page: (opened.page ?? pageOfSpec(spec))! } : {},
      ...(opened.revision !== undefined ? { revision: short(opened.revision) } : {}),
      ...(opened.registry !== undefined ? { registry: opened.registry } : {}),
      entries: [],
      warnings: [],
    }
  }

  /** Stop listing an added marketplace. */
  forget(input: string): boolean {
    const before = this.state.sources.length
    this.state.sources = this.state.sources.filter(source => source.input !== input.trim())
    if (this.state.sources.length === before) return false
    this.persist()
    return true
  }

  /** Why Harness Forge does not fetch an entry's source, or undefined when it does. */
  private problemOf(source: MarketplaceSource): string | undefined {
    if (source.kind === 'command') return 'runs a command from the marketplace on this computer'
    if (source.kind === 'path') return undefined
    const spec = specOfSource(source)
    if (spec === undefined) return `source "${source.kind}" is not supported`
    return marketplaceProblem(spec)
  }

  /** An entry's full identity: the marketplace's source, the entry, and the source the entry names (its path inside the marketplace, or its own). */
  private entryIdentity(marketIdentity: string, index: MarketplaceIndex, entry: MarketplaceEntry): string {
    const source = entry.source
    const own = source.kind === 'path' && source.path !== undefined
      ? `path:${relative(index.root, source.path).replace(/\\/gu, '/')}`
      : (() => {
          const spec = specOfSource(source)
          return spec === undefined ? source.kind : specIdentity(spec)
        })()
    return `${marketIdentity}!${entry.name}!${own}`
  }

  private entryView(entry: MarketplaceEntry, installed: string | undefined): EntryView {
    const source = entry.source
    const unsupported = this.problemOf(source)
    return {
      name: entry.name,
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      ...(entry.version !== undefined ? { version: entry.version } : {}),
      ...(entry.category !== undefined ? { category: entry.category } : {}),
      from: source.kind === 'path' ? 'marketplace' : source.kind === 'npm' ? `npm:${source.package ?? ''}` : source.url ?? source.kind,
      ...(unsupported !== undefined ? { unsupported } : {}),
      ...(installed !== undefined ? { installed } : {}),
    }
  }

  /** Read a source (at `sha`, for a git source being updated): a marketplace index with the commit it was read at, or what a single plugin is. */
  private async load(spec: RemoteSpec, context: FetchContext, sha?: string): Promise<{ index?: MarketplaceIndex; revision?: string; checkout?: string; name?: string; harness?: string; page?: string; registry?: string }> {
    switch (spec.kind) {
      case 'local': {
        const path = homePath(spec.path)
        const index = marketplaceIn(path) ?? (path.endsWith('.json') ? readMarketplace(path) : undefined)
        if (index !== undefined) return { index }
        return { name: basename(path), harness: detectSource(path), checkout: path }
      }
      case 'json': {
        const data = await this.fetcher.json(spec.url, context)
        return { index: parseMarketplace(data, join(this.root, 'cache', 'none'), spec.url, { filesAvailable: false }) }
      }
      case 'npm': {
        const found = await this.fetcher.npmLatest(spec, context)
        return { name: spec.package, harness: 'opencode', revision: found.version, registry: found.registry, page: npmPage(found.registry, found.name, found.version) }
      }
      case 'archive':
        return { name: basename(new URL(spec.url).pathname).replace(/\.zip$/iu, ''), harness: 'claude-code' }
      case 'git': {
        const { dir, sha: at } = await this.fetcher.checkout(spec, context, sha)
        const base = RemoteFetcher.inside(dir, spec.subpath)
        const index = marketplaceIn(base)
        if (index !== undefined) return { index, revision: at, checkout: base }
        const harness = detectSource(base)
        return { name: spec.subpath !== undefined ? basename(spec.subpath) : spec.github?.repo ?? basename(spec.url).replace(/\.git$/u, ''), harness, revision: at, checkout: base }
      }
    }
  }

  // --- installing ---------------------------------------------------------------

  /**
   * Fetch a plugin (a marketplace's `entry`, or the pasted source itself) and
   * say what it contains; nothing of it runs or is installed until
   * {@link install} gets the returned token.
   */
  prepare(input: string, entry?: string): Promise<Confirmation> {
    return this.exclusive(async () => {
      this.collect()
      const origin: RemoteOrigin = entry === undefined || entry.length === 0
        ? { kind: 'direct', input: input.trim() }
        : { kind: 'marketplace', marketplace: input.trim(), marketIdentity: '', marketplaceName: '', entry }
      return this.confirmation(await this.fetchCandidate(origin, this.fetcher.context('user', pastedHosts(input))))
    })
  }

  /**
   * Bind a staged candidate to a token and say what it contains (for an
   * update, what changed). A candidate from the source of an installed plugin
   * (the same identity) replaces that install when confirmed, as an update does.
   */
  private confirmation(candidate: Candidate, update?: RemoteInstall, checked?: Base): Confirmation {
    try {
      let replacing = update ?? this.installs().find(install => install.identity === candidate.identity)
      let plugin = this.host.scan(candidate.root, candidate.dialect, replacing?.pluginId)
      if (replacing !== undefined && plugin.id !== replacing.pluginId) {
        if (update !== undefined) throw new HarnessError('manifest-invalid', `the new revision is a different plugin (${plugin.id}, not ${update.pluginId})`, { suggestion: 'Remove the plugin and install the new one.' })
        replacing = undefined
        plugin = this.host.scan(candidate.root, candidate.dialect)
      }
      let before: Map<string, string> | undefined
      let removed: string[] = []
      if (update !== undefined) {
        try {
          const current = this.host.scan(update.root, update.dialect)
          before = partDigests(current)
          const kept = new Set(plugin.components.map(partKey))
          removed = current.components.filter(component => !kept.has(partKey(component))).map(component => component.name)
        } catch {
          before = new Map()
        }
      }
      const after = before !== undefined ? partDigests(plugin) : undefined
      const token = randomBytes(16).toString('hex')
      const base = checked ?? (replacing === undefined ? undefined : baseOf(replacing))
      this.pending.set(token, { candidate, name: plugin.displayName ?? plugin.name, at: Date.now(), ...(base !== undefined ? { base } : {}), explicit: update !== undefined })
      const dependencyCount = candidate.npm === undefined ? undefined : Object.keys(candidate.npm.dependencies.dependencies).length + Object.keys(candidate.npm.dependencies.optionalDependencies).length
      const gaps = new Map<string, string>()
      const allGaps = assess(plugin).gaps
      for (const gap of allGaps) if (gap.componentId !== undefined && !gaps.has(gap.componentId)) gaps.set(gap.componentId, gap.summary)
      const changeOf = (key: string): 'new' | 'changed' | undefined => {
        if (before === undefined || after === undefined) return undefined
        const was = before.get(key)
        return was === undefined ? 'new' : was !== after.get(key) ? 'changed' : undefined
      }
      return {
        token,
        name: plugin.displayName ?? plugin.name,
        ...(plugin.version !== undefined ? { version: plugin.version } : {}),
        harness: plugin.source,
        source: candidate.source,
        ...(candidate.page !== undefined ? { page: candidate.page } : {}),
        revision: short(candidate.revision),
        ...(candidate.registry !== undefined ? { registry: candidate.registry } : {}),
        ...(dependencyCount !== undefined ? { dependencies: dependencyCount } : {}),
        parts: plugin.components.map((component) => {
          const change = changeOf(partKey(component))
          const reasons = gaps.has(component.id) ? partOf(component, allGaps, undefined, undefined).reasons : []
          return { kind: component.kind, name: component.name, ...(gaps.has(component.id) ? { gap: gaps.get(component.id)! } : {}), ...(reasons.length > 0 ? { reasons } : {}), ...(change !== undefined ? { change } : {}) }
        }),
        codeParts: codePartsOf(plugin, allGaps),
        adaptable: adaptable(allGaps),
        works: plugin.components.filter(component => !gaps.has(component.id)).length,
        total: plugin.components.length,
        warnings: [...(candidate.warnings ?? []), ...plugin.warnings.map(warning => warning.message)],
        pluginId: plugin.id,
        alreadyInstalled: replacing !== undefined || this.host.installed(plugin.id),
        ...(update !== undefined ? { update: { from: short(update.revision), to: short(candidate.revision), removed } } : {}),
      }
    } catch (error: unknown) {
      this.discard(candidate)
      throw error
    }
  }

  /** Install (or, for an update, apply) exactly what {@link prepare} or {@link prepareUpdate} showed. */
  install(token: string): Promise<{ pluginId: string; report?: unknown; revision: string; updated: boolean }> {
    return this.exclusive(() => this.installNow(token))
  }

  private async installNow(token: string): Promise<{ pluginId: string; report?: unknown; revision: string; updated: boolean }> {
    const pending = this.pending.get(token)
    if (pending === undefined) throw new HarnessError('plan-not-found', 'this confirmation expired; open the plugin again', { suggestion: 'Choose Install again.' })
    this.pending.delete(token)
    const { candidate, base } = pending
    if (base !== undefined) {
      // Bound to the copy it replaces: confirming an older plan after a newer one was applied would roll it back.
      const now = this.state.installs.find(install => install.pluginId === base.pluginId)
      if (pending.explicit && (now === undefined || !this.host.installed(base.pluginId))) {
        this.discard(candidate)
        throw new HarnessError('not-installed', `${base.pluginId} is no longer installed`)
      }
      if (now !== undefined && !sameBase(baseOf(now), base)) {
        this.discard(candidate)
        throw new HarnessError('plan-not-found', `${base.pluginId} changed since this was prepared (it is at ${short(now.revision)} now)`, { suggestion: pending.explicit ? 'Check for updates again.' : 'Open the plugin again.' })
      }
    }
    // Named by its source, revision and files, so the same plugin fetched again shares the directory.
    const finalDir = join(this.root, 'plugins', createHash('sha256').update(`${candidate.identity}\0${candidate.revision}\0${candidate.digest}`).digest('hex').slice(0, 32))
    let root: string
    let result: { pluginId: string; report?: unknown }
    try {
      // Bound to what the confirmation showed: anything else is not installed.
      if (!existsSync(candidate.root) || treeDigest(candidate.root) !== candidate.digest) {
        throw new HarnessError('fetch-failed', 'the fetched files changed after they were shown; open the plugin again')
      }
      let inStage = relative(candidate.stage, candidate.root)
      if (candidate.npm !== undefined) {
        await this.fetcher.npmDependencies(candidate.stage, candidate.npm.dependencies, candidate.registry!, this.fetcher.context('user'))
        // Beside its dependencies, where Node looks for them.
        const placed = join(candidate.stage, 'node_modules', ...candidate.npm.name.split('/'))
        mkdirSync(dirname(placed), { recursive: true })
        renameSync(candidate.root, placed)
        inStage = relative(candidate.stage, placed)
      }
      const user = this.state.installs.find(install => install.dir !== undefined && resolve(install.dir) === resolve(finalDir))
      if (existsSync(finalDir) && user !== undefined) {
        // The same source, revision and files are installed already, if the directory still holds what was installed.
        if (user.digest === undefined || treeDigest(finalDir) !== user.digest) throw new HarnessError('fetch-failed', `the installed copy of ${user.name} changed on disk; remove the plugin and install it again`)
        rmSync(candidate.stage, { recursive: true, force: true })
      } else {
        rmSync(finalDir, { recursive: true, force: true })
        mkdirSync(dirname(finalDir), { recursive: true })
        renameSync(candidate.stage, finalDir)
      }
      root = join(finalDir, inStage)
      if (base !== undefined && (pending.explicit || this.host.installed(base.pluginId))) {
        // An update, or the source of an installed plugin again: its copy is replaced, keeping its id and the parts switched off.
        await this.host.reroot(base.pluginId, root, candidate.dialect)
        result = { pluginId: base.pluginId }
      } else {
        result = await this.host.install(root, candidate.dialect)
      }
    } catch (error: unknown) {
      this.discard(candidate)
      if (!this.inUse(finalDir)) rmSync(finalDir, { recursive: true, force: true })
      throw error
    }
    const digest = treeDigest(finalDir)
    const previous = this.state.installs.find(install => install.pluginId === result.pluginId)
    this.state.installs = this.state.installs.filter(install => install.pluginId !== result.pluginId)
    this.state.installs.push({
      pluginId: result.pluginId,
      name: pending.name,
      dialect: candidate.dialect,
      origin: candidate.origin,
      identity: candidate.identity,
      source: candidate.source,
      ...(candidate.page !== undefined ? { page: candidate.page } : {}),
      revision: candidate.revision,
      ...(candidate.marketRevision !== undefined ? { marketRevision: candidate.marketRevision } : {}),
      ...(candidate.integrity !== undefined ? { integrity: candidate.integrity } : {}),
      ...(candidate.registry !== undefined ? { registry: candidate.registry } : {}),
      root,
      dir: finalDir,
      digest,
      installedAt: previous?.installedAt ?? new Date().toISOString(),
      ...(previous !== undefined ? { updatedAt: new Date().toISOString() } : {}),
    })
    this.persist()
    if (previous?.dir !== undefined && previous.dir !== finalDir) this.deleteDir(previous.dir)
    return { ...result, revision: short(candidate.revision), updated: pending.explicit }
  }

  /** Drop a confirmation that was not taken, with its files. */
  cancel(token: string): boolean {
    const pending = this.pending.get(token)
    if (pending === undefined) return false
    this.pending.delete(token)
    this.discard(pending.candidate)
    return true
  }

  // --- updates --------------------------------------------------------------------

  /**
   * Compare each install's revision with what its source points at now. An
   * update found comes with a token: preparing it fetches exactly that
   * revision. One failing source does not stop the others.
   */
  checkUpdates(pluginId?: string): Promise<UpdateStatus[]> {
    return this.exclusive(async () => {
      this.collect()
      const context = this.fetcher.context('user', pastedHosts(...this.installs().map(install => pastedOf(install.origin))))
      const opened = new Map<string, Promise<Awaited<ReturnType<RemotePlugins['load']>>>>()
      const out: UpdateStatus[] = []
      for (const install of this.installs()) {
        if (pluginId !== undefined && install.pluginId !== pluginId) continue
        try {
          const pins = await this.latestPins(install, context, opened)
          const update = pins !== undefined && (pins.revision !== install.revision || (pins.integrity !== undefined && pins.integrity !== install.integrity) || (pins.identity !== undefined && pins.identity !== install.identity))
          let token: string | undefined
          if (update) {
            token = randomBytes(16).toString('hex')
            this.checks.set(token, { pins: pins!, base: baseOf(install), at: Date.now() })
          }
          out.push({ pluginId: install.pluginId, name: install.name, current: short(install.revision), ...(pins !== undefined ? { latest: short(pins.revision) } : {}), update, ...(token !== undefined ? { token } : {}) })
        } catch (error: unknown) {
          out.push({ pluginId: install.pluginId, name: install.name, current: short(install.revision), update: false, error: messageOf(error) })
        }
      }
      return out
    })
  }

  /**
   * Fetch the revision an update check found (the `token` it returned) and say
   * what it contains and what changed; {@link install} applies it. Refused
   * when the source no longer gives that revision.
   */
  prepareUpdate(pluginId: string, token: string): Promise<Confirmation> {
    return this.exclusive(async () => {
      this.collect()
      const check = this.checks.get(token)
      if (check === undefined || check.base.pluginId !== pluginId) throw new HarnessError('plan-not-found', 'this update check expired; check for updates again', { suggestion: 'Choose Check for updates again.' })
      this.checks.delete(token)
      const install = this.installs().find(item => item.pluginId === pluginId)
      if (install === undefined) throw new HarnessError('not-installed', `${pluginId} was not installed from the network`)
      // Bound to the copy the check compared: an update found against it does not apply to one installed since.
      if (!sameBase(baseOf(install), check.base)) throw new HarnessError('plan-not-found', `${pluginId} changed since the check (it is at ${short(install.revision)} now)`, { suggestion: 'Check for updates again.' })
      const candidate = await this.fetchCandidate(install.origin, this.fetcher.context('user', pastedHosts(pastedOf(install.origin))), check.pins)
      if (check.pins.identity !== undefined && candidate.identity !== check.pins.identity) {
        this.discard(candidate)
        throw new HarnessError('fetch-failed', 'the marketplace changed where this plugin comes from since the check', { suggestion: 'Check for updates again.' })
      }
      return this.confirmation(candidate, install, check.base)
    })
  }

  /** The plugin was removed from the ledger: forget its install and delete the files it used. */
  released(pluginId: string): void {
    const install = this.state.installs.find(item => item.pluginId === pluginId)
    if (install === undefined) return
    this.state.installs = this.state.installs.filter(item => item.pluginId !== pluginId)
    this.persist()
    if (install.dir !== undefined) this.deleteDir(install.dir)
  }

  /** What an install's source gives now, or undefined for a source that does not change (a local folder, an unpinned archive). */
  private async latestPins(install: RemoteInstall, context: FetchContext, opened: Map<string, Promise<Awaited<ReturnType<RemotePlugins['load']>>>>): Promise<Pins | undefined> {
    const origin = install.origin
    if (origin.kind === 'direct') {
      const spec = parseRemoteInput(origin.input)
      if (spec.kind === 'git') return { revision: await this.fetcher.latest(spec, context) }
      if (spec.kind === 'npm') {
        const found = await this.fetcher.npmLatest(spec, context)
        return { revision: found.version, integrity: found.integrity }
      }
      return undefined
    }
    const marketSpec = parseRemoteInput(origin.marketplace)
    let load = opened.get(origin.marketplace)
    if (load === undefined) {
      load = this.load(marketSpec, context)
      opened.set(origin.marketplace, load)
    }
    const { index, revision } = await load
    const entry = index?.entries.find(item => item.name === origin.entry)
    if (index === undefined || entry === undefined) throw new HarnessError('entry-not-found', `the marketplace no longer lists ${origin.entry}`)
    const identity = this.entryIdentity(specIdentity(marketSpec), index, entry)
    const market = revision !== undefined ? { marketRevision: revision } : {}
    if (entry.source.kind === 'path') return revision === undefined ? undefined : { revision, ...market, identity }
    const problem = this.problemOf(entry.source)
    if (problem !== undefined) throw new HarnessError('unsupported-source', `${entry.name}: ${problem}`)
    const source = specOfSource(entry.source)!
    const entryContext = RemoteFetcher.as(context, 'marketplace')
    if (source.kind === 'git') return { revision: await this.fetcher.latest(source, entryContext), ...market, identity }
    if (source.kind === 'npm') {
      const found = await this.fetcher.npmLatest(source, entryContext)
      return { revision: found.version, integrity: found.integrity, ...market, identity: `${specIdentity(marketSpec)}!${entry.name}!npm:${found.registry}:${found.name}` }
    }
    if (source.kind === 'archive' && source.sha256 !== undefined) return { revision: source.sha256, ...market, identity }
    return undefined
  }

  // --- fetching one plugin -----------------------------------------------------------

  /** A staging directory of its own, which only one candidate uses. */
  private newStage(): string {
    const dir = join(this.root, 'staging', randomBytes(12).toString('hex'))
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /** Run `fill` in a new staging directory; the candidate it returns gets the digest of its root. On failure the directory goes. */
  private async staged(fill: (stage: string) => Promise<Omit<Candidate, 'stage' | 'digest'>>): Promise<Candidate> {
    const stage = this.newStage()
    try {
      const candidate = await fill(stage)
      return { ...candidate, stage, digest: treeDigest(candidate.root) }
    } catch (error: unknown) {
      rmSync(stage, { recursive: true, force: true })
      throw error
    }
  }

  private async fetchCandidate(origin: RemoteOrigin, context: FetchContext, pins?: Pins): Promise<Candidate> {
    if (origin.kind === 'direct') {
      let spec = parseRemoteInput(origin.input)
      if (spec.kind === 'json') throw new HarnessError('unsupported-source', 'a marketplace.json lists plugins; choose one of them')
      const identity = specIdentity(spec)
      if (pins !== undefined && spec.kind === 'git') {
        if (spec.sha !== undefined && spec.sha !== pins.revision) throw changed('the pinned commit', spec.sha, pins.revision)
        spec = { ...spec, sha: pins.revision }
      }
      if (pins !== undefined && spec.kind === 'npm') spec = { ...spec, version: pins.revision }
      return this.fetchSpec(spec, origin, context, { identity, ...(pins !== undefined ? { pins } : {}) })
    }
    const marketSpec = parseRemoteInput(origin.marketplace)
    const marketIdentity = specIdentity(marketSpec)
    const { index, revision, checkout } = await this.load(marketSpec, context, pins?.marketRevision)
    if (index === undefined) throw new HarnessError('manifest-not-found', `${describeSpec(marketSpec)} has no marketplace.json`)
    if (pins?.marketRevision !== undefined && revision !== pins.marketRevision) throw changed('the marketplace', revision ?? 'none', pins.marketRevision)
    const entry = index.entries.find(item => item.name === origin.entry)
    if (entry === undefined) throw new HarnessError('entry-not-found', `marketplace ${index.name} has no plugin "${origin.entry}"`)
    const resolvedOrigin: RemoteOrigin = { kind: 'marketplace', marketplace: origin.marketplace, marketIdentity, marketplaceName: index.name, entry: entry.name }
    const identity = this.entryIdentity(marketIdentity, index, entry)
    const dialect = marketplaceHarness(index)
    const page = pageOfSpec(marketSpec)
    const market = revision !== undefined ? { marketRevision: revision } : {}
    if (entry.source.kind === 'path' && entry.source.path !== undefined) {
      const from = entry.source.path
      // A marketplace on this computer is another harness's folder, which it may refresh at any time: what is
      // shown and installed is a copy taken from it once, like a checkout's, and the folder itself is never used.
      const local = marketSpec.kind === 'local'
      const boundary = local ? index.root : checkout
      if (!local && (checkout === undefined || revision === undefined)) throw new HarnessError('unsupported-source', `${entry.name} is inside a marketplace fetched by URL, which has no files`)
      if (!local && pins !== undefined && pins.revision !== revision) throw changed(entry.name, revision ?? 'none', pins.revision)
      return this.staged(async (stage) => {
        const root = join(stage, safeName(entry.name))
        const skipped = copyTree(from, root, boundary)
        this.applyEntry(root, entry, dialect)
        return local
          ? { root, dialect, origin: resolvedOrigin, identity, source: from, revision: LOCAL_REVISION, ...linkWarnings(skipped) }
          : { root, dialect, origin: resolvedOrigin, identity, source: `${describeSpec(marketSpec)} → ${entry.name}`, ...(page !== undefined ? { page } : {}), revision: revision!, ...market, ...linkWarnings(skipped) }
      })
    }
    const problem = this.problemOf(entry.source)
    if (problem !== undefined) {
      throw new HarnessError('unsupported-source', entry.source.kind === 'command'
        ? `${entry.name} is produced by running a command on this computer; Harness Forge does not run marketplace commands`
        : `${entry.name}: ${problem}`)
    }
    let spec = specOfSource(entry.source)!
    if (pins !== undefined) {
      if (spec.kind === 'git') {
        if (spec.sha !== undefined && spec.sha !== pins.revision) throw changed(entry.name, spec.sha, pins.revision)
        spec = { ...spec, sha: pins.revision }
      } else if (spec.kind === 'npm') spec = { ...spec, version: pins.revision }
      else if (spec.kind === 'archive') spec = { ...spec, sha256: pins.revision }
    }
    return this.fetchSpec(spec, resolvedOrigin, RemoteFetcher.as(context, 'marketplace'), { identity, entry, dialect, ...market, ...(pins !== undefined ? { pins } : {}), marketIdentity: `${marketIdentity}!${entry.name}` })
  }

  /** Fetch a git, npm or archive source into a staging directory of its own. */
  private async fetchSpec(spec: RemoteSpec, origin: RemoteOrigin, context: FetchContext, options: { readonly identity: string; readonly entry?: MarketplaceEntry; readonly dialect?: string; readonly marketRevision?: string; readonly pins?: Pins; readonly marketIdentity?: string }): Promise<Candidate> {
    const { entry, dialect: marketDialect, pins } = options
    const page = pageOfSpec(spec)
    const common = { origin, identity: options.identity, source: describeSpec(spec), ...(page !== undefined ? { page } : {}), ...(options.marketRevision !== undefined ? { marketRevision: options.marketRevision } : {}) }
    switch (spec.kind) {
      case 'local': {
        // A folder on this computer is copied like a checkout: what is shown and installed cannot change under it.
        const from = homePath(spec.path)
        return this.staged(async (stage) => {
          const root = join(stage, safeName(basename(from)))
          const skipped = copyTree(from, root)
          return { ...common, root, dialect: marketDialect ?? detectSource(root), revision: LOCAL_REVISION, ...linkWarnings(skipped) }
        })
      }
      case 'git': {
        const { dir: checkout, sha } = await this.fetcher.checkout(spec, context)
        if (pins !== undefined && sha !== pins.revision) throw changed('the source', sha, pins.revision)
        const from = RemoteFetcher.inside(checkout, spec.subpath)
        const name = entry?.name ?? (spec.subpath !== undefined ? basename(spec.subpath) : spec.github?.repo ?? basename(spec.url).replace(/\.git$/u, ''))
        const dialect = marketDialect ?? detectSource(from)
        return this.staged(async (stage) => {
          const root = join(stage, safeName(name))
          const skipped = copyTree(from, root, checkout)
          if (entry !== undefined) this.applyEntry(root, entry, dialect)
          return { ...common, root, dialect, revision: sha, ...linkWarnings(skipped) }
        })
      }
      case 'npm': {
        const found = await this.fetcher.npmLatest(spec, context)
        if (pins !== undefined && found.version !== pins.revision) throw changed(spec.package, found.version, pins.revision)
        if (pins?.integrity !== undefined && found.integrity !== pins.integrity) throw new HarnessError('fetch-failed', `${spec.package}@${found.version} is not the tarball that was checked`, { suggestion: 'Check for updates again.' })
        const registryIdentity = `npm:${found.registry}:${found.name}`
        return this.staged(async (stage) => {
          const { dir, manifest } = await this.fetcher.npmFetch(found, stage, context)
          const dependencies = dependenciesOf(manifest)
          if (entry !== undefined && marketDialect !== undefined) this.applyEntry(dir, entry, marketDialect)
          return {
            ...common,
            identity: options.marketIdentity !== undefined ? `${options.marketIdentity}!${registryIdentity}` : registryIdentity,
            source: `npm:${found.name}@${found.version}`,
            page: npmPage(found.registry, found.name, found.version),
            root: dir,
            dialect: marketDialect ?? detectSource(dir),
            revision: found.version,
            integrity: found.integrity,
            registry: found.registry,
            npm: { name: found.name, dependencies },
          }
        })
      }
      case 'archive':
        return this.staged(async (stage) => {
          const { root, digest } = await this.fetcher.archive(spec, join(stage, 'archive'), context)
          if (entry !== undefined && marketDialect !== undefined) this.applyEntry(root, entry, marketDialect)
          return { ...common, root, dialect: marketDialect ?? detectSource(root), revision: digest }
        })
      case 'json':
        throw new HarnessError('unsupported-source', 'a marketplace.json lists plugins; choose one of them')
    }
  }

  /**
   * A Claude Code marketplace entry is also manifest (code.claude.com, "How an
   * entry combines with plugin.json"): with no `plugin.json`, the entry is the
   * manifest; with one, the entry's component fields are added to it unless the
   * entry says `"strict": false`, where they conflict. The copy is Harness
   * Forge's own, so the combined manifest is written into it and read by the
   * scanner like any other.
   */
  private applyEntry(root: string, entry: MarketplaceEntry, dialect: string): void {
    if (dialect !== 'claude-code') return
    const path = join(root, '.claude-plugin', 'plugin.json')
    const fields = entry.fields
    const own = existsSync(path) ? (() => {
      try {
        const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
        return isPlainObject(value) ? value : undefined
      } catch {
        return undefined
      }
    })() : undefined
    const declared = COMPONENT_FIELDS.filter(key => fields[key] !== undefined)
    if (own !== undefined) {
      if (declared.length === 0) return
      if (fields['strict'] === false) throw new HarnessError('manifest-invalid', `Plugin ${entry.name} has conflicting manifests: both plugin.json and marketplace entry specify components`)
      const merged: Record<string, unknown> = { ...own }
      for (const key of declared) {
        if (key === 'hooks') {
          merged['hooks'] = isPlainObject(fields['hooks']) && isPlainObject(own['hooks']) ? { ...own['hooks'], ...fields['hooks'] } : fields['hooks']
          continue
        }
        const list = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : [value]
        // Appended paths supplement the default directory; the scanner reads an explicit command list instead of it, so it is named.
        merged[key] = [...list(own[key] ?? (key === 'commands' ? './commands' : undefined)), ...list(fields[key])]
      }
      writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
      return
    }
    const manifest: Record<string, unknown> = { name: entry.name }
    for (const [key, value] of Object.entries(fields)) if (!ENTRY_ONLY.has(key)) manifest[key] = value
    mkdirSync(join(root, '.claude-plugin'), { recursive: true })
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  }

  // --- files ------------------------------------------------------------------------

  /** Whether an install uses a directory under `plugins/`. */
  private inUse(dir: string): boolean {
    const target = resolve(dir)
    return this.state.installs.some(install => install.dir !== undefined && resolve(install.dir) === target)
  }

  /** Delete a candidate's staging directory; it is the candidate's alone. */
  private discard(candidate: Candidate): void {
    const staging = resolve(this.root, 'staging')
    if (isInside(staging, resolve(candidate.stage))) rmSync(candidate.stage, { recursive: true, force: true })
  }

  /** Delete an installed copy under `plugins/` once no install uses it. Never anything outside it. */
  private deleteDir(dir: string): void {
    const plugins = resolve(this.root, 'plugins')
    const target = resolve(dir)
    if (!isInside(plugins, target) || this.inUse(target)) return
    rmSync(target, { recursive: true, force: true })
  }

  /**
   * Drop expired confirmations and update checks, staging directories no
   * confirmation holds, copies no install uses (an interrupted install), and
   * all but the newest checkout of each source. Runs inside the queue, so no
   * fetch is writing or reading them.
   */
  private collect(): void {
    const now = Date.now()
    for (const [token, pending] of this.pending) {
      if (now - pending.at < PENDING_MS) continue
      this.pending.delete(token)
      this.discard(pending.candidate)
    }
    for (const [token, check] of this.checks) if (now - check.at >= PENDING_MS) this.checks.delete(token)
    const held = new Set([...this.pending.values()].map(pending => resolve(pending.candidate.stage)))
    const used = new Set(this.state.installs.flatMap(install => install.dir !== undefined ? [resolve(install.dir)] : []))
    const sweep = (parent: string, keep: (path: string) => boolean): void => {
      if (!existsSync(parent)) return
      for (const name of readdirSync(parent)) {
        const path = resolve(parent, name)
        if (!keep(path)) rmSync(path, { recursive: true, force: true })
      }
    }
    sweep(join(this.root, 'staging'), path => held.has(path))
    sweep(join(this.root, 'plugins'), path => used.has(path))
    const git = join(this.root, 'cache', 'git')
    if (!existsSync(git)) return
    for (const key of readdirSync(git)) {
      const keyDir = join(git, key)
      let checkouts: Array<{ path: string; at: number }>
      try {
        checkouts = readdirSync(keyDir).map(name => ({ path: join(keyDir, name), at: statSync(join(keyDir, name)).mtimeMs }))
      } catch {
        continue
      }
      const newest = checkouts.filter(item => !basename(item.path).startsWith('.tmp-')).sort((a, b) => b.at - a.at)[0]
      for (const item of checkouts) if (item !== newest) rmSync(item.path, { recursive: true, force: true })
    }
  }
}
