import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { crc32, deflateRawSync, gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { parseRemoteInput, type GitSpec } from '@kirkchinese/harness-forge-core'
import { copyTree, destinationKey, extractTarGz, extractZip } from '../src/forge/remote/archive.js'
import { DEFAULT_LIMITS, isPublicAddress, proxyFor, refuseForeignPackages, RemoteFetcher, SYSTEM_DEPS, type FetchDeps, type PinnedFetch, type Runner } from '../src/forge/remote/fetch.js'

const temporary: string[] = []
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-forge-remote-'))
  temporary.push(root)
  return root
}
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=T', ...args], { cwd, encoding: 'utf8' }).trim()
}

function repo(files: Record<string, string>): { dir: string; url: string; sha: () => string } {
  const dir = tempRoot()
  git(dir, 'init', '-q', '-b', 'main')
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'initial')
  return { dir, url: pathToFileURL(dir).href, sha: () => git(dir, 'rev-parse', 'HEAD') }
}

const NO_GIT: FetchDeps['git'] = () => Promise.reject(Object.assign(new Error('git is not installed'), { code: 'ENOENT' }))
/** A resolver that answers every name with a public address, and one that answers with this computer. */
const PUBLIC: FetchDeps['lookup'] = async () => ['93.184.216.34']
const LOOPBACK: FetchDeps['lookup'] = async () => ['127.0.0.1']

/** A git runner that records every call and answers like git would, never touching the network. */
function recordingGit(answer: (args: readonly string[]) => string | Promise<string> = () => '', version = '2.43.0'): { git: Runner; calls: Array<readonly string[]>; cwds: Array<string | undefined> } {
  const calls: Array<readonly string[]> = []
  const cwds: Array<string | undefined> = []
  return { calls, cwds, git: async (_command, args, options) => { calls.push(args); cwds.push(options.cwd); return args[0] === '--version' ? `git version ${version}\n` : answer(args) } }
}
/** The git subcommand of a call, after its `-c` options. */
function subcommand(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '-c') { index += 1; continue }
    if (args[index]!.startsWith('--config-env=')) continue
    return args[index]
  }
  return undefined
}

/** A fetch that answers one URL with these bytes and counts its calls. */
function fetchOf(answers: Record<string, Buffer | ((init?: { signal?: AbortSignal }) => Promise<Response>)>): { fetch: PinnedFetch; urls: string[] } {
  const urls: string[] = []
  const fetch = (async (input: string, init?: { signal?: AbortSignal }) => {
    const url = String(input)
    urls.push(url)
    const answer = answers[url]
    if (answer === undefined) return new Response('missing', { status: 404, statusText: 'Not Found' })
    if (typeof answer === 'function') return answer(init)
    return new Response(answer, { status: 200 })
  }) as PinnedFetch
  return { fetch, urls }
}

/** A zip of stored or deflated files, as a zip tool writes one. */
function zip(files: Record<string, string>, deflate = true): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text)
    const body = deflate ? deflateRawSync(data) : data
    const nameBytes = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(deflate ? 8 : 0, 8)
    local.writeUInt32LE(crc32(data), 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(deflate ? 8 : 0, 10)
    central.writeUInt32LE(crc32(data), 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, body)
    centrals.push(central, nameBytes)
    offset += 30 + nameBytes.length + body.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

/** One tar member header (ustar). */
function tarHeader(name: string, size: number, type = '0'): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100)
  header.write('0000644\0', 100)
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124)
  header.write(type, 156)
  header.write('ustar\0', 257)
  return header
}

const SKILL = '---\nname: one\ndescription: One skill\n---\n\nONE-BODY\n'

