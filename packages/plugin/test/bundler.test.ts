import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { npmInstall, npmInstallArgs } from '../src/forge/npm.js'
import { bundlerSpecs, ensureBundler, resetBundlers, rolldownBinding, ROLLDOWN_VERSION, type BundlerHost, type BundlerPlatform } from '../src/mods/bundler.js'
import { workspaceBundler } from './workspace-bundler.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> }

describe('rolldownBinding', () => {
  it('picks the binding rolldown loads, by OS, CPU and libc', () => {
    expect(rolldownBinding({ os: 'linux', arch: 'x64' })).toBe('@rolldown/binding-linux-x64-gnu')
    expect(rolldownBinding({ os: 'linux', arch: 'x64', musl: true })).toBe('@rolldown/binding-linux-x64-musl')
    expect(rolldownBinding({ os: 'linux', arch: 'arm64' })).toBe('@rolldown/binding-linux-arm64-gnu')
    expect(rolldownBinding({ os: 'linux', arch: 'arm64', musl: true })).toBe('@rolldown/binding-linux-arm64-musl')
    expect(rolldownBinding({ os: 'linux', arch: 'arm' })).toBe('@rolldown/binding-linux-arm-gnueabihf')
    expect(rolldownBinding({ os: 'linux', arch: 's390x' })).toBe('@rolldown/binding-linux-s390x-gnu')
    expect(rolldownBinding({ os: 'darwin', arch: 'arm64' })).toBe('@rolldown/binding-darwin-arm64')
    expect(rolldownBinding({ os: 'darwin', arch: 'x64' })).toBe('@rolldown/binding-darwin-x64')
    expect(rolldownBinding({ os: 'win32', arch: 'x64' })).toBe('@rolldown/binding-win32-x64-msvc')
    expect(rolldownBinding({ os: 'win32', arch: 'arm64' })).toBe('@rolldown/binding-win32-arm64-msvc')
    expect(rolldownBinding({ os: 'android', arch: 'arm64' })).toBe('@rolldown/binding-android-arm64')
    expect(rolldownBinding({ os: 'freebsd', arch: 'x64' })).toBe('@rolldown/binding-freebsd-x64')
  })

  it('names only bindings rolldown publishes, and none where it has no native build', () => {
    const published = Object.keys(JSON.parse(readFileSync(join(import.meta.dirname, '..', 'node_modules', 'rolldown', 'package.json'), 'utf8')).optionalDependencies as Record<string, string>)
    const platforms: BundlerPlatform[] = ['linux', 'darwin', 'win32', 'android', 'freebsd'].flatMap(os => ['x64', 'arm64', 'arm', 'ppc64', 's390x', 'ia32'].flatMap(arch => [{ os: os as NodeJS.Platform, arch }, { os: os as NodeJS.Platform, arch, musl: true }]))
    for (const platform of platforms) {
      const binding = rolldownBinding(platform)
      if (binding !== undefined) expect(published).toContain(binding)
    }
    expect(rolldownBinding({ os: 'linux', arch: 'ia32' })).toBeUndefined()
    expect(rolldownBinding({ os: 'linux', arch: 'arm', musl: true })).toBeUndefined()
    expect(rolldownBinding({ os: 'aix', arch: 'ppc64' })).toBeUndefined()
  })

  it('pins the rolldown the tests run against, and is no dependency of the package', () => {
    expect(pkg.devDependencies['rolldown']).toBe(ROLLDOWN_VERSION)
    expect(pkg.dependencies['rolldown']).toBeUndefined()
  })
})

