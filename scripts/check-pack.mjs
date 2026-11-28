// Packs core and plugin the way `pnpm publish` would and checks what would ship:
// the plugin's manifest names a concrete core version (pnpm rewrites `workspace:*`; `npm publish` would not),
// every `exports` target of each package is inside its tarball, and nothing in their production dependency graph
// (pnpm-lock.yaml, optional edges included) has platform-specific binaries: see scripts/pack-graph.ts.
// Every compiled file under lib/ comes from a source file under src/, so output left by a removed module never ships.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { auditProductionGraph, PLATFORM_BOUND, staleImporters } from './pack-graph.ts'

// The workspace root has no dependencies of its own; the testkit (never packed) provides the YAML reader.
const { parse } = createRequire(join(import.meta.dirname, '..', 'packages', 'testkit', 'package.json'))('yaml')

const packages = [
  { dir: 'packages/core', name: '@kirkchinese/harness-forge-core' },
  // `build:client` (tsdown) bundles src/client/index.tsx into lib/client.js: the one compiled file with no same-named source.
  { dir: 'packages/plugin', name: '@kirkchinese/harness-forge', bundles: ['lib/client.js'] },
]
/** Compiled outputs of a TypeScript source file, and the source extensions tsc compiles to them. */
const COMPILED = /\.(?:js|d\.ts|js\.map|d\.ts\.map)$/u
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts']
const out = mkdtempSync(join(tmpdir(), 'harness-forge-pack-'))
const problems = []
const manifests = new Map()
const run = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, shell: process.platform === 'win32' && file === 'pnpm', ...options })

try {
  for (const { dir, name, bundles = [] } of packages) {
    run('pnpm', ['pack', '--pack-destination', out], { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] })
    const tarball = readdirSync(out).find(file => file.startsWith(name.replace('@', '').replace('/', '-')) && file.endsWith('.tgz'))
    if (tarball === undefined) {
      problems.push(`${name}: pnpm pack produced no tarball`)
      continue
    }
    const path = join(out, tarball)
    const files = new Set(run('tar', ['-tzf', path]).split(/\r?\n/u).filter(Boolean).map(file => file.replace(/^package\//u, '')))
    const manifest = JSON.parse(run('tar', ['-xzOf', path, 'package/package.json']))
    manifests.set(name, manifest)
    for (const file of [...files].filter(file => file.startsWith('lib/') && COMPILED.test(file) && !bundles.includes(file))) {
      const stem = join(dir, 'src', file.slice('lib/'.length).replace(COMPILED, ''))
      if (!SOURCE_EXTENSIONS.some(extension => existsSync(`${stem}${extension}`))) problems.push(`${name}: ${file} has no source in src/ (output of a removed module?)`)
    }
    // Peers are the host's (DSH's own packages), not in this lockfile's production graph: their names are checked.
    for (const dependency of Object.keys(manifest.peerDependencies ?? {})) {
      if (PLATFORM_BOUND.some(pattern => pattern.test(dependency))) problems.push(`${name}: peerDependencies.${dependency} brings platform-specific binaries into a DSH profile; load it at run time instead`)
    }
    const targets = []
    const walk = (value) => {
      if (typeof value === 'string') targets.push(value)
      else if (value !== null && typeof value === 'object') Object.values(value).forEach(walk)
    }
    walk(manifest.exports)
    for (const field of ['main', 'types']) if (typeof manifest[field] === 'string') targets.push(manifest[field])
    for (const target of new Set(targets)) {
      const wanted = target.replace(/^\.\//u, '')
      if (wanted.includes('*')) {
        const [head, tail] = wanted.split('*')
        if (![...files].some(file => file.startsWith(head) && file.endsWith(tail))) problems.push(`${name}: no file in the tarball matches exports target ${target}`)
      } else if (!files.has(wanted)) {
        problems.push(`${name}: exports target ${target} is not in the tarball`)
      }
    }
    // Plugin Manager shows `meta.detail` of `locale/<language>.json` (else the README) as the bundle's page, and omits raw HTML.
    const documents = new Set(files.has('README.md') ? ['README.md'] : [])
    for (const file of [...files].filter(file => /^locale\/[^/]+\.json$/u.test(file))) {
      const detail = JSON.parse(run('tar', ['-xzOf', path, `package/${file}`])).meta?.detail
      if (detail === undefined) continue
      if (!files.has(detail)) problems.push(`${name}: ${file} names detail document ${detail}, which is not in the tarball`)
      else documents.add(detail)
    }
    for (const document of documents) {
      const text = run('tar', ['-xzOf', path, `package/${document}`]).replace(/```[\s\S]*?```/gu, '').replace(/`[^`\n]*`/gu, '')
      const html = /<\/?[A-Za-z][\w-]*(?:\s[^<>]*)?>/u.exec(text)
      if (html !== null) problems.push(`${name}: ${document} contains raw HTML (${html[0]}), which Plugin Manager omits`)
      // Plugin Manager loads a document's relative images from beside it, so each one has to ship.
      for (const [, target] of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)/gu)) {
        if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/iu.test(target)) continue
        const image = posix.normalize(posix.join(posix.dirname(document), target))
        if (!files.has(image)) problems.push(`${name}: ${document} shows ${target}, which is not in the tarball`)
      }
    }
    console.log(`${name}@${manifest.version}: ${files.size} files, ${new Set(targets).size} export targets checked, detail documents: ${[...documents].join(', ') || 'none'}`)
  }
  const lock = parse(readFileSync('pnpm-lock.yaml', 'utf8'))
  const sources = packages.map(item => ({ ...item, manifest: JSON.parse(readFileSync(join(item.dir, 'package.json'), 'utf8')) }))
  problems.push(...staleImporters(lock, sources))
  const graph = auditProductionGraph(lock, packages)
  for (const problem of graph.problems) problems.push(`${problem}; a DSH profile would install it, so load it at run time instead`)
  console.log(`production dependency graph: ${String(graph.packages)} packages, ${graph.problems.length === 0 ? 'nothing platform-specific' : `${String(graph.problems.length)} platform-specific`}`)
  const core = manifests.get(packages[0].name)
  const plugin = manifests.get(packages[1].name)
  if (core !== undefined && plugin !== undefined) {
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']) {
      for (const [dependency, range] of Object.entries(plugin[field] ?? {})) {
        if (String(range).startsWith('workspace:')) problems.push(`plugin manifest ${field}.${dependency} is still "${range}"`)
      }
    }
    const range = plugin.dependencies?.[core.name]
    if (range !== core.version) problems.push(`plugin depends on ${core.name} "${String(range)}", expected the packed core version ${core.version}`)
  }
} finally {
  rmSync(out, { recursive: true, force: true })
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`error: ${problem}`)
  process.exit(1)
}
console.log('pack check passed')