describe('the git fetcher', { timeout: 60_000 }, () => {
  it('clones the commit a source points at and reuses it, leaving older checkouts as they were', async () => {
    const source = repo({ '.claude-plugin/plugin.json': '{"name":"demo"}', 'skills/one/SKILL.md': SKILL })
    const fetcher = new RemoteFetcher(tempRoot())
    const spec = parseRemoteInput(source.url) as GitSpec
    expect(await fetcher.latest(spec)).toBe(source.sha())
    const first = await fetcher.checkout(spec)
    expect(first.sha).toBe(source.sha())
    expect(existsSync(join(first.dir, 'skills/one/SKILL.md'))).toBe(true)
    expect(existsSync(join(first.dir, '.git'))).toBe(false)
    expect((await fetcher.checkout(spec, undefined, first.sha)).dir).toBe(first.dir)

    writeFileSync(join(source.dir, 'skills/one/SKILL.md'), SKILL.replace('ONE-BODY', 'TWO-BODY'))
    git(source.dir, 'commit', '-qam', 'second')
    expect(await fetcher.latest(spec)).toBe(source.sha())
    const second = await fetcher.checkout(spec)
    expect(second.sha).not.toBe(first.sha)
    expect(readFileSync(join(second.dir, 'skills/one/SKILL.md'), 'utf8')).toContain('TWO-BODY')
    // A checkout is never replaced or deleted by a fetch: old ones are collected between operations.
    expect(readFileSync(join(first.dir, 'skills/one/SKILL.md'), 'utf8')).toContain('ONE-BODY')
  })

  it('checks out a pinned commit and only the plugin directory of a monorepo', async () => {
    const source = repo({ 'plugins/a/.claude-plugin/plugin.json': '{"name":"a"}', 'other/big.txt': 'x' })
    const pinned = source.sha()
    writeFileSync(join(source.dir, 'plugins/a/later.txt'), 'later')
    git(source.dir, 'add', '.')
    git(source.dir, 'commit', '-qm', 'later')
    const fetcher = new RemoteFetcher(tempRoot())
    const { dir, sha } = await fetcher.checkout({ kind: 'git', url: source.url, sha: pinned, subpath: 'plugins/a' })
    expect(sha).toBe(pinned)
    expect(existsSync(join(dir, 'plugins/a/.claude-plugin/plugin.json'))).toBe(true)
    expect(existsSync(join(dir, 'plugins/a/later.txt'))).toBe(false)
    expect(existsSync(join(dir, 'other/big.txt'))).toBe(false)
  })

  it('names the ref that does not exist', async () => {
    const source = repo({ 'a.txt': 'a' })
    const fetcher = new RemoteFetcher(tempRoot())
    await expect(fetcher.latest({ kind: 'git', url: source.url, ref: 'nope' })).rejects.toThrow(/has no nope/u)
    await expect(fetcher.checkout({ kind: 'git', url: source.url, ref: 'nope' })).rejects.toThrow(/git could not fetch/u)
  })

  it('ignores the git configuration, hooks and GIT_* variables of this computer', async () => {
    const source = repo({ 'a.txt': 'a' })
    const outside = tempRoot()
    const marker = join(outside, 'HOOK-RAN')
    mkdirSync(join(outside, 'hooks'))
    for (const hook of ['post-checkout', 'reference-transaction', 'pre-auto-gc']) {
      writeFileSync(join(outside, 'hooks', hook), `#!/bin/sh\ntouch '${marker}'\n`)
      chmodSync(join(outside, 'hooks', hook), 0o755)
    }
    writeFileSync(join(outside, 'fsmonitor'), `#!/bin/sh\ntouch '${marker}'\n`)
    chmodSync(join(outside, 'fsmonitor'), 0o755)
    writeFileSync(join(outside, 'gitconfig'), `[core]\n\thooksPath = ${join(outside, 'hooks')}\n\tfsmonitor = ${join(outside, 'fsmonitor')}\n`)
    const saved = { ...process.env }
    Object.assign(process.env, {
      GIT_CONFIG_GLOBAL: join(outside, 'gitconfig'),
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: join(outside, 'hooks'),
    })
    try {
      const { dir } = await new RemoteFetcher(tempRoot()).checkout(parseRemoteInput(source.url) as GitSpec)
      expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('a')
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
      Object.assign(process.env, saved)
    }
    expect(existsSync(marker)).toBe(false)
  })

  it('puts every URL and ref after -- and runs git with only the URL\'s transport', async () => {
    const sha = 'e'.repeat(40)
    const { git, calls } = recordingGit(args => subcommand(args) === 'ls-remote' ? `${sha}\trefs/heads/main\n` : subcommand(args) === 'rev-parse' ? `${sha}\n` : '')
    const fetcher = new RemoteFetcher(tempRoot(), { ...SYSTEM_DEPS, git, lookup: PUBLIC })
    await fetcher.hasGit()
    expect(await fetcher.latest({ kind: 'git', url: 'https://example.com/a.git', ref: 'main' })).toBe(sha)
    const lsRemote = calls.find(args => subcommand(args) === 'ls-remote')!
    expect(lsRemote.slice(lsRemote.indexOf('ls-remote'))).toEqual(['ls-remote', '--', 'https://example.com/a.git', 'main', 'refs/tags/main^{}'])
    for (const option of ['protocol.allow=never', 'protocol.https.allow=always', 'protocol.file.allow=never', 'core.fsmonitor=false', 'credential.helper=', 'submodule.recurse=false']) expect(lsRemote).toContain(option)
    expect(lsRemote.some(arg => arg.startsWith('core.hooksPath='))).toBe(true)
    await fetcher.checkout({ kind: 'git', url: 'https://example.com/a.git', subpath: 'plugins/a' })
    const tail = (name: string): readonly string[] => { const args = calls.find(call => subcommand(call) === name)!; return args.slice(args.indexOf(name)) }
    expect(tail('remote')).toEqual(['remote', 'add', '--', 'origin', 'https://example.com/a.git'])
    expect(tail('fetch').slice(-3)).toEqual(['--', 'origin', 'HEAD'])
    expect(tail('sparse-checkout')).toEqual(['sparse-checkout', 'set', '--', 'plugins/a'])
    expect(tail('init').some(arg => arg.startsWith('--template='))).toBe(true)
  })

  it('refuses URLs and refs git would read as options, and other transports, before running git', async () => {
    const { git, calls } = recordingGit()
    const fetcher = new RemoteFetcher(tempRoot(), { ...SYSTEM_DEPS, git, lookup: PUBLIC })
    await fetcher.hasGit()
    const before = calls.length
    await expect(fetcher.latest({ kind: 'git', url: '--upload-pack=touch /tmp/x' })).rejects.toThrow(/not a git URL/u)
    await expect(fetcher.latest({ kind: 'git', url: 'https://example.com/a.git', ref: '--upload-pack=touch /tmp/x' })).rejects.toThrow(/git accepts/u)
    await expect(fetcher.checkout({ kind: 'git', url: 'https://example.com/a.git', ref: '-x' })).rejects.toThrow(/git accepts/u)
    await expect(fetcher.checkout({ kind: 'git', url: 'https://example.com/a.git', sha: 'abc' })).rejects.toThrow(/full commit SHA/u)
    await expect(fetcher.latest({ kind: 'git', url: 'ext::sh%20-c%20id' })).rejects.toThrow(/must use https/u)
    await expect(fetcher.latest({ kind: 'git', url: 'fd::3' })).rejects.toThrow(/must use https/u)
    expect(calls.length).toBe(before)
  })

  it('lets a marketplace reach only public HTTPS hosts, pinned to the addresses checked and with no redirects', async () => {
    const sha = 'f'.repeat(40)
    const { git, calls } = recordingGit(args => subcommand(args) === 'ls-remote' ? `${sha}\tHEAD\n` : '')
    const market = (lookup: FetchDeps['lookup']): RemoteFetcher => new RemoteFetcher(tempRoot(), { ...SYSTEM_DEPS, git, lookup })
    const fetcher = market(PUBLIC)
    await fetcher.hasGit()
    const context = fetcher.context('marketplace')
    expect(await fetcher.latest({ kind: 'git', url: 'https://git.example/a.git' }, context)).toBe(sha)
    expect(calls.at(-1)).toContain('http.followRedirects=false')
    expect(calls.at(-1)).toContain('http.curloptResolve=git.example:443:93.184.216.34')
    const loopback = market(LOOPBACK)
    await loopback.hasGit()
    const count = calls.length
    await expect(loopback.latest({ kind: 'git', url: 'https://git.example/a.git' }, context)).rejects.toThrow(/may not send Harness Forge to git\.example \(127\.0\.0\.1\)/u)
    await expect(fetcher.latest({ kind: 'git', url: 'https://10.1.2.3/a.git' }, context)).rejects.toThrow(/local network/u)
    await expect(fetcher.latest({ kind: 'git', url: 'https://[::1]/a.git' }, context)).rejects.toThrow(/local network/u)
    await expect(fetcher.latest({ kind: 'git', url: 'file:///etc' }, context)).rejects.toThrow(/only https/u)
    await expect(fetcher.latest({ kind: 'git', url: 'git@git.example:a.git' }, context)).rejects.toThrow(/only https/u)
    await expect(fetcher.latest({ kind: 'git', url: 'http://git.example/a.git' }, context)).rejects.toThrow(/only https/u)
    expect(calls.length).toBe(count)
    expect(['127.0.0.1', '10.0.0.1', '172.16.5.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1'].filter(isPublicAddress)).toEqual([])
    expect(['93.184.216.34', '140.82.112.3', '2606:4700::1111'].every(isPublicAddress)).toBe(true)
  })

  it('fetches a pinned commit on its own and does not fall back to the whole history', async () => {
    const sha = '1'.repeat(40)
    const { git, calls } = recordingGit((args) => {
      if (subcommand(args) === 'fetch') throw new Error('Server does not allow request for unadvertised object')
      return ''
    })
    const fetcher = new RemoteFetcher(tempRoot(), { ...SYSTEM_DEPS, git, lookup: PUBLIC })
    await expect(fetcher.checkout({ kind: 'git', url: 'https://example.com/a.git', sha })).rejects.toThrow(/does not serve commit 111111111111/u)
    const fetches = calls.filter(args => subcommand(args) === 'fetch')
    expect(fetches).toHaveLength(1)
    expect(fetches[0]).toContain('--depth=1')
    expect(calls.some(args => args.includes('--unshallow'))).toBe(false)
  })

  it('stops git once it writes past the size bound, and once the operation runs out of time', async () => {
    const big: Runner = async (_command, args, options) => {
      if (subcommand(args) !== 'fetch') return ''
      // A server that ignores --filter=blob:none and sends everything.
      writeFileSync(join(options.cwd!, 'pack'), Buffer.alloc(8192))
      await new Promise((_resolve, reject) => { options.signal?.addEventListener('abort', () => { reject(new Error('killed')) }) })
      return ''
    }
    const small = { ...DEFAULT_LIMITS, tree: { maxBytes: 4096, maxEntries: 1000 }, pollMs: 10 }
    const root = tempRoot()
    await expect(new RemoteFetcher(root, { ...SYSTEM_DEPS, git: big, lookup: PUBLIC }, small).checkout({ kind: 'git', url: 'https://example.com/a.git' })).rejects.toThrow(/larger than Harness Forge accepts/u)
    const hang: Runner = async (_command, args, options) => {
      if (args[0] === '--version') return 'git version 2.43.0'
      await new Promise((_resolve, reject) => { options.signal?.addEventListener('abort', () => { reject(new Error('killed')) }) })
      return ''
    }
    const quick = new RemoteFetcher(tempRoot(), { ...SYSTEM_DEPS, git: hang, lookup: PUBLIC }, { ...DEFAULT_LIMITS, operationMs: 100 })
    await expect(quick.checkout({ kind: 'git', url: 'https://example.com/a.git' }, quick.context('user'))).rejects.toThrow(/timed out/u)
  })
})

