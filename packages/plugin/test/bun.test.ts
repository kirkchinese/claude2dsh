import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bunPackages, ensureBun, npmLaunch, type BunHost, type BunPlatform } from '../src/opencode/bun.js'

const names = (platform: BunPlatform): string[] => bunPackages(platform).map(item => item.name)

describe('bunPackages', () => {
  it('picks the platform package by OS, CPU and libc, with the baseline build as the fallback', () => {
    expect(names({ os: 'linux', arch: 'x64' })).toEqual(['@oven/bun-linux-x64', '@oven/bun-linux-x64-baseline'])
    expect(names({ os: 'linux', arch: 'x64', musl: true })).toEqual(['@oven/bun-linux-x64-musl', '@oven/bun-linux-x64-musl-baseline'])
    expect(names({ os: 'linux', arch: 'arm64' })).toEqual(['@oven/bun-linux-aarch64'])
    expect(names({ os: 'linux', arch: 'arm64', musl: true })).toEqual(['@oven/bun-linux-aarch64-musl'])
    expect(names({ os: 'darwin', arch: 'arm64' })).toEqual(['@oven/bun-darwin-aarch64'])
    expect(names({ os: 'darwin', arch: 'x64' })).toEqual(['@oven/bun-darwin-x64', '@oven/bun-darwin-x64-baseline'])
    expect(names({ os: 'win32', arch: 'x64' })).toEqual(['@oven/bun-windows-x64', '@oven/bun-windows-x64-baseline'])
    expect(names({ os: 'android', arch: 'arm64' })).toEqual(['@oven/bun-linux-aarch64-android'])
    expect(names({ os: 'freebsd', arch: 'x64' })).toEqual(['@oven/bun-freebsd-x64'])
  })

  it('tries the baseline build first on a CPU without AVX2', () => {
    expect(names({ os: 'linux', arch: 'x64', avx2: false })).toEqual(['@oven/bun-linux-x64-baseline', '@oven/bun-linux-x64'])
    expect(names({ os: 'linux', arch: 'x64', avx2: true })[0]).toBe('@oven/bun-linux-x64')
  })

  it('names the binary the way the packages hold it, and has none for a platform Bun is not built for', () => {
    expect(bunPackages({ os: 'win32', arch: 'x64' })[0]?.exe).toBe('bin/bun.exe')
    expect(bunPackages({ os: 'linux', arch: 'x64' })[0]?.exe).toBe('bin/bun')
    expect(bunPackages({ os: 'linux', arch: 'ia32' })).toEqual([])
    expect(bunPackages({ os: 'aix', arch: 'x64' })).toEqual([])
  })
})

