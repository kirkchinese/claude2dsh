// The production dependency graph of the packed packages, as pnpm-lock.yaml resolves it, audited for what
// must not reach a DSH profile: a package with platform-specific binaries. In a DSH profile (pnpm 11,
// hoisted) such a package makes later plugin installs hang after "Done", so Harness Forge installs its
// bundler at run time instead (packages/plugin/src/mods/bundler.ts). The whole graph is walked, optional
// edges included, because a direct dependency can bring one in from any depth.

/** Packages known to pull platform-specific binaries in through optional dependencies. */
export const PLATFORM_BOUND: readonly RegExp[] = [/^rolldown$/u, /^@rolldown\//u, /^esbuild$/u, /^@esbuild\//u, /^lightningcss/u, /^@img\//u, /^sharp$/u, /^@swc\/core/u, /^@oxc-(parser|transform|resolver)\//u, /^@biomejs\//u]

/** The pnpm lockfile format this audit reads (pnpm 9 to 11 write it). */
export const LOCKFILE_VERSION = '9.0'

/** Production edges: what a consumer of the package installs. Peers are the host's, and dev edges are not installed. */
const PRODUCTION_FIELDS = ['dependencies', 'optionalDependencies'] as const

type Edges = Readonly<Record<string, string>>
interface Snapshot {
  readonly dependencies?: Edges
  readonly optionalDependencies?: Edges
}
interface Importer {
  readonly dependencies?: Readonly<Record<string, { readonly specifier: string; readonly version: string }>>
  readonly optionalDependencies?: Readonly<Record<string, { readonly specifier: string; readonly version: string }>>
}
interface Metadata {
  readonly os?: readonly string[]
  readonly cpu?: readonly string[]
  readonly libc?: readonly string[]
}
/** The parts of a pnpm-lock.yaml the audit reads. */
export interface PnpmLock {
  readonly lockfileVersion?: unknown
  readonly importers?: Readonly<Record<string, Importer>>
  readonly packages?: Readonly<Record<string, Metadata>>
  readonly snapshots?: Readonly<Record<string, Snapshot>>
}

/** One packed package: its folder relative to the lockfile, and its name. */
export interface Packed {
  readonly dir: string
  readonly name: string
}

/** A node of the walk: a snapshot key, or a workspace importer. */
interface Node {
  readonly key: string
  readonly label: string
  readonly importer: boolean
  readonly parent?: Node
}

/** `name@version`, without the peer suffix pnpm adds to a snapshot key. */
function metadataKey(snapshot: string): string {
  const peers = snapshot.indexOf('(')
  return peers < 0 ? snapshot : snapshot.slice(0, peers)
}

/** The package name of a `name@version` key. */
function nameOf(key: string): string {
  return key.slice(0, key.indexOf('@', 1))
}

/** Where an edge leads: a snapshot key, or (`link:`) a workspace importer relative to `from`. */
function target(name: string, version: string, from: string): { key: string; importer: boolean } {
  if (version.startsWith('link:')) {
    const parts = [...from.split('/'), ...version.slice('link:'.length).split('/')].filter(part => part.length > 0 && part !== '.')
    const resolved: string[] = []
    for (const part of parts) {
      if (part === '..') resolved.pop()
      else resolved.push(part)
    }
    return { key: resolved.join('/') || '.', importer: true }
  }
  // An alias (`npm:other@1.0.0`) is written as the key it resolves to.
  return { key: /^\d/u.test(version) ? `${name}@${version}` : version, importer: false }
}

function pathOf(node: Node): string {
  const labels: string[] = []
  for (let at: Node | undefined = node; at !== undefined; at = at.parent) labels.unshift(at.label)
  return labels.join(' > ')
}

function platformOf(meta: Metadata | undefined): string | undefined {
  const fields = (['os', 'cpu', 'libc'] as const).filter(field => (meta?.[field]?.length ?? 0) > 0)
  return fields.length === 0 ? undefined : fields.map(field => `${field}: ${meta![field]!.join(', ')}`).join('; ')
}

/**
 * The problems of the packed packages' production graph: each package that
 * declares `os`, `cpu` or `libc`, has such an optional dependency, or is on
 * {@link PLATFORM_BOUND}, named with the shortest path that brings it in.
 * Deterministic: edges are walked breadth first, in name order.
 * @returns the problems, and how many registry packages the graph holds.
 */
export function auditProductionGraph(lock: PnpmLock, packed: readonly Packed[]): { problems: string[]; packages: number } {
  if (lock.lockfileVersion !== LOCKFILE_VERSION) return { problems: [`pnpm-lock.yaml is lockfileVersion ${JSON.stringify(lock.lockfileVersion)}; the pack check reads ${LOCKFILE_VERSION}`], packages: 0 }
  const importers = lock.importers ?? {}
  const packages = lock.packages ?? {}
  const snapshots = lock.snapshots ?? {}
  const names = new Map(packed.map(item => [item.dir, item.name]))
  const problems: string[] = []
  const seen = new Set<string>()
  const queue: Node[] = []
  for (const item of packed) {
    seen.add(`importer:${item.dir}`)
    queue.push({ key: item.dir, label: item.name, importer: true })
  }
  while (queue.length > 0) {
    const node = queue.shift()!
    const edges: Array<{ name: string; version: string; optional: boolean }> = []
    if (node.importer) {
      const importer = importers[node.key]
      if (importer === undefined) {
        problems.push(`${pathOf(node)}: no importer ${node.key} in pnpm-lock.yaml`)
        continue
      }
      for (const field of PRODUCTION_FIELDS) for (const [name, edge] of Object.entries(importer[field] ?? {})) edges.push({ name, version: edge.version, optional: field === 'optionalDependencies' })
    } else {
      const name = nameOf(node.key)
      const meta = packages[metadataKey(node.key)]
      if (meta === undefined) problems.push(`${pathOf(node)}: ${node.key} is not in pnpm-lock.yaml's packages`)
      const platform = platformOf(meta)
      if (platform !== undefined) problems.push(`${pathOf(node)}: ${name} is platform-specific (${platform})`)
      else if (PLATFORM_BOUND.some(pattern => pattern.test(name))) problems.push(`${pathOf(node)}: ${name} brings platform-specific binaries in`)
      // Every registry package pnpm installs has a snapshot, its edges; without one, what it brings in is unknown.
      const snapshot = snapshots[node.key]
      if (snapshot === undefined) {
        problems.push(`${pathOf(node)}: ${node.key} has no snapshot in pnpm-lock.yaml, so what it brings in is not audited`)
        continue
      }
      for (const field of PRODUCTION_FIELDS) for (const [child, version] of Object.entries(snapshot[field] ?? {})) edges.push({ name: child, version, optional: field === 'optionalDependencies' })
      const bound = edges.filter(edge => edge.optional && platformOf(packages[metadataKey(target(edge.name, edge.version, '').key)]) !== undefined).map(edge => edge.name)
      if (bound.length > 0 && platform === undefined) problems.push(`${pathOf(node)}: ${name} has platform-specific optional dependencies (${bound.sort().join(', ')})`)
    }
    for (const edge of edges.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const next = target(edge.name, edge.version, node.importer ? node.key : '')
      const id = `${next.importer ? 'importer' : 'package'}:${next.key}`
      if (seen.has(id)) continue
      seen.add(id)
      queue.push({ key: next.key, label: next.importer ? names.get(next.key) ?? next.key : `${edge.name}${edge.optional ? ' (optional)' : ''}`, importer: next.importer, parent: node })
    }
  }
  return { problems, packages: [...seen].filter(id => id.startsWith('package:')).length }
}

/**
 * Importers whose production dependencies differ from their `package.json`:
 * a lockfile that is out of date would audit another graph.
 */
export function staleImporters(lock: PnpmLock, manifests: ReadonlyArray<Packed & { readonly manifest: Readonly<Record<string, unknown>> }>): string[] {
  const problems: string[] = []
  for (const { dir, name, manifest } of manifests) {
    const importer = lock.importers?.[dir]
    for (const field of PRODUCTION_FIELDS) {
      const declared = Object.entries((manifest[field] ?? {}) as Record<string, string>)
      const locked = importer?.[field] ?? {}
      if (declared.length !== Object.keys(locked).length || declared.some(([dependency, range]) => locked[dependency]?.specifier !== range)) {
        problems.push(`${name}: pnpm-lock.yaml's ${field} differ from package.json; run pnpm install`)
      }
    }
  }
  return problems
}