describe('without git', { timeout: 60_000 }, () => {
  it('downloads the GitHub archive over HTTPS and reads its commit from the pax header', async () => {
    const source = repo({ '.claude-plugin/plugin.json': '{"name":"demo"}', 'skills/one/SKILL.md': SKILL })
    const archive = execFileSync('git', ['archive', '--format=tar.gz', '--prefix=acme-demo-abc/', 'HEAD'], { cwd: source.dir })
    const { fetch, urls } = fetchOf({ 'https://codeload.github.com/acme/demo/tar.gz/HEAD': archive })
    const fetcher = new RemoteFetcher(tempRoot(), { ...SYSTEM_DEPS, git: NO_GIT, fetch, lookup: PUBLIC })
    expect(await fetcher.hasGit()).toBe(false)
    const { dir, sha } = await fetcher.checkout(parseRemoteInput('acme/demo') as GitSpec)
    expect(sha).toBe(source.sha())
    expect(readFileSync(join(dir, 'skills/one/SKILL.md'), 'utf8')).toContain('ONE-BODY')
    expect(urls).toEqual(['https://codeload.github.com/acme/demo/tar.gz/HEAD'])
  })

  it('asks GitHub for the latest commit, and needs git for other hosts', async () => {
    const sha = 'd'.repeat(40)
    const { fetch, urls } = fetchOf({ 'https://api.github.com/repos/acme/demo/commits/v1': Buffer.from(sha) })
    const fetcher = new RemoteFetcher(tempRoot(), { ...SYSTEM_DEPS, git: NO_GIT, fetch, lookup: PUBLIC })
    expect(await fetcher.latest(parseRemoteInput('acme/demo@v1') as GitSpec)).toBe(sha)
    expect(urls[0]).toBe('https://api.github.com/repos/acme/demo/commits/v1')
    await expect(fetcher.checkout(parseRemoteInput('https://gitlab.example.com/a/b.git') as GitSpec)).rejects.toThrow(/git is needed/u)
  })

  it('reports an unreachable host and a 404 in words', async () => {
    const offline: FetchDeps['lookup'] = async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) }
    const fetcher = new RemoteFetcher(tempRoot(), { ...SYSTEM_DEPS, git: NO_GIT, lookup: offline })
    await expect(fetcher.checkout(parseRemoteInput('acme/demo') as GitSpec)).rejects.toThrow(/cannot reach codeload\.github\.com \(ENOTFOUND\)/u)
    const missing = new RemoteFetcher(tempRoot(), { ...SYSTEM_DEPS, git: NO_GIT, fetch: fetchOf({}).fetch, lookup: PUBLIC })
    await expect(missing.checkout(parseRemoteInput('acme/demo') as GitSpec)).rejects.toThrow(/answered 404/u)
  })

  it('tells GitHub\'s rate limit apart from a missing repository', async () => {
    const limited = fetchOf({ 'https://api.github.com/repos/acme/demo/commits/HEAD': async () => new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1795770000' } }) })
    const fetcher = new RemoteFetcher(tempRoot(), { ...SYSTEM_DEPS, git: NO_GIT, fetch: limited.fetch, lookup: PUBLIC })
    await expect(fetcher.latest(parseRemoteInput('acme/demo') as GitSpec)).rejects.toThrow(/rate limit, HTTP 403\) until \d\d:\d\d UTC/u)
    const many = fetchOf({ 'https://codeload.github.com/acme/demo/tar.gz/HEAD': async () => new Response('', { status: 429 }) })
    await expect(new RemoteFetcher(tempRoot(), { ...SYSTEM_DEPS, git: NO_GIT, fetch: many.fetch, lookup: PUBLIC }).checkout(parseRemoteInput('acme/demo') as GitSpec)).rejects.toThrow(/rate limit/u)
  })

  it('refuses a GitHub archive of another commit than the one pinned', async () => {
    const source = repo({ 'a.txt': 'a' })
    const archive = execFileSync('git', ['archive', '--format=tar.gz', '--prefix=x/', 'HEAD'], { cwd: source.dir })
    const pinned = '2'.repeat(40)
    const { fetch } = fetchOf({ [`https://codeload.github.com/acme/demo/tar.gz/${pinned}`]: archive })
    await expect(new RemoteFetcher(tempRoot(), { ...SYSTEM_DEPS, git: NO_GIT, fetch, lookup: PUBLIC }).checkout({ ...parseRemoteInput('acme/demo') as GitSpec, sha: pinned })).rejects.toThrow(/not 222222222222/u)
  })
})

describe('download limits', () => {
  it('refuses a download past its size, declared or streamed', async () => {
    const big = Buffer.alloc(2048, 1)
    const declared = fetchOf({ 'https://example.com/a': async () => new Response(big, { headers: { 'content-length': '2048' } }) })
    const fetcher = new RemoteFetcher(tempRoot(), { ...SYSTEM_DEPS, fetch: declared.fetch, lookup: PUBLIC })
    await expect(fetcher.download('https://example.com/a', 1024, 5_000, fetcher.context('user'))).rejects.toThrow(/larger than/u)
    const streamed = fetchOf({
      'https://example.com/b': async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(800))
          controller.enqueue(new Uint8Array(800))
          controller.close()
        },
      })),
    })
    const streaming = new RemoteFetcher(tempRoot(), { ...SYSTEM_DEPS, fetch: streamed.fetch, lookup: PUBLIC })
    await expect(streaming.download('https://example.com/b', 1024, 5_000, streaming.context('user'))).rejects.toThrow(/larger than/u)
    expect((await streaming.download('https://example.com/b', 4096, 5_000, streaming.context('user'))).length).toBe(1600)
  })

  it('gives up on a server that does not answer in time', async () => {
    const hanging = fetchOf({
      'https://example.com/slow': init => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })) })
      }),
    })
    const fetcher = new RemoteFetcher(tempRoot(), { ...SYSTEM_DEPS, fetch: hanging.fetch, lookup: PUBLIC }, { ...DEFAULT_LIMITS, jsonMs: 50 })
    await expect(fetcher.json('https://example.com/slow')).rejects.toThrow(/timed out/u)
  })

  it('refuses a non-https redirect of an https download and a JSON document that is not an object', async () => {
    const redirected = fetchOf({ 'https://example.com/m.json': async () => new Response(null, { status: 302, headers: { location: 'http://example.com/m.json' } }) })
    await expect(new RemoteFetcher(tempRoot(), { ...SYSTEM_DEPS, fetch: redirected.fetch, lookup: PUBLIC }).json('https://example.com/m.json')).rejects.toThrow(/non-https/u)
    const list = fetchOf({ 'https://example.com/m.json': Buffer.from('[1]') })
    await expect(new RemoteFetcher(tempRoot(), { ...SYSTEM_DEPS, fetch: list.fetch, lookup: PUBLIC }).json('https://example.com/m.json')).rejects.toThrow(/not a JSON object/u)
  })
})

