/**
 * The bundler of Claude Code mods: rolldown, fetched on first use into
 * Harness Forge's data directory, as Bun is for OpenCode plugins.
 *
 * rolldown is not a dependency of Harness Forge: its native binding comes as
 * platform-specific optional dependencies, and once a DSH profile's
 * `node_modules` holds such a package, pnpm (11.x, hoisted) stops exiting
 * after later installs, so every plugin installed after Harness Forge would
 * stall. Installed here with npm, outside the profile, it never reaches pnpm.
 * The install is the pinned `rolldown` and the one binding package rolldown's
 * own loader picks for this machine; neither has an install script.
 * @module @kirkchinese/harness-forge/mods
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { npmInstall } from '../forge/npm.js'
import type { Bundler } from './loader.js'

/** The rolldown version mods are bundled with. */
export const ROLLDOWN_VERSION = '1.3.2'

/** What decides which binding package fits this machine. */
export interface BundlerPlatform {
  readonly os: NodeJS.Platform
  readonly arch: string
  /** Linux with musl libc (Alpine). */
  readonly musl?: boolean
}

/**
 * The `@rolldown/binding-*` package rolldown loads on `platform`, as its
 * binding loader picks it, among those rolldown publishes (its
 * `optionalDependencies`). Undefined where rolldown has no native build.
 */
export function rolldownBinding(platform: BundlerPlatform): string | undefined {
  const { os, arch } = platform
  const libc = platform.musl === true ? 'musl' : 'gnu'
  const target = ((): string | undefined => {
    switch (os) {
      case 'darwin': return arch === 'x64' || arch === 'arm64' ? `darwin-${arch}` : undefined
      case 'win32': return arch === 'x64' || arch === 'arm64' ? `win32-${arch}-msvc` : undefined
      case 'freebsd': return arch === 'x64' ? 'freebsd-x64' : undefined
      case 'android': return arch === 'arm64' ? 'android-arm64' : arch === 'arm' ? 'android-arm-eabi' : undefined
      case 'openharmony' as NodeJS.Platform: return arch === 'arm64' ? 'openharmony-arm64' : undefined
      case 'linux':
        if (arch === 'x64' || arch === 'arm64') return `linux-${arch}-${libc}`
        if (libc === 'musl') return undefined
        if (arch === 'arm') return 'linux-arm-gnueabihf'
        if (arch === 'ppc64' || arch === 's390x') return `linux-${arch}-gnu`
        return undefined
      default: return undefined
    }
  })()
  return target === undefined ? undefined : `@rolldown/binding-${target}`
}

/** Whether this process runs on musl Linux, the way rolldown's binding loader decides it. */
function isMusl(): boolean {
  if (process.platform !== 'linux') return false
  try {
    return readFileSync('/usr/bin/ldd', 'utf8').includes('musl')
  } catch {
    // Fall through to the process report.
  }
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string }; sharedObjects?: string[] } | undefined
    if (report === undefined) return false
    if (report.header?.glibcVersionRuntime !== undefined) return false
    return (report.sharedObjects ?? []).some(file => file.includes('libc.musl-') || file.includes('ld-musl-'))
  } catch {
    return false
  }
}

/** What {@link ensureBundler} does outside its own logic; tests replace it. */
export interface BundlerHost {
  readonly platform: BundlerPlatform
  /** `npm install <specs>` into `prefix`. */
  install(specs: readonly string[], prefix: string): Promise<void>
  /** Import the rolldown installed under `prefix`. */
  load(prefix: string): Promise<Bundler>
}

/** Import rolldown and its `parseAst` from `prefix/node_modules`, by file URL. */
async function load(prefix: string): Promise<Bundler> {
  const require = createRequire(join(prefix, 'package.json'))
  const url = (specifier: string): string => pathToFileURL(require.resolve(specifier)).href
  const { build } = await import(url('rolldown')) as { build?: Bundler['build'] }
  const { parseAst } = await import(url('rolldown/parseAst')) as { parseAst?: Bundler['parseAst'] }
  if (typeof build !== 'function' || typeof parseAst !== 'function') throw new Error(`the rolldown under ${prefix} has no build or parseAst`)
  return { build, parseAst }
}

const defaultHost: BundlerHost = {
  get platform() { return { os: process.platform, arch: process.arch, musl: isMusl() } },
  install: (specs, prefix) => npmInstall(specs, prefix),
  load,
}

/** The packages to install: the pinned rolldown and its binding for `platform`. */
export function bundlerSpecs(platform: BundlerPlatform): string[] {
  const binding = rolldownBinding(platform)
  return [`rolldown@${ROLLDOWN_VERSION}`, ...(binding !== undefined ? [`${binding}@${ROLLDOWN_VERSION}`] : [])]
}

/** Where the bundler is installed under a data root. */
export function bundlerPrefix(dataRoot: string): string {
  return join(dataRoot, 'rolldown')
}

/** Whether `prefix` holds the pinned rolldown and its binding already. */
function installed(prefix: string, platform: BundlerPlatform): boolean {
  const version = (name: string): string | undefined => {
    try {
      return (JSON.parse(readFileSync(join(prefix, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')) as { version?: string }).version
    } catch {
      return undefined
    }
  }
  const binding = rolldownBinding(platform)
  return version('rolldown') === ROLLDOWN_VERSION && (binding === undefined || version(binding) === ROLLDOWN_VERSION)
}

const loading = new Map<string, Promise<Bundler>>()

/**
 * The bundler, installing it under `dataRoot` on first use. One install runs
 * at a time per data root; a failed one is forgotten, so the next mod tries
 * again.
 */
export function ensureBundler(dataRoot: string, host: BundlerHost = defaultHost): Promise<Bundler> {
  const prefix = bundlerPrefix(dataRoot)
  const known = loading.get(prefix)
  if (known !== undefined) return known
  const attempt = bootstrap(prefix, host)
  loading.set(prefix, attempt)
  attempt.catch(() => { if (loading.get(prefix) === attempt) loading.delete(prefix) })
  return attempt
}

/** Whether {@link ensureBundler} would answer without installing anything. */
export function bundlerInstalled(dataRoot: string, host: BundlerHost = defaultHost): boolean {
  return installed(bundlerPrefix(dataRoot), host.platform)
}

async function bootstrap(prefix: string, host: BundlerHost): Promise<Bundler> {
  const platform = host.platform
  const specs = bundlerSpecs(platform)
  if (installed(prefix, platform)) {
    try {
      return await host.load(prefix)
    } catch {
      // Install again over what is there.
    }
  }
  let problem: string
  try {
    if (rolldownBinding(platform) === undefined) throw new Error(`rolldown has no native build for ${platform.os} ${platform.arch}${platform.musl === true ? ' (musl)' : ''}`)
    await host.install(specs, prefix)
    return await host.load(prefix)
  } catch (error: unknown) {
    problem = error instanceof Error ? error.message : String(error)
  }
  throw new Error(`The bundler Claude Code mods need (rolldown ${ROLLDOWN_VERSION}) could not be installed automatically (${problem}). Install it by hand with \`npm install ${specs.join(' ')} --ignore-scripts\` in ${prefix}, then restart DSH.`)
}

/** For tests: forget the bundlers loaded so far. */
export function resetBundlers(): void {
  loading.clear()
}