describe('ensureBundler', () => {
  const temporary: string[] = []
  afterEach(() => {
    resetBundlers()
    for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  /** A host whose install writes the packages' manifests, and whose load works once they are there. */
  function fakeHost(options: { platform?: BundlerPlatform; failInstall?: boolean; failLoad?: boolean } = {}): { host: BundlerHost; installs: string[][]; dataRoot: string } {
    const dataRoot = mkdtempSync(join(tmpdir(), 'harness-forge-bundler-'))
    temporary.push(dataRoot)
    const installs: string[][] = []
    const host: BundlerHost = {
      platform: options.platform ?? { os: 'linux', arch: 'x64' },
      install: async (specs, prefix) => {
        installs.push([...specs])
        if (options.failInstall === true) throw new Error('npm exited with 1')
        for (const spec of specs) {
          const at = spec.lastIndexOf('@')
          const dir = join(prefix, 'node_modules', ...spec.slice(0, at).split('/'))
          mkdirSync(dir, { recursive: true })
          writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: spec.slice(0, at), version: spec.slice(at + 1) }))
        }
      },
      load: async () => {
        if (options.failLoad === true) throw new Error('Cannot find native binding')
        return workspaceBundler
      },
    }
    return { host, installs, dataRoot }
  }

  it('installs the pinned rolldown and its binding once, and finds them afterwards', async () => {
    const { host, installs, dataRoot } = fakeHost()
    expect(await ensureBundler(dataRoot, host)).toBe(workspaceBundler)
    expect(installs).toEqual([[`rolldown@${ROLLDOWN_VERSION}`, `@rolldown/binding-linux-x64-gnu@${ROLLDOWN_VERSION}`]])
    resetBundlers()
    expect(await ensureBundler(dataRoot, host)).toBe(workspaceBundler)
    expect(installs).toHaveLength(1)
  })

  it('runs one install for mods that ask at once', async () => {
    const { host, installs, dataRoot } = fakeHost()
    await Promise.all([ensureBundler(dataRoot, host), ensureBundler(dataRoot, host), ensureBundler(dataRoot, host)])
    expect(installs).toHaveLength(1)
  })

  it('says how to install it by hand when the install fails, and tries again next time', async () => {
    const broken = fakeHost({ failInstall: true })
    const error = await ensureBundler(broken.dataRoot, broken.host).then(() => undefined, (reason: unknown) => reason as Error)
    expect(error?.message).toContain(`The bundler Claude Code mods need (rolldown ${ROLLDOWN_VERSION}) could not be installed automatically (npm exited with 1)`)
    expect(error?.message).toContain(`npm install rolldown@${ROLLDOWN_VERSION} @rolldown/binding-linux-x64-gnu@${ROLLDOWN_VERSION} --ignore-scripts`)
    expect(error?.message).toContain(join(broken.dataRoot, 'rolldown'))
    await ensureBundler(broken.dataRoot, broken.host).catch(() => undefined)
    expect(broken.installs).toHaveLength(2)
  })

  it('fails with the manual fix when the installed bundler does not load, or the platform has no binding', async () => {
    const unloadable = fakeHost({ failLoad: true })
    await expect(ensureBundler(unloadable.dataRoot, unloadable.host)).rejects.toThrow(/Cannot find native binding\)\. Install it by hand/u)
    const exotic = fakeHost({ platform: { os: 'linux', arch: 'ia32' } })
    await expect(ensureBundler(exotic.dataRoot, exotic.host)).rejects.toThrow(/no native build for linux ia32/u)
    expect(exotic.installs).toEqual([])
  })

  it('installs with npm, without install scripts', () => {
    expect(bundlerSpecs({ os: 'darwin', arch: 'arm64' })).toEqual([`rolldown@${ROLLDOWN_VERSION}`, `@rolldown/binding-darwin-arm64@${ROLLDOWN_VERSION}`])
    expect(npmInstallArgs(bundlerSpecs({ os: 'win32', arch: 'x64' }))).toEqual(['install', `rolldown@${ROLLDOWN_VERSION}`, `@rolldown/binding-win32-x64-msvc@${ROLLDOWN_VERSION}`, '--ignore-scripts', '--no-audit', '--no-fund'])
  })
})

describe('npmInstall', () => {
  it('installs into its own prefix, never into the DSH profile around it', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'harness-forge-profile-'))
    try {
      writeFileSync(join(profile, 'package.json'), '{"name":"profile","private":true}\n')
      const prefix = join(profile, '.harness-forge', 'data', 'rolldown')
      await npmInstall([], prefix, 120_000)
      expect(existsSync(join(prefix, 'package.json'))).toBe(true)
      expect(readFileSync(join(profile, 'package.json'), 'utf8')).toBe('{"name":"profile","private":true}\n')
      expect(existsSync(join(profile, 'package-lock.json'))).toBe(false)
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  }, 120_000)
})
