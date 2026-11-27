/**
 * npm packages from a registry served here, with real npm: what is prepared is
 * the package's tarball alone, nothing a package ships runs before or after
 * the confirmation, and dependencies come from the registry only.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { SYSTEM_DEPS, type Runner } from '../src/forge/remote/fetch.js'
import { HarnessForge } from '../src/forge/service.js'

const work = mkdtempSync(join(tmpdir(), 'harness-forge-npm-'))
/** Anything a package's script would write. Nothing may ever be written here. */
const markers = join(work, 'markers')
mkdirSync(markers)
const script = (name: string): string => `node -e "require('fs').writeFileSync(require('path').join(${JSON.stringify(markers)}, '${name}-' + process.pid), 'ran')"`

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=T', ...args], { cwd, stdio: 'ignore' })
}

/** A git repository whose package builds itself with `prepare` (npm runs it for git dependencies). */
const gitdep = join(work, 'gitdep')
mkdirSync(gitdep)
writeFileSync(join(gitdep, 'package.json'), JSON.stringify({ name: 'gitdep', version: '1.0.0', scripts: { prepare: script('gitdep-prepare') } }))
git(gitdep, 'init', '-q', '-b', 'main')
git(gitdep, 'add', '.')
git(gitdep, 'commit', '-qm', 'gitdep')
const GITDEP = `git+file://${gitdep}`

const plugin = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name,
  version: '1.0.0',
  main: 'index.js',
  peerDependencies: { '@opencode-ai/plugin': '*' },
  scripts: { postinstall: script(`${name}-postinstall`), prepare: script(`${name}-prepare`) },
  ...extra,
})
const PACKAGES: Record<string, Record<string, unknown>> = {
  plain: plugin('plain', { dependencies: { leaf: '^1.0.0' } }),
  leaf: { name: 'leaf', version: '1.0.0', scripts: { postinstall: script('leaf-postinstall'), install: script('leaf-install') } },
  direct: plugin('direct', { dependencies: { gitdep: GITDEP } }),
  top: plugin('top', { dependencies: { mid: '^1.0.0' } }),
  mid: { name: 'mid', version: '1.0.0', dependencies: { gitdep: GITDEP } },
  bad: plugin('bad'),
}

/** Each package as npm publishes it: a `.tgz` of `package/`. */
const tarballs = new Map<string, Buffer>()
for (const [name, manifest] of Object.entries(PACKAGES)) {
  const dir = join(work, 'pack', name, 'package')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  writeFileSync(join(dir, 'index.js'), 'export const Plugin = async () => ({})\n')
  const file = join(work, 'pack', `${name}.tgz`)
  execFileSync('tar', ['czf', file, '-C', join(work, 'pack', name), 'package'])
  tarballs.set(name, readFileSync(file))
}