describe('ensureBun', () => {
  const temporary: string[] = []
  const savedBunPath = process.env['BUN_PATH']
  afterEach(() => {
    for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
    if (savedBunPath === undefined) delete process.env['BUN_PATH']
    else process.env['BUN_PATH'] = savedBunPath
  })

  /** A host with no Bun but those installed under the data root: `runs` names the packages whose binary works. */
  function fakeHost(runs: readonly string[], failInstall: readonly string[] = []): { host: BunHost; installed: string[]; dataRoot: string } {
    const dataRoot = mkdtempSync(join(tmpdir(), 'harness-forge-bun-'))
    temporary.push(dataRoot)
    delete process.env['BUN_PATH']
    const installed: string[] = []
    const host: BunHost = {
      platform: { os: 'linux', arch: 'x64' },
      working: candidates => candidates.find(candidate => runs.some(name => candidate.includes(join('node_modules', ...name.split('/'), 'bin'))) && candidate.startsWith(dataRoot) && existsSync(candidate)),
      install: async (name, prefix) => {
        installed.push(name)
        if (failInstall.includes(name)) throw new Error('npm exited with 1')
        const exe = join(prefix, 'node_modules', ...name.split('/'), 'bin', 'bun')
        mkdirSync(dirname(exe), { recursive: true })
        writeFileSync(exe, '')
      },
    }
    return { host, installed, dataRoot }
  }

  it('installs the platform package once and finds it afterwards', async () => {
    const { host, installed, dataRoot } = fakeHost(['@oven/bun-linux-x64'])
    const bun = await ensureBun(dataRoot, host)
    expect(bun).toBe(join(dataRoot, 'bun', 'node_modules', '@oven', 'bun-linux-x64', 'bin', 'bun'))
    expect(await ensureBun(dataRoot, host)).toBe(bun)
    expect(installed).toEqual(['@oven/bun-linux-x64'])
  })

  it('falls back to the baseline build when the first binary does not run', async () => {
    const { host, installed, dataRoot } = fakeHost(['@oven/bun-linux-x64-baseline'])
    expect(await ensureBun(dataRoot, host)).toContain('bun-linux-x64-baseline')
    expect(installed).toEqual(['@oven/bun-linux-x64', '@oven/bun-linux-x64-baseline'])
  })

  it('falls back when an install fails, and otherwise says how to fix it by hand', async () => {
    const works = fakeHost(['@oven/bun-linux-x64-baseline'], ['@oven/bun-linux-x64'])
    expect(await ensureBun(works.dataRoot, works.host)).toContain('baseline')
    const broken = fakeHost([], ['@oven/bun-linux-x64'])
    const error = await ensureBun(broken.dataRoot, broken.host).then(() => undefined, (reason: unknown) => reason as Error)
    expect(error?.message).toContain('@oven/bun-linux-x64: npm exited with 1')
    expect(error?.message).toContain('does not run')
    expect(error?.message).toContain('Install Bun (https://bun.sh), or set BUN_PATH')
  })

  it('uses a Bun the machine already has without installing anything', async () => {
    const { host, installed, dataRoot } = fakeHost([])
    process.env['BUN_PATH'] = '/opt/bun/bin/bun'
    expect(await ensureBun(dataRoot, { ...host, working: candidates => candidates.find(candidate => candidate === '/opt/bun/bin/bun') })).toBe('/opt/bun/bin/bun')
    expect(installed).toEqual([])
  })
})

describe('npmLaunch', () => {
  const node = 'C:\\Program Files\\nodejs\\node.exe'
  const beside = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'

  it('runs npm directly outside Windows', () => {
    expect(npmLaunch(['install', 'x'], { platform: 'linux', execPath: '/usr/bin/node', exists: () => false })).toEqual({ command: 'npm', args: ['install', 'x'] })
    expect(npmLaunch(['install', 'x'], { platform: 'darwin', execPath: '/usr/local/bin/node', exists: () => false }).command).toBe('npm')
  })

  it('on Windows runs npm-cli.js under node.exe, never npm.cmd', () => {
    const launch = npmLaunch(['install', '@oven/bun-windows-x64'], { platform: 'win32', execPath: node, exists: path => path === beside })
    expect(launch).toEqual({ command: node, args: [beside, 'install', '@oven/bun-windows-x64'] })
  })

  it('on Windows prefers the npm that started this process (npm_execpath)', () => {
    const started = 'C:\\Users\\me\\AppData\\Roaming\\nvm\\v22\\node_modules\\npm\\bin\\npm-cli.js'
    expect(npmLaunch(['view'], { platform: 'win32', execPath: node, npmExecPath: started, exists: () => true }).args[0]).toBe(started)
    // A pnpm or yarn script runner is not npm.
    expect(npmLaunch(['view'], { platform: 'win32', execPath: node, npmExecPath: 'C:\\pnpm\\pnpm.cjs', exists: path => path === beside }).args[0]).toBe(beside)
  })

  it('on Windows says so when npm-cli.js cannot be found', () => {
    expect(() => npmLaunch(['view'], { platform: 'win32', execPath: node, exists: () => false })).toThrow(/npm-cli\.js/u)
  })
})
