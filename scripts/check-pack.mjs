// Packs core and plugin the way `pnpm publish` would and checks what would ship:
// the plugin's manifest names a concrete core version (pnpm rewrites `workspace:*`; `npm publish` would not),
// every `exports` target of each package is inside its tarball, and no package ships a dependency on a
// package with platform-specific optional binaries: in a DSH profile (pnpm 11, hoisted) such a package makes later
// plugin installs hang after "Done". Harness Forge installs its bundler at run time instead (packages/plugin/src/mods/bundler.ts).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const packages = [
  { dir: 'packages/core', name: '@kirkchinese/harness-forge-core' },
  { dir: 'packages/plugin', name: '@kirkchinese/harness-forge' },
]
/** Packages that pull platform-specific binaries in through optional dependencies. */
const PLATFORM_BOUND = [/^rolldown$/u, /^@rolldown\//u, /^esbuild$/u, /^@esbuild\//u, /^lightningcss/u, /^@img\//u, /^sharp$/u, /^@swc\/core/u, /^@oxc-(parser|transform|resolver)\//u, /^@biomejs\//u]
const out = mkdtempSync(join(tmpdir(), 'harness-forge-pack-'))
const problems = []
const manifests = new Map()
const run = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, shell: process.platform === 'win32' && file === 'pnpm', ...options })

try {
  for (const { dir, name } of packages) {
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
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const dependency of Object.keys(manifest[field] ?? {})) {
        if (PLATFORM_BOUND.some(pattern => pattern.test(dependency))) problems.push(`${name}: ${field}.${dependency} brings platform-specific binaries into a DSH profile; load it at run time instead`)
      }
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
    console.log(`${name}@${manifest.version}: ${files.size} files, ${new Set(targets).size} export targets checked`)
  }
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