describe('the network policy of downloads', () => {
  let server: Server | undefined
  let hits: string[] = []
  afterEach(async () => {
    await new Promise<void>((resolve) => { if (server === undefined) resolve(); else server.close(() => { resolve() }) })
    server = undefined
    hits = []
  })
  async function local(): Promise<number> {
    server = createServer((request, response) => {
      hits.push(request.url ?? '')
      if (request.url === '/moved') {
        response.writeHead(302, { location: '/marketplace.json' })
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"name":"local"}')
    })
    await new Promise<void>((resolve) => { server!.listen(0, '127.0.0.1', resolve) })
    return (server!.address() as AddressInfo).port
  }

  it('reaches any host the person typed, but checks every redirect from it', async () => {
    const port = await local()
    const fetcher = new RemoteFetcher(tempRoot())
    expect(await fetcher.json(`http://127.0.0.1:${String(port)}/marketplace.json`, fetcher.context('user'))).toEqual({ name: 'local' })
    await expect(fetcher.json(`http://127.0.0.1:${String(port)}/moved`, fetcher.context('user'))).rejects.toThrow(/redirect may not send Harness Forge to 127\.0\.0\.1/u)
    expect(hits).toEqual(['/marketplace.json', '/moved'])
  })

  it('connects to the address it checked and never resolves the name again', async () => {
    const port = await local()
    const asked: string[] = []
    // A name only Harness Forge's own resolver knows: connecting by any other lookup fails.
    const lookup: FetchDeps['lookup'] = async (host) => { asked.push(host); return ['127.0.0.1'] }
    const fetcher = new RemoteFetcher(tempRoot(), { ...SYSTEM_DEPS, lookup })
    expect(await fetcher.json(`http://pinned.invalid:${String(port)}/marketplace.json`, fetcher.context('user'))).toEqual({ name: 'local' })
    expect(asked).toEqual(['pinned.invalid'])
  })

  it('bounds name resolution by the operation\'s time', async () => {
    const never: FetchDeps['lookup'] = () => new Promise(() => undefined)
    const fetcher = new RemoteFetcher(tempRoot(), { ...SYSTEM_DEPS, lookup: never }, { ...DEFAULT_LIMITS, lookupMs: 50 })
    await expect(fetcher.download('https://slow.example/a', 1024, 5_000, fetcher.context('user'))).rejects.toThrow(/resolving slow\.example timed out/u)
  })

  it('never requests this computer or its network on a marketplace\'s say-so, not even after a redirect', async () => {
    const port = await local()
    let cancelled = false
    const hop = fetchOf({
      'https://cdn.example/a.zip': async () => new Response(new ReadableStream({ cancel() { cancelled = true } }), { status: 302, headers: { location: `https://127.0.0.1:${String(port)}/secret` } }),
      'https://cdn.example/b.zip': async () => new Response(null, { status: 301, headers: { location: 'https://internal.example/x' } }),
    })
    const lookup: FetchDeps['lookup'] = async host => host === 'internal.example' ? ['10.0.0.7'] : ['93.184.216.34']
    const fetcher = new RemoteFetcher(tempRoot(), { ...SYSTEM_DEPS, fetch: hop.fetch, lookup })
    const context = fetcher.context('marketplace')
    await expect(fetcher.download('https://cdn.example/a.zip', 1024, 5_000, context)).rejects.toThrow(/127\.0\.0\.1.*local network/u)
    expect(cancelled).toBe(true)
    await expect(fetcher.download('https://cdn.example/b.zip', 1024, 5_000, context)).rejects.toThrow(/internal\.example \(10\.0\.0\.7\)/u)
    expect(hop.urls).toEqual(['https://cdn.example/a.zip', 'https://cdn.example/b.zip'])
    const real = new RemoteFetcher(tempRoot())
    await expect(real.download(`https://127.0.0.1:${String(port)}/x`, 1024, 5_000, real.context('marketplace'))).rejects.toThrow(/local network/u)
    await expect(real.download(`http://127.0.0.1:${String(port)}/x`, 1024, 5_000, real.context('marketplace'))).rejects.toThrow(/only https/u)
    await expect(real.download('file:///etc/passwd', 1024, 5_000, real.context('user'))).rejects.toThrow(/only http/u)
    expect(hits).toEqual([])
  })
})

describe('archives', () => {
  it('unpacks a zip with deflated and stored members, one directory down, and checks its sha256', async () => {
    const bytes = zip({ 'plugin/.claude-plugin/plugin.json': '{"name":"z"}', 'plugin/skills/one/SKILL.md': SKILL, '../evil.txt': 'no' })
    const { fetch } = fetchOf({ 'https://example.com/p.zip': bytes })
    const parent = tempRoot()
    const fetcher = new RemoteFetcher(tempRoot(), { ...SYSTEM_DEPS, fetch, lookup: PUBLIC })
    const { root, digest } = await fetcher.archive({ kind: 'archive', url: 'https://example.com/p.zip' }, join(parent, 'x'), fetcher.context('marketplace'))
    expect(readFileSync(join(root, 'skills/one/SKILL.md'), 'utf8')).toContain('ONE-BODY')
    expect(existsSync(join(parent, 'evil.txt'))).toBe(false)
    await expect(fetcher.archive({ kind: 'archive', url: 'https://example.com/p.zip', sha256: '0'.repeat(64) }, join(parent, 'y'), fetcher.context('marketplace'))).rejects.toThrow(/sha256/u)
    expect(digest).toMatch(/^[0-9a-f]{64}$/u)
    const stored = tempRoot()
    await extractZip(zip({ 'a.txt': 'A' }, false), stored)
    expect(readFileSync(join(stored, 'a.txt'), 'utf8')).toBe('A')
  })

  it('keeps tar members inside the destination and bounds the entries', async () => {
    const body = Buffer.from('hi')
    const pad = (data: Buffer): Buffer => Buffer.concat([data, Buffer.alloc((512 - data.length % 512) % 512)])
    const tar = gzipSync(Buffer.concat([
      tarHeader('root/ok.txt', body.length), pad(body),
      tarHeader('root/../../escape.txt', body.length), pad(body),
      Buffer.alloc(1024),
    ]))
    const dest = join(tempRoot(), 'out')
    await extractTarGz(tar, dest, { strip: 1 })
    expect(readFileSync(join(dest, 'ok.txt'), 'utf8')).toBe('hi')
    expect(existsSync(join(dest, '..', 'escape.txt'))).toBe(false)
    await expect(extractTarGz(tar, join(tempRoot(), 'small'), { strip: 1, limits: { maxBytes: 1024, maxEntries: 1 } })).rejects.toThrow(/larger than/u)
  })

  it('copies a plugin without .git and without following any link', () => {
    const checkout = tempRoot()
    mkdirSync(join(checkout, 'plugin/.git'), { recursive: true })
    writeFileSync(join(checkout, 'plugin/a.txt'), 'a')
    writeFileSync(join(checkout, 'shared.txt'), 'shared')
    link('../shared.txt', join(checkout, 'plugin/inside'))
    link('/etc/hostname', join(checkout, 'plugin/outside'))
    const dest = join(tempRoot(), 'copy')
    expect(copyTree(join(checkout, 'plugin'), dest, checkout).sort()).toEqual(['inside', 'outside'])
    expect(readFileSync(join(dest, 'a.txt'), 'utf8')).toBe('a')
    // No link is followed, inside the checkout or out of it.
    expect(existsSync(join(dest, 'inside'))).toBe(false)
    expect(existsSync(join(dest, 'outside'))).toBe(false)
    expect(existsSync(join(dest, '.git'))).toBe(false)
    expect(() => { copyTree(join(checkout, 'plugin'), join(tempRoot(), 'small'), checkout, { maxBytes: 0, maxEntries: 100 }) }).toThrow(/larger than/u)
  })
})