let server: Server
let registry = ''
const requests: string[] = []
beforeAll(async () => {
  server = createServer((request, response) => {
    const url = decodeURIComponent(request.url ?? '')
    requests.push(url)
    const tarball = /^\/-\/([^/]+)-1\.0\.0\.tgz$/u.exec(url)?.[1]
    if (tarball !== undefined && tarballs.has(tarball)) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(tarballs.get(tarball))
      return
    }
    const name = url.slice(1)
    const manifest = PACKAGES[name]
    if (manifest === undefined) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":"not found"}')
      return
    }
    const bytes = tarballs.get(name)!
    // `bad` claims the integrity of another tarball.
    const integrity = `sha512-${createHash('sha512').update(name === 'bad' ? tarballs.get('plain')! : bytes).digest('base64')}`
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ name, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { ...manifest, dist: { tarball: `${registry}-/${name}-1.0.0.tgz`, integrity, shasum: createHash('sha1').update(bytes).digest('hex') } } } }))
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  registry = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`
})
afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  rmSync(work, { recursive: true, force: true })
})

const saved = { ...process.env }
/** Every npm command Harness Forge runs. */
const npmCalls: Array<readonly string[]> = []
const npm: Runner = (command, args, options) => { npmCalls.push(args); return SYSTEM_DEPS.npm(command, args, options) }
const forges: HarnessForge[] = []
const roots: string[] = []
function forgeIn(): { forge: HarnessForge; root: string } {
  const root = mkdtempSync(join(work, 'forge-'))
  roots.push(root)
  // npm's configuration, as the person would have it: this registry, a cache of its own.
  Object.assign(process.env, { npm_config_registry: registry, npm_config_cache: join(root, 'npm-cache'), npm_config_userconfig: join(root, 'npmrc'), npm_config_update_notifier: 'false', npm_config_fetch_retries: '0' })
  npmCalls.length = 0
  const forge = new HarnessForge({ get: () => undefined } as never, join(root, 'state.json'), join(root, 'data'), { remote: { deps: { ...SYSTEM_DEPS, npm } } })
  forges.push(forge)
  return { forge, root }
}
afterEach(async () => {
  for (const forge of forges.splice(0)) await forge.dispose()
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
})

const ran = (): string[] => readdirSync(markers)

describe('npm packages', { timeout: 180_000 }, () => {
  it('prepares the tarball alone, from the configured registry, and installs registry dependencies with no script', async () => {
    const { forge, root } = forgeIn()
    await forge.start()
    const view = await forge.remote.open('plain')
    expect(view).toMatchObject({ kind: 'plugin', harness: 'opencode', revision: '1.0.0', registry })
    requests.length = 0
    const plan = await forge.remote.prepare('plain')
    expect(plan).toMatchObject({ name: 'plain', harness: 'opencode', revision: '1.0.0', registry, dependencies: 1, source: 'npm:plain@1.0.0', page: `${registry}plain` })
    // npm does not run before the confirmation: the registry document and the tarball are read by Harness Forge.
    expect(npmCalls).toEqual([])
    // Only the package itself was downloaded: no dependency, nothing installed, nothing ran.
    expect(requests.filter(url => url.endsWith('.tgz'))).toEqual(['/-/plain-1.0.0.tgz'])
    expect(existsSync(join(root, 'data', 'remote', 'staging'))).toBe(true)
    expect(readdirSync(join(root, 'data', 'remote', 'staging')).flatMap(stage => readdirSync(join(root, 'data', 'remote', 'staging', stage)))).toEqual(['package'])
    expect(ran()).toEqual([])
    await forge.remote.install(plan.token)
    expect(npmCalls.map(args => args[0])).toEqual(['install', 'ci'])
    for (const args of npmCalls) {
      expect(args).toContain('--ignore-scripts')
      expect(args.some(arg => arg.startsWith('--script-shell'))).toBe(false)
      expect(args.find(arg => arg.startsWith('--cache='))).toMatch(/[/\\]data[/\\]remote[/\\]staging[/\\][0-9a-f]+[/\\]\.npm-cache$/u)
    }
    const [record] = forge.list()
    expect(record?.root).toMatch(/[/\\]plugins[/\\][0-9a-f]{32}[/\\]node_modules[/\\]plain$/u)
    expect(existsSync(join(record!.root, '..', 'leaf', 'package.json'))).toBe(true)
    expect(ran()).toEqual([])
  })

  it('refuses a package that depends on git directly, before anything is installed', async () => {
    const { forge } = forgeIn()
    await forge.start()
    await expect(forge.remote.prepare('direct')).rejects.toThrow(/gitdep is "git\+file:.*registry only/u)
    expect(forge.list()).toHaveLength(0)
    expect(ran()).toEqual([])
  })

  it('refuses a dependency tree with a git package deeper down, and runs none of its scripts', async () => {
    const { forge, root } = forgeIn()
    await forge.start()
    const plan = await forge.remote.prepare('top')
    expect(ran()).toEqual([])
    await expect(forge.remote.install(plan.token)).rejects.toThrow(/dependency gitdep would come from git\+file:.*registry only/u)
    expect(forge.list()).toHaveLength(0)
    expect(ran()).toEqual([])
    expect(readdirSync(join(root, 'data', 'remote', 'staging'))).toEqual([])
  })

  it('installs an exact version or a tag, not a range', async () => {
    const { forge } = forgeIn()
    await forge.start()
    await expect(forge.remote.prepare('plain@^1.0.0')).rejects.toThrow(/exact npm version or a tag/u)
    expect((await forge.remote.prepare('plain@latest')).revision).toBe('1.0.0')
  })

  it('does not reuse an installed copy whose files changed on disk', async () => {
    const { forge } = forgeIn()
    await forge.start()
    await forge.remote.install((await forge.remote.prepare('plain')).token)
    const root = forge.list()[0]!.root
    writeFileSync(join(root, '..', 'leaf', 'index.js'), 'tampered')
    const again = await forge.remote.prepare('plain')
    await expect(forge.remote.install(again.token)).rejects.toThrow(/changed on disk/u)
  })

  it('refuses a tarball that does not match its integrity', async () => {
    const { forge } = forgeIn()
    await forge.start()
    await expect(forge.remote.prepare('bad')).rejects.toThrow(/does not match the integrity/u)
    expect(npmCalls).toEqual([])
  })

  it('keeps the version installed whole when the same version is fetched again', async () => {
    const { forge } = forgeIn()
    await forge.start()
    await forge.remote.install((await forge.remote.prepare('plain')).token)
    const root = forge.list()[0]!.root
    const before = readFileSync(join(root, 'index.js'), 'utf8')
    const again = await forge.remote.prepare('plain')
    expect(again.alreadyInstalled).toBe(true)
    expect(forge.remote.cancel(again.token)).toBe(true)
    expect(readFileSync(join(root, 'index.js'), 'utf8')).toBe(before)
    expect(existsSync(join(root, '..', 'leaf', 'package.json'))).toBe(true)
    await forge.remote.install((await forge.remote.prepare('plain')).token)
    expect(forge.list().map(record => record.root)).toEqual([root])
  })
})
