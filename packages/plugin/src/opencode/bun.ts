/**
 * Bun for OpenCode plugins: OpenCode runs its plugins in Bun, so Harness
 * Forge does too. A Bun on PATH or in `~/.bun` is used; otherwise one is
 * installed once into Harness Forge's data directory from npm.
 *
 * The install is the platform package (`@oven/bun-linux-x64`, ...), which
 * holds the real binary and has no install script. The `bun` package would
 * need its postinstall script to put that binary in place, and npm setups that
 * block install scripts (`ignore-scripts=true`, the script policies of newer
 * npm) leave a placeholder that does not run.
 * @module @kirkchinese/harness-forge/opencode
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { npmInstall, runProcess } from '../forge/npm.js'

export { npmLaunch, type Launch, type NpmEnvironment } from '../forge/npm.js'

const EXE = process.platform === 'win32' ? 'bun.exe' : 'bun'

/** What decides which platform package fits this machine. */
export interface BunPlatform {
  readonly os: NodeJS.Platform
  readonly arch: string
  /** Linux with musl libc (Alpine). */
  readonly musl?: boolean
  /** Whether the CPU runs AVX2 code; `undefined` when that is not known. */
  readonly avx2?: boolean
}

/** One npm package that holds a Bun binary, and where the binary is inside it. */
export interface BunPackage {
  readonly name: string
  readonly exe: string
}

/**
 * The platform packages whose binary suits `platform`, best first, as the `bun`
 * package's own installer chooses them: by OS, CPU and libc, with the
 * `-baseline` build (no AVX2 needed) as the fallback, or first on a CPU known
 * to lack AVX2. Empty for a platform Bun is not built for.
 */
export function bunPackages(platform: BunPlatform): BunPackage[] {
  const arch = platform.arch === 'x64' ? 'x64' : platform.arch === 'arm64' ? 'aarch64' : undefined
  if (arch === undefined) return []
  const base = ((): string | undefined => {
    switch (platform.os) {
      case 'darwin': return `bun-darwin-${arch}`
      case 'linux': return `bun-linux-${arch}${platform.musl === true ? '-musl' : ''}`
      case 'android': return `bun-linux-${arch}-android`
      case 'freebsd': return `bun-freebsd-${arch}`
      case 'win32': return `bun-windows-${arch}`
      default: return undefined
    }
  })()
  if (base === undefined) return []
  const exe = platform.os === 'win32' ? 'bin/bun.exe' : 'bin/bun'
  const full: BunPackage = { name: `@oven/${base}`, exe }
  // Only x64 has baseline builds (arm64 and Android have none).
  const baseline: BunPackage[] = arch === 'x64' && platform.os !== 'android' && platform.os !== 'freebsd' ? [{ name: `@oven/${base}-baseline`, exe }] : []
  return platform.avx2 === false ? [...baseline, full] : [full, ...baseline]
}

/** Whether this process runs on glibc-less Linux, the way the `bun` package decides it. */
function isMusl(): boolean {
  if (process.platform !== 'linux') return false
  try {
    const report = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header
    if (report !== undefined) return report.glibcVersionRuntime === undefined
  } catch {
    // Fall through to the Alpine marker.
  }
  return existsSync('/etc/alpine-release')
}

/** The machine's platform, with the CPU's AVX2 support where it can be read cheaply (Linux). */
function currentPlatform(): BunPlatform {
  let avx2: boolean | undefined
  if (process.platform === 'linux') {
    try {
      avx2 = /\bavx2\b/u.test(readFileSync('/proc/cpuinfo', 'utf8'))
    } catch {
      avx2 = undefined
    }
  }
  return { os: process.platform, arch: process.arch, musl: isMusl(), ...avx2 !== undefined ? { avx2 } : {} }
}

/** The first Bun that answers `--version`. */
function working(candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 })
    if (probe.status === 0 && /^\d+\.\d+/u.test(probe.stdout.trim())) return candidate
  }
  return undefined
}

/** What {@link ensureBun} does outside its own logic; tests replace it. */
export interface BunHost {
  readonly platform: BunPlatform
  /** The first of `candidates` that is a working Bun. */
  working(candidates: readonly string[]): string | undefined
  /** `npm install <name>` into `prefix`. */
  install(name: string, prefix: string): Promise<void>
}

const defaultHost: BunHost = {
  get platform() { return currentPlatform() },
  working,
  // No install scripts run: the platform package has none, and a policy that blocks them must not matter.
  install: (name, prefix) => npmInstall([name], prefix),
}

/** Where a Bun is looked for, in order: the person's, then the one Harness Forge installed. */
function candidates(dataRoot: string, packages: readonly BunPackage[]): string[] {
  const prefix = join(dataRoot, 'bun')
  return [
    ...(process.env['BUN_PATH'] !== undefined ? [process.env['BUN_PATH']] : []),
    'bun',
    join(homedir(), '.bun', 'bin', EXE),
    ...packages.map(item => localBinary(prefix, item)),
    // Earlier versions installed the `bun` package; its binary counts when it works.
    join(prefix, 'node_modules', 'bun', 'bin', 'bun.exe'),
  ]
}

function localBinary(prefix: string, item: BunPackage): string {
  return join(prefix, 'node_modules', ...item.name.split('/'), ...item.exe.split('/'))
}

/** The Bun OpenCode plugins would use, without installing one. */
export function findBun(dataRoot: string, host: BunHost = defaultHost): string | undefined {
  return host.working(candidates(dataRoot, bunPackages(host.platform)))
}

/** Find Bun, installing it under `dataRoot` when the machine has none. */
export async function ensureBun(dataRoot: string, host: BunHost = defaultHost): Promise<string> {
  const prefix = join(dataRoot, 'bun')
  const packages = bunPackages(host.platform)
  const localOf = (item: BunPackage): string => localBinary(prefix, item)
  const found = host.working(candidates(dataRoot, packages))
  if (found !== undefined) return found
  const problems: string[] = []
  if (packages.length === 0) problems.push(`Bun has no build for ${host.platform.os} ${host.platform.arch}`)
  for (const item of packages) {
    try {
      await host.install(item.name, prefix)
    } catch (error: unknown) {
      problems.push(`${item.name}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const installed = host.working([localOf(item)])
    if (installed !== undefined) return installed
    problems.push(`${item.name} was installed into ${prefix} but does not run`)
  }
  throw new Error(`Bun is needed to run OpenCode plugins and could not be installed automatically (${problems.join('; ')}). Install Bun (https://bun.sh), or set BUN_PATH to a working bun executable, then restart DSH.`)
}

/**
 * Install a plugin's dependencies the way OpenCode installs a plugin package:
 * production dependencies, no lifecycle scripts of the plugin's own repository.
 * A plugin whose dependencies are present already is left as it is.
 */
export async function ensureDependencies(bun: string, root: string): Promise<void> {
  const manifest = join(root, 'package.json')
  if (!existsSync(manifest)) return
  let declared: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>
    declared = { ...(parsed['dependencies'] as Record<string, unknown> ?? {}), ...(parsed['peerDependencies'] as Record<string, unknown> ?? {}) }
  } catch {
    return
  }
  const missing = Object.keys(declared).filter(name => !existsSync(join(root, 'node_modules', ...name.split('/'))))
  if (missing.length === 0) return
  await runProcess(bun, ['install', '--production', '--ignore-scripts'], root, 600_000)
}