describe('npm', () => {
  it('reads a version, its tarball and integrity from the registry itself, without running npm', async () => {
    const integrity = `sha512-${'A'.repeat(86)}==`
    const document = (tarball: string, extra: Record<string, unknown> = {}): Buffer => Buffer.from(JSON.stringify({ name: '@acme/oc', 'dist-tags': { latest: '1.4.0' }, versions: { '1.4.0': { name: '@acme/oc', version: '1.4.0', dist: { tarball, integrity, ...extra } } } }))
    const { fetch, urls } = fetchOf({
      'https://registry.example/@acme%2foc': document('https://registry.example/@acme/oc/-/oc-1.4.0.tgz'),
      'https://registry.npmjs.org/@acme%2foc': document('https://evil.example/oc.tgz'),
    })
    const npm: Runner = () => Promise.reject(new Error('npm must not run before the confirmation'))
    const saved = process.env['npm_config_registry']
    process.env['npm_config_registry'] = 'https://registry.example'
    try {
      const fetcher = new RemoteFetcher(tempRoot(), { ...SYSTEM_DEPS, npm, fetch, lookup: PUBLIC })
      expect(await fetcher.npmLatest({ kind: 'npm', package: '@acme/oc' })).toEqual({ name: '@acme/oc', version: '1.4.0', integrity, registry: 'https://registry.example/', tarball: 'https://registry.example/@acme/oc/-/oc-1.4.0.tgz' })
      expect(urls).toEqual(['https://registry.example/@acme%2foc'])
      await expect(fetcher.npmLatest({ kind: 'npm', package: '@acme/oc', version: '^1' })).rejects.toThrow(/exact npm version or a tag/u)
      await expect(fetcher.npmLatest({ kind: 'npm', package: '@acme/oc', version: '2.0.0' })).rejects.toThrow(/no version of @acme\/oc matching 2\.0\.0/u)
      // A registry pointing at a tarball elsewhere is not followed.
      await expect(fetcher.npmLatest({ kind: 'npm', package: '@acme/oc', registry: 'https://registry.npmjs.org' }, fetcher.context('marketplace'))).rejects.toThrow(/not on https:\/\/registry\.npmjs\.org\//u)
      await expect(fetcher.npmLatest({ kind: 'npm', package: 'x', registry: 'https://evil.example' }, fetcher.context('marketplace'))).rejects.toThrow(/npm's own registry or the one npm is configured with \(https:\/\/registry\.example\/\)/u)
    } finally {
      if (saved === undefined) delete process.env['npm_config_registry']
      else process.env['npm_config_registry'] = saved
    }
  })

  it('refuses a resolved tree with anything but registry tarballs with an integrity', () => {
    const registry = 'https://registry.example/'
    const ok = { resolved: 'https://registry.example/a/-/a-1.0.0.tgz', integrity: 'sha512-x' }
    expect(() => { refuseForeignPackages({ packages: { '': {}, 'node_modules/a': ok, 'node_modules/alias': ok, 'node_modules/a/node_modules/b': { inBundle: true } } }, registry) }).not.toThrow()
    for (const entry of [
      { resolved: 'git+ssh://git@github.com/a/b.git#abc', integrity: 'sha512-x' },
      { resolved: 'https://codeload.github.com/a/b/tar.gz/abc', integrity: 'sha512-x' },
      { resolved: 'file:../x', link: true },
      { resolved: '../x', link: true },
      { resolved: 'https://registry.example/a/-/a-1.0.0.tgz' },
      { integrity: 'sha512-x' },
    ]) expect(() => { refuseForeignPackages({ packages: { 'node_modules/bad': entry } }, registry) }).toThrow(/dependency bad would come from/u)
  })

  it('says npm is needed when it is missing, once dependencies are installed', async () => {
    const fetcher = new RemoteFetcher(tempRoot(), { ...SYSTEM_DEPS, npm: NO_GIT })
    await expect(fetcher.npmDependencies(tempRoot(), { dependencies: { a: '1.0.0' }, optionalDependencies: {} }, 'https://registry.npmjs.org/', fetcher.context('user'))).rejects.toThrow(/npm is needed/u)
  })
})

/** A zip whose central directory says what each entry says, true or not. */
function rawZip(entries: ReadonlyArray<{ name: string; data: Buffer; method?: number; size?: number; mode?: number; local?: number }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  const offsets: number[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(entry.method ?? 0, 8)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.size ?? entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    offsets.push(offset)
    locals.push(local, name, entry.data)
    offset += 30 + name.length + entry.data.length
  }
  entries.forEach((entry, index) => {
    const name = Buffer.from(entry.name)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(entry.method ?? 0, 10)
    central.writeUInt32LE(entry.data.length, 20)
    central.writeUInt32LE(entry.size ?? entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38)
    central.writeUInt32LE(entry.local ?? offsets[index]!, 42)
    centrals.push(central, name)
  })
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

describe('the extractor refuses what a plugin does not need', () => {
  const pad = (data: Buffer): Buffer => Buffer.concat([data, Buffer.alloc((512 - data.length % 512) % 512)])
  const tar = (...members: Buffer[]): Buffer => gzipSync(Buffer.concat([...members, Buffer.alloc(1024)]))

  it('refuses links, hard links and devices in a tar', async () => {
    for (const type of ['2', '1', '3', '4', '6', 'K']) {
      await expect(extractTarGz(tar(tarHeader('root/x', 0, type)), join(tempRoot(), 'out'), { strip: 1 })).rejects.toThrow(/link or special file/u)
    }
  })

  it('refuses malformed tar sizes and counts every header record', async () => {
    const header = tarHeader('root/a.txt', 0)
    header.write('-0000000001\0', 124)
    await expect(extractTarGz(tar(header), join(tempRoot(), 'out'), { strip: 1 })).rejects.toThrow(/malformed size/u)
    const base256 = tarHeader('root/a.txt', 0)
    base256[124] = 0x80
    await expect(extractTarGz(tar(base256), join(tempRoot(), 'out'), { strip: 1 })).rejects.toThrow(/malformed size/u)
    const record = Buffer.from('9 a=bcde\n')
    const extensions = Array.from({ length: 6 }, () => [tarHeader('pax', record.length, 'x'), pad(record)]).flat()
    await expect(extractTarGz(tar(...extensions, tarHeader('root/a.txt', 0)), join(tempRoot(), 'out'), { strip: 1, limits: { maxBytes: 1024, maxEntries: 4 } })).rejects.toThrow(/larger than/u)
    const truncated = Buffer.concat([tarHeader('root/a.txt', 4096), Buffer.alloc(512)])
    await expect(extractTarGz(gzipSync(truncated), join(tempRoot(), 'out'), { strip: 1 })).rejects.toThrow(/ends inside a member/u)
  })

  it('charges a zip for what it writes and refuses stored members with two sizes, overlaps, repeats and links', async () => {
    const big = Buffer.alloc(2048, 7)
    await expect(extractZip(rawZip([{ name: 'a.bin', data: big, size: 0 }]), join(tempRoot(), 'out'), { limits: { maxBytes: 1024, maxEntries: 10 } })).rejects.toThrow(/two different sizes/u)
    const deflated = deflateRawSync(big)
    await expect(extractZip(rawZip([{ name: 'a.bin', data: deflated, method: 8, size: 10 }]), join(tempRoot(), 'out'))).rejects.toThrow(/does not inflate to its size/u)
    await expect(extractZip(rawZip([{ name: 'a.bin', data: deflated, method: 8, size: big.length }]), join(tempRoot(), 'out'), { limits: { maxBytes: 1024, maxEntries: 10 } })).rejects.toThrow(/larger than/u)
    await expect(extractZip(rawZip([{ name: 'a.txt', data: Buffer.from('a') }, { name: 'b.txt', data: Buffer.from('a'), local: 0 }]), join(tempRoot(), 'out'))).rejects.toThrow(/overlaps/u)
    await expect(extractZip(rawZip([{ name: 'a.txt', data: Buffer.from('a') }, { name: './a.txt', data: Buffer.from('b') }]), join(tempRoot(), 'out'))).rejects.toThrow(/two members for a\.txt/u)
    await expect(extractZip(rawZip([{ name: 'link', data: Buffer.from('/etc/passwd'), mode: 0o120777 }]), join(tempRoot(), 'out'))).rejects.toThrow(/link or special file/u)
    const dest = join(tempRoot(), 'ok')
    await extractZip(rawZip([{ name: 'a.txt', data: Buffer.from('A') }, { name: 'd/', data: Buffer.alloc(0), mode: 0o040755 }]), dest)
    expect(readFileSync(join(dest, 'a.txt'), 'utf8')).toBe('A')
  })

  it('stops unpacking when the operation is cancelled', async () => {
    const files = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`f${String(index)}.txt`, 'x']))
    const controller = new AbortController()
    controller.abort(new Error('the operation timed out'))
    await expect(extractZip(zip(files), join(tempRoot(), 'out'), { signal: controller.signal })).rejects.toThrow(/timed out/u)
    const members = Array.from({ length: 300 }, (_, index) => [tarHeader(`root/f${String(index)}`, 1), pad(Buffer.from('x'))]).flat()
    await expect(extractTarGz(tar(...members), join(tempRoot(), 'out'), { strip: 1, signal: controller.signal })).rejects.toThrow(/timed out/u)
  })

  it('never copies a plugin from a link or through one', () => {
    const checkout = tempRoot()
    mkdirSync(join(checkout, 'real/skills'), { recursive: true })
    writeFileSync(join(checkout, 'real/skills/a.txt'), 'a')
    link('real', join(checkout, 'alias'), 'dir')
    link(tmpdir(), join(checkout, 'outside'), 'dir')
    expect(() => copyTree(join(checkout, 'alias'), join(tempRoot(), 'x'), checkout)).toThrow(/link/u)
    expect(() => copyTree(join(checkout, 'outside'), join(tempRoot(), 'x'), checkout)).toThrow(/link/u)
    expect(() => copyTree(join(checkout, 'alias', 'skills'), join(tempRoot(), 'x'), checkout)).toThrow(/through a link/u)
    expect(copyTree(join(checkout, 'real'), join(tempRoot(), 'x'), checkout)).toEqual([])
  })
})

describe('where git runs and what it may reach for a marketplace', () => {
  it('runs every git command in an empty directory of Harness Forge\'s own', async () => {
    const sha = 'e'.repeat(40)
    const { git, calls, cwds } = recordingGit(args => subcommand(args) === 'ls-remote' ? `${sha}\tHEAD\n` : '')
    const root = tempRoot()
    const fetcher = new RemoteFetcher(root, { ...SYSTEM_DEPS, git, lookup: PUBLIC })
    await fetcher.latest({ kind: 'git', url: 'https://example.com/a.git' })
    const index = calls.findIndex(args => subcommand(args) === 'ls-remote')
    expect(cwds[index]).toBe(join(root, 'git-isolation', 'cwd'))
    expect(cwds[calls.findIndex(args => args[0] === '--version')]).toBe(join(root, 'git-isolation', 'cwd'))
  })

  it('does not use a git that cannot be held to the checked addresses: GitHub comes as its archive, other hosts are refused', async () => {
    const source = repo({ 'a.txt': 'a' })
    const archive = execFileSync('git', ['archive', '--format=tar.gz', '--prefix=x/', 'HEAD'], { cwd: source.dir })
    const { fetch, urls } = fetchOf({ 'https://api.github.com/repos/acme/demo/commits/HEAD': Buffer.from(source.sha()), 'https://codeload.github.com/acme/demo/tar.gz/HEAD': archive })
    const { git, calls } = recordingGit(() => '', '2.30.1')
    const fetcher = new RemoteFetcher(tempRoot(), { ...SYSTEM_DEPS, git, fetch, lookup: PUBLIC })
    const context = fetcher.context('marketplace')
    expect(await fetcher.latest(parseRemoteInput('acme/demo') as GitSpec, context)).toBe(source.sha())
    expect((await fetcher.checkout(parseRemoteInput('acme/demo') as GitSpec, context)).sha).toBe(source.sha())
    await expect(fetcher.latest({ kind: 'git', url: 'https://gitlab.example/a.git' }, context)).rejects.toThrow(/older than 2\.37/u)
    expect(calls.filter(args => args[0] !== '--version')).toEqual([])
    expect(urls).toEqual(['https://api.github.com/repos/acme/demo/commits/HEAD', 'https://codeload.github.com/acme/demo/tar.gz/HEAD'])
  })

  it('behind a proxy, fetches only the allowed hosts with git for a marketplace', async () => {
    const sha = 'e'.repeat(40)
    const { git, calls } = recordingGit(args => subcommand(args) === 'ls-remote' ? `${sha}\tHEAD\n` : '')
    const saved = process.env['HTTPS_PROXY']
    process.env['HTTPS_PROXY'] = 'http://proxy.example:3128'
    try {
      const fetcher = new RemoteFetcher(tempRoot(), { ...SYSTEM_DEPS, git, lookup: PUBLIC })
      const context = fetcher.context('marketplace')
      await expect(fetcher.latest({ kind: 'git', url: 'https://gitlab.example/a.git' }, context)).rejects.toThrow(/behind a proxy, Harness Forge reaches only GitHub.*not gitlab\.example/u)
      expect(await fetcher.latest(parseRemoteInput('acme/demo') as GitSpec, context)).toBe(sha)
      expect(calls.filter(args => subcommand(args) === 'ls-remote')).toHaveLength(1)
      // What the person pastes is fetched through the proxy as git would.
      expect(await fetcher.latest({ kind: 'git', url: 'https://gitlab.example/a.git' }, fetcher.context('user'))).toBe(sha)
    } finally {
      if (saved === undefined) delete process.env['HTTPS_PROXY']
      else process.env['HTTPS_PROXY'] = saved
    }
  })
})

/** Run with these proxy variables (and no others), then put the environment back. */
/** A symbolic link, as a junction for a folder on Windows (where folder links may need a privilege). */
function link(target: string, path: string, kind: 'file' | 'dir' = 'file'): void {
  if (process.platform === 'win32' && kind === 'dir') symlinkSync(resolve(dirname(path), target), path, 'junction')
  else symlinkSync(target, path, kind)
}

async function withProxyEnv<T>(values: Record<string, string>, run: () => Promise<T> | T): Promise<T> {
  const keys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
  Object.assign(process.env, values)
  try {
    return await run()
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

describe('git takes the route Harness Forge chose', () => {
  function recording(): { git: Runner; calls: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> } {
    const calls: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = []
    return { calls, git: async (_command, args, options) => { calls.push({ args, env: options.env ?? {} }); return args[0] === '--version' ? 'git version 2.43.0\n' : `${'e'.repeat(40)}\tHEAD\n` } }
  }

  it('sees no proxy variable, is told the proxy (or none), gets the URL as read, follows no redirect, and finds no repository around it', async () => {
    const { git, calls } = recording()
    const root = tempRoot()
    const fetcher = new RemoteFetcher(root, { ...SYSTEM_DEPS, git, lookup: PUBLIC })
    // On Windows HTTPS_PROXY and https_proxy are one variable, so only the lowercase spelling is set there.
    const both = process.platform === 'win32' ? {} : { HTTPS_PROXY: 'http://upper.example:3128', NO_PROXY: 'other.example' }
    await withProxyEnv({ https_proxy: 'http://lower.example:3128', no_proxy: 'direct.example', ...both }, async () => {
      await fetcher.latest({ kind: 'git', url: 'HTTPS://Proxied.Example/a.git' })
      await fetcher.latest({ kind: 'git', url: 'https://direct.example/a.git' })
    })
    const [proxied, direct] = calls.filter(call => call.args.includes('ls-remote'))
    expect(proxied!.env['HF_GIT_PROXY']).toBe('http://lower.example:3128/')
    expect(proxied!.args.slice(proxied!.args.indexOf('ls-remote'))).toEqual(['ls-remote', '--', 'https://proxied.example/a.git', 'HEAD'])
    expect(direct!.env['HF_GIT_PROXY']).toBe('')
    for (const call of [proxied!, direct!]) {
      expect(call.args).toContain('--config-env=http.proxy=HF_GIT_PROXY')
      expect(call.args.some(arg => arg.startsWith('http.proxy='))).toBe(false)
      expect(call.args).toContain('http.followRedirects=false')
      expect(Object.keys(call.env).filter(key => /^(?:https?|all|no)_proxy$/iu.test(key))).toEqual([])
      expect(call.env['GIT_CEILING_DIRECTORIES']).toBe(root)
    }
  })

  // Windows environment names are case-insensitive: there is one variable, and no order between spellings.
  it.skipIf(process.platform === 'win32')('reads the proxy variables in curl\'s order, lowercase first', async () => {
    await withProxyEnv({ https_proxy: 'http://lower.example:1', HTTPS_PROXY: 'http://upper.example:1', no_proxy: 'a.example', NO_PROXY: 'b.example' }, () => {
      expect(proxyFor(new URL('https://x.example/'))?.host).toBe('lower.example:1')
      expect(proxyFor(new URL('https://a.example/'))).toBeUndefined()
      expect(proxyFor(new URL('https://b.example/'))?.host).toBe('lower.example:1')
    })
  })

  it('does not read the configuration of a repository its data directory sits in', async () => {
    const outer = tempRoot()
    git(outer, 'init', '-q')
    // A repository around the data directory that would send every example.invalid fetch to a port on this computer.
    git(outer, 'config', 'url.https://127.0.0.1:9/.insteadOf', 'https://example.invalid/')
    const root = join(outer, 'profile', 'data', 'remote')
    mkdirSync(root, { recursive: true })
    const fetcher = new RemoteFetcher(root, { ...SYSTEM_DEPS, lookup: PUBLIC }, { ...DEFAULT_LIMITS, lookupMs: 20_000 })
    const error = await fetcher.latest({ kind: 'git', url: 'https://example.invalid/x.git' }).then(() => undefined, (failure: unknown) => failure as Error)
    expect(error).toBeDefined()
    expect(error!.message).not.toMatch(/127\.0\.0\.1/u)
  })
})

describe('names and paths the extractor refuses', () => {
  const pad = (data: Buffer): Buffer => Buffer.concat([data, Buffer.alloc((512 - data.length % 512) % 512)])
  const tar = (...members: Buffer[]): Buffer => gzipSync(Buffer.concat([...members, Buffer.alloc(1024)]))
  const file = (name: string, text = 'x'): Buffer[] => [tarHeader(name, Buffer.byteLength(text)), pad(Buffer.from(text))]

  it('refuses alternate data streams and Windows device names', async () => {
    for (const name of ['root/a.txt:secret', 'root/CON', 'root/nul.txt', 'root/dir/Com1.json', 'root/LPT9', 'root/aux.tar.gz']) {
      await expect(extractTarGz(tar(...file(name)), join(tempRoot(), 'out'), { strip: 1 })).rejects.toThrow(/name Windows cannot hold/u)
    }
    await expect(extractZip(zip({ 'con.txt': 'x' }), join(tempRoot(), 'out'))).rejects.toThrow(/name Windows cannot hold/u)
    await extractTarGz(tar(...file('root/console.txt'), ...file('root/com10')), join(tempRoot(), 'ok'), { strip: 1 })
  })

  it('refuses two tar members for one path, also as the case-insensitive file systems see it', async () => {
    await expect(extractTarGz(tar(...file('root/a.txt', 'one'), ...file('root/a.txt', 'two')), join(tempRoot(), 'out'), { strip: 1 })).rejects.toThrow(/two members for a\.txt/u)
    await expect(extractTarGz(tar(...file('root/a', 'file'), ...file('root/a/b', 'inside')), join(tempRoot(), 'out'), { strip: 1 })).rejects.toThrow(/two members for a/u)
    expect(destinationKey('/x/README.md', 'darwin')).toBe(destinationKey('/x/readme.md', 'darwin'))
    expect(destinationKey('/x/README.md', 'win32')).toBe(destinationKey('/x/readme.md', 'win32'))
    expect(destinationKey('/x/README.md', 'linux')).not.toBe(destinationKey('/x/readme.md', 'linux'))
  })

  it('counts the folders a member\'s path creates', async () => {
    await expect(extractTarGz(tar(...file('root/a/b/c/d/e/f.txt')), join(tempRoot(), 'out'), { strip: 1, limits: { maxBytes: 1024, maxEntries: 4 } })).rejects.toThrow(/larger than/u)
    await expect(extractZip(zip({ 'a/b/c/d/e/f.txt': 'x' }), join(tempRoot(), 'out'), { limits: { maxBytes: 1024, maxEntries: 4 } })).rejects.toThrow(/larger than/u)
  })
})

describe('what is read from a checkout before the copy', () => {
  it('refuses a plugin directory or manifest that is a link', () => {
    const checkout = tempRoot()
    mkdirSync(join(checkout, 'real/.claude-plugin'), { recursive: true })
    writeFileSync(join(checkout, 'real/.claude-plugin/plugin.json'), '{"name":"real"}')
    link('real', join(checkout, 'alias'), 'dir')
    mkdirSync(join(checkout, 'linked/.claude-plugin'), { recursive: true })
    link('/etc/hostname', join(checkout, 'linked/.claude-plugin/plugin.json'))
    mkdirSync(join(checkout, 'folder'), { recursive: true })
    link('../real/.claude-plugin', join(checkout, 'folder/.claude-plugin'), 'dir')
    expect(RemoteFetcher.inside(checkout, 'real')).toBe(join(checkout, 'real'))
    expect(() => RemoteFetcher.inside(checkout, 'alias')).toThrow(/link/u)
    expect(() => RemoteFetcher.inside(checkout, 'alias/.claude-plugin')).toThrow(/link/u)
    expect(() => RemoteFetcher.inside(checkout, 'linked')).toThrow(/\.claude-plugin\/plugin\.json is a link/u)
    expect(() => RemoteFetcher.inside(checkout, 'folder')).toThrow(/\.claude-plugin is a link/u)
  })
})

describe('the allowlist behind a proxy, and what messages show', () => {
  it('reaches GitHub and npm only as https on port 443', async () => {
    await withProxyEnv({ https_proxy: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9' }, async () => {
      const fetcher = new RemoteFetcher(tempRoot(), { ...SYSTEM_DEPS, lookup: PUBLIC })
      await expect(fetcher.download('https://github.com:8443/a', 1024, 5_000, fetcher.context('user'))).rejects.toThrow(/not github\.com/u)
      await expect(fetcher.download('http://registry.npmjs.org/a', 1024, 5_000, fetcher.context('user'))).rejects.toThrow(/not registry\.npmjs\.org/u)
      // The allowed form reaches the proxy (here, nothing listens).
      await expect(fetcher.download('https://github.com/a', 1024, 5_000, fetcher.context('user'))).rejects.toThrow(/cannot reach github\.com/u)
    })
  })

  it('never shows a proxy password or a query string', async () => {
    await withProxyEnv({ https_proxy: 'http://me:hunter2@127.0.0.1:9' }, async () => {
      const fetcher = new RemoteFetcher(tempRoot(), { ...SYSTEM_DEPS, lookup: PUBLIC })
      const error = await fetcher.download('https://registry.npmjs.org/a', 1024, 5_000, fetcher.context('user')).then(() => undefined, (failure: unknown) => failure as Error)
      expect(String(error?.message)).not.toMatch(/hunter2/u)
    })
    await withProxyEnv({ https_proxy: 'http://me:hunter2@[bad' }, async () => {
      const fetcher = new RemoteFetcher(tempRoot(), { ...SYSTEM_DEPS, lookup: PUBLIC })
      const error = await fetcher.download('https://registry.npmjs.org/a', 1024, 5_000, fetcher.context('user')).then(() => undefined, (failure: unknown) => failure as Error)
      expect(String(error?.message)).toMatch(/invalid proxy setting in https_proxy$/u)
      expect(String(error?.message)).not.toMatch(/hunter2/u)
    })
    const signed = fetchOf({ 'https://cdn.example/a.zip?X-Amz-Signature=secret123': async () => new Response('', { status: 403 }) })
    const fetcher = new RemoteFetcher(tempRoot(), { ...SYSTEM_DEPS, fetch: signed.fetch, lookup: PUBLIC })
    const error = await fetcher.download('https://cdn.example/a.zip?X-Amz-Signature=secret123', 1024, 5_000, fetcher.context('user')).then(() => undefined, (failure: unknown) => failure as Error)
    expect(error?.message).toMatch(/https:\/\/cdn\.example\/a\.zip answered 403/u)
    expect(error?.message).not.toMatch(/secret123/u)
  })
})

describe('round five: what git is given, and what the extractor takes as the same name', () => {
  it('passes a proxy password to git only in its environment, never in its arguments', async () => {
    const calls: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = []
    const git: Runner = async (_command, args, options) => { calls.push({ args, env: options.env ?? {} }); return args[0] === '--version' ? 'git version 2.43.0\n' : `${'e'.repeat(40)}\tHEAD\n` }
    const fetcher = new RemoteFetcher(tempRoot(), { ...SYSTEM_DEPS, git, lookup: PUBLIC })
    await withProxyEnv({ https_proxy: 'http://me:hunter2@proxy.example:3128' }, () => fetcher.latest({ kind: 'git', url: 'https://example.com/a.git' }))
    const call = calls.find(item => item.args.includes('ls-remote'))!
    expect(call.args.join(' ')).not.toMatch(/hunter2/u)
    expect(call.env['HF_GIT_PROXY']).toBe('http://me:hunter2@proxy.example:3128/')
  })

  it('shows no credentials or query string from a git error', async () => {
    const git: Runner = async (_command, args) => {
      if (args[0] === '--version') return 'git version 2.43.0\n'
      throw new Error("fatal: unable to access 'https://user:tok3n@example.com/a.git?sig=s3cret': Could not resolve host")
    }
    const fetcher = new RemoteFetcher(tempRoot(), { ...SYSTEM_DEPS, git, lookup: PUBLIC })
    for (const run of [() => fetcher.latest({ kind: 'git', url: 'https://user:tok3n@example.com/a.git?sig=s3cret' }), () => fetcher.checkout({ kind: 'git', url: 'https://user:tok3n@example.com/a.git?sig=s3cret' })]) {
      const error = await run().then(() => undefined, (failure: unknown) => failure as Error)
      expect(error?.message).toMatch(/example\.com\/a\.git/u)
      expect(error?.message).not.toMatch(/tok3n|s3cret/u)
    }
  })

  const pad = (data: Buffer): Buffer => Buffer.concat([data, Buffer.alloc((512 - data.length % 512) % 512)])
  const tar = (...members: Buffer[]): Buffer => gzipSync(Buffer.concat([...members, Buffer.alloc(1024)]))
  const file = (name: string, text = 'x'): Buffer[] => [tarHeader(name, Buffer.byteLength(text)), pad(Buffer.from(text))]

  it('refuses names Windows reads as others, and names equal once normalized', async () => {
    for (const name of ['root/a.', 'root/b ', 'root/dir./x.txt', 'root/dir /x.txt']) {
      await expect(extractTarGz(tar(...file(name)), join(tempRoot(), 'out'), { strip: 1 })).rejects.toThrow(/name Windows cannot hold/u)
    }
    await expect(extractTarGz(tar(...file('root/\u00e9.txt'), ...file('root/e\u0301.txt')), join(tempRoot(), 'out'), { strip: 1 })).rejects.toThrow(/two members/u)
    expect(destinationKey('/x/\u00c9.md', 'darwin')).toBe(destinationKey('/x/e\u0301.md', 'darwin'))
  })

  it('never writes over a file that is already there', async () => {
    const dest = tempRoot()
    writeFileSync(join(dest, 'a.txt'), 'before')
    await expect(extractTarGz(tar(...file('root/a.txt', 'after')), dest, { strip: 1 })).rejects.toThrow(/two members for a\.txt/u)
    await expect(extractZip(zip({ 'a.txt': 'after' }), dest)).rejects.toThrow(/two members for a\.txt/u)
    expect(readFileSync(join(dest, 'a.txt'), 'utf8')).toBe('before')
  })

  it('counts every tar header record, repeated directories and skipped members included', async () => {
    const repeated = Array.from({ length: 8 }, () => tarHeader('root/d/', 0, '5'))
    await expect(extractTarGz(tar(...repeated), join(tempRoot(), 'out'), { strip: 1, limits: { maxBytes: 1024, maxEntries: 5 } })).rejects.toThrow(/larger than/u)
    const skipped = Array.from({ length: 8 }, () => tarHeader('root/../escape', 0, '5'))
    await expect(extractTarGz(tar(...skipped), join(tempRoot(), 'out'), { strip: 1, limits: { maxBytes: 1024, maxEntries: 5 } })).rejects.toThrow(/larger than/u)
  })
})
