/**
 * Fetching plugins from the network into Harness Forge's own data directory:
 * git (a shallow, blobless, sparse fetch of one commit) when git is installed,
 * else GitHub's `.tar.gz` over HTTPS; npm packages as their registry tarball
 * alone; zip archives and hosted `marketplace.json` files over HTTPS.
 *
 * Nothing fetched runs before the person confirms it:
 * - git runs isolated from this computer's git configuration (no system or
 *   global config, hooks, templates, credential helpers, fsmonitor, LFS
 *   filters or submodules), with only the transport of the URL allowed and
 *   every URL and ref after `--`. Private HTTPS repositories therefore need a
 *   URL git can read without a credential helper; a pasted `ssh` URL uses the
 *   person's own SSH setup.
 * - npm does not run before confirmation: Harness Forge reads the package's
 *   registry document and downloads its tarball itself, at an exact version,
 *   from the registry's own origin, checked against its sha512 integrity.
 *   Once confirmed, the plugin and its registry dependencies are trusted, as
 *   OpenCode installs plugins: `npm install --ignore-scripts`, after refusing
 *   a resolved tree with anything that is not a registry tarball.
 * - What a marketplace names may use HTTPS only and may not lead to this
 *   computer or its local network. Every HTTP request Harness Forge makes
 *   connects to the address it checked (no second resolution), and every
 *   redirect, also of what the person pasted, is checked again. git, for a
 *   marketplace's URL, is pinned to the addresses checked and follows no
 *   redirects; where it cannot be pinned (git older than 2.37, or a proxy
 *   resolving hosts for it), only GitHub is fetched, over its archive or
 *   through the proxy.
 * - Every operation has a wall-clock bound, name resolution included, and
 *   downloads, unpacking and subprocesses a size bound enforced while they
 *   run (streamed bytes; written bytes; the size of the directory git or npm
 *   writes, polled).
 *
 * Behind a proxy (`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, minus `NO_PROXY`,
 * as git and npm read them) the proxy resolves hosts, so nothing can be
 * pinned: Harness Forge then reaches only {@link PROXY_HOSTS}, the configured
 * npm registry and the hosts the person pasted, through the proxy (CONNECT
 * for https, an absolute URL for http), and git, for a marketplace, only those
 * hosts as well.
 * @module @kirkchinese/harness-forge
 */
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { Readable } from 'node:stream'
import {
  dependencyProblem,
  githubCommitApi,
  githubTarball,
  gitTransport,
  HarnessError,
  isFullSha,
  isInside,
  isValidRef,
  normalizeRegistry,
  NPM_REGISTRY,
  type ArchiveSpec,
  type GitSpec,
  type NpmSpec,
} from '@kirkchinese/harness-forge-core'
import { messageOf } from '../../shared/util.js'
import { npmLaunch } from '../npm.js'
import { extractTarGz, extractZip, PLUGIN_LIMITS, refuseLinkedManifests, REPOSITORY_LIMITS, treeSize, zipRoot, type TreeLimits } from './archive.js'

/**
 * One HTTP GET: connecting to `address` (checked already) for the URL's host,
 * never resolving the name again; or, with `proxy`, through that proxy, which
 * resolves it.
 */
export type PinnedFetch = (url: string, init: { readonly headers: Readonly<Record<string, string>>; readonly signal: AbortSignal; readonly address?: string; readonly family?: 4 | 6; readonly proxy?: string }) => Promise<Response>

/** What Harness Forge reaches through a proxy, besides the configured npm registry and the hosts the person pasted: GitHub and npm. */
export const PROXY_HOSTS: ReadonlySet<string> = new Set(['github.com', 'codeload.github.com', 'api.github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com', 'registry.npmjs.org'])

/** Whether `NO_PROXY` exempts a host (`*`, a name and its subdomains, `.name`, optionally with `:port`). */
function noProxy(host: string, port: string): boolean {
  const list = (process.env['no_proxy'] ?? process.env['NO_PROXY'] ?? '').split(/[\s,]+/u).filter(entry => entry.length > 0)
  const bare = host.toLowerCase().replace(/^\[|\]$/gu, '')
  return list.some((entry) => {
    if (entry === '*') return true
    const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/u.exec(entry.toLowerCase())
    if (match === null) return false
    const name = match[1]!.replace(/^\[|\]$/gu, '').replace(/^\*?\./u, '')
    if (match[2] !== undefined && match[2] !== port) return false
    return bare === name || bare.endsWith(`.${name}`)
  })
}

/** The proxy git, npm and Harness Forge use for a URL, as they read the environment; undefined for a direct connection. */
export function proxyFor(url: URL): URL | undefined {
  // curl's order (lowercase first), which git and npm follow too.
  const keys = url.protocol === 'https:' ? ['https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY'] : ['http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY']
  const key = keys.find(name => (process.env[name]?.trim() ?? '').length > 0)
  if (key === undefined) return undefined
  const value = process.env[key]!.trim()
  if (noProxy(url.hostname, url.port || (url.protocol === 'https:' ? '443' : '80'))) return undefined
  let proxy: URL
  try {
    proxy = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(value) ? value : `http://${value}`)
  } catch {
    // Its content is not repeated: it may hold a password.
    throw new HarnessError('fetch-failed', `invalid proxy setting in ${key}`, { suggestion: `Set ${key} to a URL such as http://proxy.example:3128.` })
  }
  if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') throw new HarnessError('fetch-failed', `Harness Forge supports http:// and https:// proxies, not ${proxy.protocol.replace(':', '')}://`, { suggestion: 'Set HTTPS_PROXY to an HTTP proxy.' })
  return proxy
}

/** How a subprocess is run. */
export interface RunOptions {
  readonly cwd?: string
  readonly timeoutMs: number
  readonly env?: NodeJS.ProcessEnv
  /** Aborting kills the process. */
  readonly signal?: AbortSignal
}

/** Runs a program to its end and resolves with its stdout; a missing program rejects with `code: 'ENOENT'`. */
export type Runner = (command: string, args: readonly string[], options: RunOptions) => Promise<string>

/** What the fetcher reaches outside the process: replaced in tests. */
export interface FetchDeps {
  readonly fetch: PinnedFetch
  /** Runs `git`. */
  readonly git: Runner
  /** Runs `npm` (as {@link npmLaunch} finds it). */
  readonly npm: Runner
  /** The addresses a host name resolves to. */
  readonly lookup: (host: string) => Promise<readonly string[]>
}

/**
 * Whose say-so a fetch is on: `user` for what the person pasted (any host they
 * typed), `marketplace` for what a marketplace entry names (HTTPS to public
 * addresses only).
 */
export type Trust = 'user' | 'marketplace'

/** One operation: its trust and its wall-clock bound, shared by every step of it. */
export interface FetchContext {
  readonly trust: Trust
  readonly signal: AbortSignal
  readonly deadline: number
  /** Hosts the person pasted (lowercase): reached through a proxy besides {@link PROXY_HOSTS}, when the person's say-so counts. */
  readonly userHosts: readonly string[]
}

/** Time and size bounds. */
export interface FetchLimits {
  /** A git fetch, an archive download, an npm pack or install. */
  readonly fetchMs: number
  /** A `git ls-remote`, a commit lookup or an `npm view`. */
  readonly lookupMs: number
  /** One whole operation (opening a marketplace, preparing or installing a plugin), every step included. */
  readonly operationMs: number
  /** A hosted `marketplace.json`. */
  readonly jsonBytes: number
  readonly jsonMs: number
  /** An archive (a GitHub tarball, a zip source, an npm tarball). */
  readonly archiveBytes: number
  /** What one git fetch or npm install may write, enforced while it runs. */
  readonly tree: TreeLimits
  /** How often the size of what a subprocess writes is checked. */
  readonly pollMs: number
}

/** Claude Code's own bounds where it has them (120 s clone; 5 MiB / 10 s JSON; 256 MiB archives), a little more time for slow links. */
export const DEFAULT_LIMITS: FetchLimits = {
  fetchMs: 180_000,
  lookupMs: 30_000,
  operationMs: 600_000,
  jsonBytes: 5 * 1024 * 1024,
  jsonMs: 30_000,
  archiveBytes: 256 * 1024 * 1024,
  tree: REPOSITORY_LIMITS,
  pollMs: 250,
}

function processRunner(resolveCommand: (args: readonly string[]) => { command: string; args: readonly string[] }): Runner {
  return (_command, args, options) => new Promise((resolvePromise, reject) => {
    const launch = resolveCommand(args)
    execFile(launch.command, [...launch.args], {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      timeout: options.timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: options.env ?? process.env,
    }, (error, stdout, stderr) => {
      if (error === null) {
        resolvePromise(stdout)
        return
      }
      const failure = error as NodeJS.ErrnoException & { killed?: boolean }
      if (failure.code === 'ENOENT') {
        reject(Object.assign(new Error(`${launch.command} is not installed`), { code: 'ENOENT' }))
        return
      }
      const detail = scrub(String(stderr)).trim().split(/\r?\n/u).filter(line => line.length > 0 && !/^warning: filtering not recognized/u.test(line)).slice(-3).join(' | ')
      reject(new Error(failure.killed === true && failure.name !== 'AbortError' ? `${launch.command} ${args.find(arg => !arg.startsWith('-') && !arg.includes('=')) ?? ''} timed out after ${String(Math.round(options.timeoutMs / 1000))} s` : detail.length > 0 ? detail : scrub(messageOf(error))))
    })
  })
}

/**
 * Where the URL scheme ending at `colon` (the `:` of a `://`) starts, as
 * `\b[a-z][a-z0-9+.-]*` finds it, any length. Scans, here and below, rather than
 * patterns: a pattern tried from every letter of a long run is quadratic.
 */
function schemeStart(text: string, colon: number): number | undefined {
  let start = colon
  while (start > 0 && /[a-z0-9+.-]/iu.test(text[start - 1] ?? '')) start--
  for (let at = start; at < colon; at++) {
    if (/[a-z]/iu.test(text[at] ?? '') && (at === 0 || !/\w/u.test(text[at - 1] ?? ''))) return at
  }
  return undefined
}

/** Where the run from `from` of characters not in `stop` ends. */
function runEnd(text: string, from: number, stop: RegExp): number {
  let end = from
  while (end < text.length && !stop.test(text[end] ?? '')) end++
  return end
}

/** A text with the credentials of any URL in it replaced (proxy passwords never reach a message). */
export function redact(text: string): string {
  let out = ''
  let cursor = 0
  for (let colon = text.indexOf('://'); colon !== -1; colon = text.indexOf('://', colon + 3)) {
    if (schemeStart(text, colon) === undefined) continue
    const end = runEnd(text, colon + 3, /[/@\s]/u)
    if (text[end] !== '@') continue
    out += `${text.slice(cursor, colon + 3)}***@`
    cursor = end + 1
  }
  return out + text.slice(cursor)
}

/** A text with every URL in it shown as {@link shown} shows one (for what git and npm write to stderr). */
export function scrub(text: string): string {
  const redacted = redact(text)
  let out = ''
  let cursor = 0
  for (let colon = redacted.indexOf('://'); colon !== -1; colon = redacted.indexOf('://', Math.max(colon + 3, cursor))) {
    const start = schemeStart(redacted, colon)
    if (start === undefined || start < cursor) continue
    const end = runEnd(redacted, colon + 3, /[\s'"<>]/u)
    if (end === colon + 3) continue
    out += redacted.slice(cursor, start) + shown(redacted.slice(start, end))
    cursor = end
  }
  return out + redacted.slice(cursor)
}

/** A URL as messages show it: no credentials, no query string (signed URLs), no fragment. */
export function shown(url: string | URL): string {
  try {
    const parsed = new URL(String(url))
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  } catch {
    return redact(String(url)).replace(/[?#].*$/su, '')
  }
}

/** Statuses whose answer has no body. */
const NO_BODY = new Set([204, 205, 304])

/** A web Response over a Node response. */
function webResponse(response: IncomingMessage): Response {
  const status = response.statusCode ?? 0
  if (!Number.isInteger(status) || status < 200 || status > 599) throw new HarnessError('fetch-failed', `the server answered with status ${String(status)}, which is not an HTTP answer`)
  const headers = new Headers()
  for (const [key, value] of Object.entries(response.headers)) for (const item of [value ?? []].flat()) headers.append(key, item)
  if (NO_BODY.has(status)) response.resume()
  return new Response(NO_BODY.has(status) ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, statusText: response.statusMessage ?? '', headers })
}

function proxyAuthorization(proxy: URL): Record<string, string> {
  if (proxy.username.length === 0) return {}
  return { 'proxy-authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` }
}

/** Settle a request with its response; a response that cannot be read is destroyed and the request rejected, never thrown from the callback. */
function settle(response: IncomingMessage, resolvePromise: (value: Response) => void, reject: (error: unknown) => void): void {
  try {
    resolvePromise(webResponse(response))
  } catch (error: unknown) {
    response.destroy()
    response.socket?.destroy()
    reject(error)
  }
}

/** A connection to the proxy itself (TLS for an https:// proxy). */
function proxyRequest(proxy: URL, options: RequestOptions): ReturnType<typeof httpRequest> {
  const base = { host: proxy.hostname.replace(/^\[|\]$/gu, ''), port: Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80)), agent: false as const }
  return proxy.protocol === 'https:' ? httpsRequest({ ...base, ...options, servername: base.host }) : httpRequest({ ...base, ...options })
}

/** A tunnel through the proxy to `host:port` (HTTP CONNECT). */
function tunnel(proxy: URL, host: string, port: number, signal: AbortSignal): Promise<Socket> {
  return new Promise((resolvePromise, reject) => {
    const authority = `${isIP(host) === 6 ? `[${host}]` : host}:${String(port)}`
    const request = proxyRequest(proxy, { method: 'CONNECT', path: authority, headers: { host: authority, ...proxyAuthorization(proxy) }, signal })
    request.on('connect', (response, socket) => {
      if (response.statusCode === 200 && !signal.aborted) resolvePromise(socket)
      else if (response.statusCode === 200) {
        socket.destroy()
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      }
      else {
        socket.destroy()
        reject(new HarnessError('fetch-failed', `the proxy refused to connect to ${host} (${String(response.statusCode)})`))
      }
    })
    request.on('error', reject)
    request.end()
  })
}

/**
 * TLS over a proxy tunnel, verified against the target's name (or IP address,
 * which gets no SNI). The handshake is bound by `signal` (the operation's
 * deadline and cancellation); when it fails, closes or is stopped, both the
 * TLS socket and the tunnel are destroyed.
 */
function secureTunnel(socket: Socket, host: string, ca: string | Buffer | undefined, signal: AbortSignal): Promise<TLSSocket> {
  return new Promise((resolvePromise, reject) => {
    const secure = tlsConnect({ socket, host, ...(isIP(host) === 0 ? { servername: host } : {}), ...(ca !== undefined ? { ca } : {}), ALPNProtocols: ['http/1.1'] })
    let settled = false
    const closed = (): void => { fail(new HarnessError('fetch-failed', `the connection to ${host} closed during the TLS handshake`)) }
    const aborted = (): void => { fail(signal.reason instanceof Error ? signal.reason : Object.assign(new Error('timed out'), { name: 'TimeoutError' })) }
    const done = (): void => {
      settled = true
      signal.removeEventListener('abort', aborted)
      secure.off('error', fail).off('close', closed)
      socket.off('close', closed).off('end', closed)
    }
    function fail(error: unknown): void {
      if (settled) return
      done()
      secure.destroy()
      socket.destroy()
      reject(error)
    }
    secure.once('secureConnect', () => {
      if (settled) return
      done()
      resolvePromise(secure)
    })
    secure.on('error', fail).on('close', closed)
    socket.on('close', closed).on('end', closed)
    if (signal.aborted) aborted()
    else signal.addEventListener('abort', aborted, { once: true })
  })
}

/**
 * {@link PinnedFetch} over `http(s).request`: directly, its `lookup` answering
 * with the address checked; or through a proxy, a CONNECT tunnel carrying TLS
 * for https (the request is written on that socket alone, with no agent of its
 * own), an absolute URL for http. No connection reuse. `ca` replaces the
 * trusted certificates (tests).
 */
export function httpClient(options: { readonly ca?: string | Buffer } = {}): PinnedFetch {
  const ca = options.ca
  return async (url, init) => {
    const target = new URL(url)
    const host = target.hostname.replace(/^\[|\]$/gu, '')
    if (init.proxy !== undefined) {
      const proxy = new URL(init.proxy)
      if (target.protocol === 'http:') {
        return new Promise((resolvePromise, reject) => {
          const request = proxyRequest(proxy, { method: 'GET', path: target.href, headers: { ...init.headers, host: target.host, ...proxyAuthorization(proxy) }, signal: init.signal })
          request.on('response', (response) => { settle(response, resolvePromise, reject) })
          request.on('error', reject)
          request.end()
        })
      }
      const socket = await tunnel(proxy, host, Number(target.port || 443), init.signal)
      const secure = await secureTunnel(socket, host, ca, init.signal)
      return new Promise((resolvePromise, reject) => {
        // No `agent`: Node then writes the request on the socket createConnection returns (an agent would open its own, directly).
        const request = httpRequest({
          method: 'GET',
          path: `${target.pathname}${target.search}`,
          headers: { ...init.headers, host: target.host },
          signal: init.signal,
          createConnection: () => secure,
        }, (response) => { settle(response, resolvePromise, reject) })
        request.on('error', (error) => { secure.destroy(); reject(error) })
        request.end()
      })
    }
    return new Promise((resolvePromise, reject) => {
      const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
        method: 'GET',
        headers: init.headers,
        signal: init.signal,
        agent: false,
        ...(ca !== undefined ? { ca } : {}),
        lookup: (_host, lookupOptions, callback) => {
          if ((lookupOptions as { all?: boolean }).all === true) (callback as unknown as (error: null, addresses: Array<{ address: string; family: number }>) => void)(null, [{ address: init.address!, family: init.family ?? 4 }])
          else callback(null, init.address!, init.family ?? 4)
        },
      }, (response: IncomingMessage) => { settle(response, resolvePromise, reject) })
      request.on('error', reject)
      request.end()
    })
  }
}

/** The machine's git, npm, HTTP and resolver. */
export const SYSTEM_DEPS: FetchDeps = {
  fetch: httpClient(),
  git: processRunner(args => ({ command: 'git', args })),
  npm: processRunner(args => npmLaunch(args)),
  lookup: async host => (await dnsLookup(host, { all: true, verbatim: true })).map(entry => entry.address),
}

/** Addresses a marketplace may not lead to: this computer, private and shared networks, link-local, multicast, reserved and documentation ranges. */
const NOT_PUBLIC_V4 = new BlockList()
/** Kept apart: a BlockList also matches IPv4 addresses against IPv4-mapped IPv6 ranges. */
const NOT_PUBLIC_V6 = new BlockList()
for (const [network, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) NOT_PUBLIC_V4.addSubnet(network, bits, 'ipv4')
for (const [network, bits] of [
  ['::', 127], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) NOT_PUBLIC_V6.addSubnet(network, bits, 'ipv6')

/** Whether an IP address is on the public internet. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 0) return false
  return family === 4 ? !NOT_PUBLIC_V4.check(address, 'ipv4') : !NOT_PUBLIC_V6.check(address, 'ipv6')
}

function cacheKey(...parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24)
}

function temporary(parent: string): string {
  mkdirSync(parent, { recursive: true })
  return join(parent, `.tmp-${randomBytes(6).toString('hex')}`)
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Why a download failed, in words a person can act on. */
function networkError(url: string, error: unknown): HarnessError {
  if (error instanceof HarnessError) return error
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause
  const name = (error as { name?: unknown } | undefined)?.name
  const own = (error as { code?: unknown } | undefined)?.code
  const code = typeof own === 'string' ? own : typeof cause?.code === 'string' ? cause.code : name === 'TimeoutError' || name === 'AbortError' ? 'timed out' : redact(messageOf(error))
  return new HarnessError('fetch-failed', `cannot reach ${hostOf(url)} (${code})`, {
    cause: error,
    suggestion: 'Check the network connection. Harness Forge\'s own downloads do not go through a proxy; behind one, install git (it reads HTTPS_PROXY).',
  })
}

/** An HTTP error answer, with GitHub's rate limit told apart from a missing repository. */
function httpError(url: URL, response: Response): HarnessError {
  const status = response.status
  const github = /(?:^|\.)github(?:usercontent)?\.com$/iu.test(url.hostname)
  const remaining = response.headers.get('x-ratelimit-remaining')
  if (github && (status === 429 || (status === 403 && remaining === '0'))) {
    const reset = Number(response.headers.get('x-ratelimit-reset') ?? '')
    const when = Number.isFinite(reset) && reset > 0 ? ` until ${new Date(reset * 1000).toISOString().slice(11, 16)} UTC` : ''
    return new HarnessError('fetch-failed', `GitHub refuses more requests from this network for now (rate limit, HTTP ${String(status)})${when}`, {
      suggestion: 'Install git: cloning does not count against GitHub\'s API limit. Or try again later.',
    })
  }
  return new HarnessError('fetch-failed', `${shown(url)} answered ${String(status)}`, status === 404 ? { suggestion: 'Check the name and that the repository is public.' } : status === 401 || status === 403 ? { suggestion: 'The source is private or refuses this network; Harness Forge fetches public sources without signing in.' } : undefined)
}

function tooLargeError(what: string, limits: TreeLimits): HarnessError {
  return new HarnessError('fetch-failed', `${what} is larger than Harness Forge accepts (${String(Math.round(limits.maxBytes / 1024 / 1024))} MiB or ${String(limits.maxEntries)} files)`)
}

function timedOut(what: string, ms: number): HarnessError {
  return new HarnessError('fetch-failed', `${what} timed out after ${String(Math.round(ms / 1000))} s`, { suggestion: 'Check the network connection and try again.' })
}

/** A git checkout of one commit. */
export interface Checkout {
  /** The repository root, as checked out. */
  readonly dir: string
  readonly sha: string
}

/** One npm package version as its registry describes it. */
export interface NpmVersion {
  readonly name: string
  /** An exact version. */
  readonly version: string
  /** `sha512-…` of its tarball. */
  readonly integrity: string
  /** The registry it is fetched from, with a trailing slash. */
  readonly registry: string
  /** Its tarball, on the registry's origin. */
  readonly tarball: string
}

/** A version npm would install as it is: `1.2.3`, `1.2.3-beta.1`, no range. */
const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
/** A dist-tag (`latest`, `next`). */
const DIST_TAG = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u
const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/u
/** A registry document (npm's abbreviated form): large packages have many versions. */
const PACKUMENT_BYTES = 64 * 1024 * 1024

/** Fetches into `<root>/cache` (checkouts to browse and copy from) and the directories its callers name. */
export class RemoteFetcher {
  private gitVersion: Promise<readonly [number, number] | undefined> | undefined

  constructor(
    readonly root: string,
    private readonly deps: FetchDeps = SYSTEM_DEPS,
    readonly limits: FetchLimits = DEFAULT_LIMITS,
  ) {}

  /** A new operation: every step taken with it shares its wall-clock bound. */
  context(trust: Trust, userHosts: readonly string[] = []): FetchContext {
    return { trust, signal: AbortSignal.timeout(this.limits.operationMs), deadline: Date.now() + this.limits.operationMs, userHosts: userHosts.map(host => host.toLowerCase()) }
  }

  /**
   * Refuse a host Harness Forge may not reach through a proxy: GitHub and npm
   * ({@link PROXY_HOSTS}), the configured npm registry, and (for what the
   * person pasted, not what a marketplace names) the hosts they pasted.
   */
  private allowProxied(url: URL, context: FetchContext): void {
    const bare = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '')
    // GitHub and npm only as themselves: https on port 443.
    if (PROXY_HOSTS.has(bare) && url.protocol === 'https:' && (url.port === '' || url.port === '443')) return
    if (url.origin === new URL(this.configuredRegistry()).origin) return
    if (context.trust === 'user' && context.userHosts.includes(bare)) return
    throw new HarnessError('fetch-failed', `behind a proxy, Harness Forge reaches only GitHub, npm's registry, your npm registry and the sources you paste, not ${bare}`, {
      suggestion: `If you trust ${bare}, paste that source yourself, or add it to NO_PROXY if it can be reached directly.`,
    })
  }

  /** The same operation on another's say-so (an entry of a marketplace being read). */
  static as(context: FetchContext, trust: Trust): FetchContext {
    return { ...context, trust }
  }

  private remaining(context: FetchContext, stepMs: number, what: string): number {
    const left = context.deadline - Date.now()
    if (left <= 0 || context.signal.aborted) throw timedOut(what, this.limits.operationMs)
    return Math.min(stepMs, left)
  }

  /**
   * Run a subprocess within the operation's bound; with `watch`, the
   * directory it writes is measured while it runs and the process killed
   * once it is past the size bound.
   */
  private async run(runner: Runner, command: string, args: readonly string[], context: FetchContext, options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv; readonly watch?: string; readonly stepMs: number; readonly what: string }): Promise<string> {
    const timeoutMs = this.remaining(context, options.stepMs, options.what)
    const controller = new AbortController()
    const stop = (reason: HarnessError): void => {
      if (!controller.signal.aborted) controller.abort(reason)
    }
    const outer = (): void => { stop(timedOut(options.what, this.limits.operationMs)) }
    context.signal.addEventListener('abort', outer, { once: true })
    const watch = options.watch
    const timer = watch === undefined ? undefined : setInterval(() => {
      if (treeSize(watch, this.limits.tree).over) stop(tooLargeError(options.what, this.limits.tree))
    }, this.limits.pollMs)
    try {
      const out = await runner(command, args, { ...(options.cwd !== undefined ? { cwd: options.cwd } : {}), ...(options.env !== undefined ? { env: options.env } : {}), timeoutMs, signal: controller.signal })
      if (watch !== undefined && treeSize(watch, this.limits.tree).over) throw tooLargeError(options.what, this.limits.tree)
      return out
    } catch (error: unknown) {
      if (controller.signal.aborted && controller.signal.reason instanceof HarnessError) throw controller.signal.reason
      throw error
    } finally {
      if (timer !== undefined) clearInterval(timer)
      context.signal.removeEventListener('abort', outer)
    }
  }

  // --- the network policy -------------------------------------------------------

  /** A host's addresses, within the operation's bound (and the lookup bound). */
  private async resolveHost(host: string, context: FetchContext): Promise<readonly string[]> {
    const ms = this.remaining(context, this.limits.lookupMs, `resolving ${host}`)
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        this.deps.lookup(host),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new HarnessError('fetch-failed', `resolving ${host} timed out`)) }, ms) }),
      ])
    } catch (error: unknown) {
      throw networkError(`https://${host}/`, error)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * The addresses of a host, refused (with `checked`) when any of them is not
   * on the public internet or the name does not resolve.
   */
  async addresses(host: string, context: FetchContext, checked: boolean): Promise<readonly string[]> {
    const bare = host.replace(/^\[|\]$/gu, '')
    const addresses = isIP(bare) !== 0 ? [bare] : await this.resolveHost(bare, context)
    if (addresses.length === 0) throw new HarnessError('fetch-failed', `${bare} does not resolve`)
    const local = checked ? addresses.find(address => !isPublicAddress(address)) : undefined
    if (local !== undefined) {
      throw new HarnessError('fetch-failed', `a marketplace or a redirect may not send Harness Forge to ${bare} (${local}): that address is on this computer or a local network`, {
        suggestion: 'To install from your own network, paste the final address of that source yourself.',
      })
    }
    return addresses
  }

  /** Refuse a URL the operation may not request: only https for a marketplace, http(s) for the person. */
  private allowHttp(url: URL, context: FetchContext): void {
    const allowed = context.trust === 'marketplace' ? ['https:'] : ['https:', 'http:']
    if (!allowed.includes(url.protocol)) throw new HarnessError('fetch-failed', `${context.trust === 'marketplace' ? 'only https downloads are fetched for a marketplace' : 'only http(s) downloads are supported'}: ${shown(url)}`)
    if (url.username.length > 0 || url.password.length > 0) throw new HarnessError('fetch-failed', `a download URL may not carry credentials: ${url.host}`)
  }

  /**
   * Bytes of a URL, refused past `maxBytes` (declared or received) or
   * `timeoutMs`. Each hop connects to the address checked for it; redirects
   * are followed by hand and, wherever the first hop pointed, every later one
   * must be a public address.
   */
  async download(url: string, maxBytes: number, timeoutMs: number, context: FetchContext, headers: Record<string, string> = {}): Promise<Buffer> {
    let current: URL
    try {
      current = new URL(url)
    } catch {
      throw new HarnessError('fetch-failed', `not a URL: ${shown(url)}`)
    }
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(this.remaining(context, timeoutMs, `downloading ${hostOf(url)}`))])
    for (let hop = 0; ; hop += 1) {
      this.allowHttp(current, context)
      const proxy = proxyFor(current)
      let target: { readonly address?: string; readonly family?: 4 | 6; readonly proxy?: string }
      if (proxy !== undefined) {
        // The proxy resolves the name: only hosts on the allowlist are asked for.
        this.allowProxied(current, context)
        target = { proxy: proxy.href }
      } else {
        const [address] = await this.addresses(current.hostname, context, context.trust === 'marketplace' || hop > 0)
        target = { address: address!, family: isIP(address!) === 6 ? 6 : 4 }
      }
      let response: Response
      try {
        response = await this.deps.fetch(current.href, { headers: { 'user-agent': 'harness-forge', ...headers }, signal, ...target })
      } catch (error: unknown) {
        throw networkError(shown(current), error)
      }
      if (response.status >= 300 && response.status < 400 && response.status !== 304) {
        const location = response.headers.get('location')
        await response.body?.cancel().catch(() => undefined)
        if (location === null) throw new HarnessError('fetch-failed', `${shown(current)} redirected without saying where`)
        if (hop >= 5) throw new HarnessError('fetch-failed', `${shown(url)} redirected too many times`)
        const next = new URL(location, current)
        // A redirect may not downgrade an https download.
        if (current.protocol === 'https:' && next.protocol !== 'https:') throw new HarnessError('fetch-failed', `${shown(current)} redirected to a non-https address`)
        current = next
        continue
      }
      if (!response.ok) {
        const error = httpError(current, response)
        await response.body?.cancel().catch(() => undefined)
        throw error
      }
      const declared = Number(response.headers.get('content-length') ?? '0')
      const tooLarge = (): HarnessError => new HarnessError('fetch-failed', `${shown(url)} is larger than ${String(Math.round(maxBytes / 1024 / 1024))} MiB`)
      if (declared > maxBytes) {
        await response.body?.cancel().catch(() => undefined)
        throw tooLarge()
      }
      const chunks: Buffer[] = []
      let received = 0
      try {
        const reader = response.body?.getReader()
        if (reader === undefined) return Buffer.alloc(0)
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          received += value.byteLength
          if (received > maxBytes) {
            await reader.cancel().catch(() => undefined)
            throw tooLarge()
          }
          chunks.push(Buffer.from(value))
        }
      } catch (error: unknown) {
        throw networkError(shown(current), error)
      }
      return Buffer.concat(chunks)
    }
  }

  /** A hosted JSON document (a `marketplace.json`, a registry document). */
  async json(url: string, context: FetchContext = this.context('user'), maxBytes = this.limits.jsonBytes, accept = 'application/json'): Promise<Record<string, unknown>> {
    const bytes = await this.download(url, maxBytes, this.limits.jsonMs, context, { accept })
    try {
      const value: unknown = JSON.parse(bytes.toString('utf8'))
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
    } catch {
      // Reported below.
    }
    throw new HarnessError('manifest-invalid', `${shown(url)} is not a JSON object`)
  }

  // --- git ------------------------------------------------------------------

  /** Empty hooks, template and working directories and an empty global configuration: what git reads instead of this computer's. */
  private isolation(): { readonly hooks: string; readonly template: string; readonly config: string; readonly empty: string } {
    const base = join(this.root, 'git-isolation')
    const paths = { hooks: join(base, 'hooks'), template: join(base, 'template'), config: join(base, 'gitconfig'), empty: join(base, 'cwd') }
    for (const dir of [paths.hooks, paths.template, paths.empty]) mkdirSync(dir, { recursive: true })
    if (!existsSync(paths.config)) writeFileSync(paths.config, '')
    return paths
  }

  /** The environment git runs in: no `GIT_*` variable of this process, no system or global configuration, no prompts, no LFS downloads. */
  private gitEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    // No proxy variable either: git is told the route Harness Forge chose (gitOptions), not left to read curl's.
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !/^GIT_/iu.test(key) && !/^(?:https?|all|no)_proxy$/iu.test(key) && key !== 'SSH_ASKPASS') env[key] = value
    return {
      ...env,
      // The empty working directory and the checkouts are inside the data directory: no repository around it is found.
      GIT_CEILING_DIRECTORIES: resolve(this.root),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: this.isolation().config,
      GIT_TERMINAL_PROMPT: '0',
      GIT_LFS_SKIP_SMUDGE: '1',
      GCM_INTERACTIVE: 'never',
    }
  }

  /** git's version, asked once; undefined when git is not installed. */
  private version(): Promise<readonly [number, number] | undefined> {
    this.gitVersion ??= this.deps.git('git', ['--version'], { cwd: this.isolation().empty, timeoutMs: this.limits.lookupMs, env: this.gitEnv() }).then((out) => {
      const match = /(\d+)\.(\d+)/u.exec(out)
      return match === null ? [2, 0] as const : [Number(match[1]), Number(match[2])] as const
    }, () => undefined)
    return this.gitVersion
  }

  /** Whether git is installed. */
  async hasGit(): Promise<boolean> {
    return await this.version() !== undefined
  }

  /**
   * Whether git may fetch `url` in this operation. For a marketplace's URL,
   * git must connect to the addresses Harness Forge checked: that needs
   * `http.curloptResolve` (git 2.37+) and no proxy resolving hosts instead;
   * behind a proxy only github.com is fetched with git.
   */
  private async gitFor(url: string, context: FetchContext): Promise<{ readonly use: boolean; readonly why?: string }> {
    const version = await this.version()
    if (version === undefined) return { use: false, why: 'git is not installed' }
    if (context.trust === 'user') return { use: true }
    if (version[0] < 2 || (version[0] === 2 && version[1] < 37)) return { use: false, why: 'git older than 2.37 cannot be held to the addresses Harness Forge checked' }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      // Not an https URL: gitOptions refuses it.
      return { use: true }
    }
    if (proxyFor(parsed) !== undefined) {
      // The proxy resolves hosts for git: only the hosts Harness Forge may reach through it.
      try {
        this.allowProxied(parsed, context)
      } catch (error: unknown) {
        return { use: false, why: messageOf(error) }
      }
    }
    return { use: true }
  }

  /**
   * The `-c` options every git command for a URL runs with, and the URL as
   * Harness Forge read it (what git is given): nothing of this computer's that
   * runs code, only the URL's transport, no redirects, the proxy Harness Forge
   * chose (or none), and for a marketplace HTTPS pinned to the public
   * addresses checked.
   */
  private async gitOptions(raw: string, context: FetchContext): Promise<{ readonly options: string[]; readonly url: string; readonly env: Readonly<Record<string, string>> }> {
    if (raw.startsWith('-') || /\s/u.test(raw)) throw new HarnessError('unsupported-source', `not a git URL: ${shown(raw)}`)
    const transport = gitTransport(raw)
    if (context.trust === 'marketplace' && transport !== 'https') throw new HarnessError('unsupported-source', `only https git URLs are fetched for a marketplace entry: ${shown(raw)}`)
    if (transport === undefined) throw new HarnessError('unsupported-source', `git URLs must use https, http, ssh, git or file: ${shown(raw)}`)
    // `user@host:path` is not a URL; every other form is given to git as it was parsed here.
    const parsed = /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw) ? new URL(raw) : undefined
    const url = parsed?.href ?? raw
    const { hooks } = this.isolation()
    const options = [
      `core.hooksPath=${hooks}`,
      'core.fsmonitor=false',
      'protocol.allow=never',
      `protocol.${transport}.allow=always`,
      ...(transport !== 'file' ? ['protocol.file.allow=never'] : []),
      'submodule.recurse=false',
      'fetch.recurseSubmodules=false',
      'credential.helper=',
      'core.askPass=',
      'init.defaultBranch=main',
      'advice.detachedHead=false',
    ]
    const proxy = parsed !== undefined && (transport === 'https' || transport === 'http') ? proxyFor(parsed) : undefined
    // The route Harness Forge chose; through the child's environment, so a proxy password never sits in its arguments.
    const env: Record<string, string> = {}
    const extra: string[] = []
    if (transport === 'https' || transport === 'http') {
      options.push('http.followRedirects=false')
      const version = await this.version()
      if (version !== undefined && (version[0] > 2 || (version[0] === 2 && version[1] >= 31))) {
        extra.push('--config-env=http.proxy=HF_GIT_PROXY')
        env['HF_GIT_PROXY'] = proxy?.href ?? ''
      } else if (proxy === undefined || (proxy.username.length === 0 && proxy.password.length === 0)) {
        options.push(`http.proxy=${proxy?.href ?? ''}`)
      } else {
        throw new HarnessError('fetch-failed', 'git older than 2.31 cannot be given a proxy password safely', { suggestion: 'Update git to 2.31 or later.' })
      }
    }
    if (context.trust === 'marketplace') {
      if (parsed === undefined || parsed.username.length > 0 || parsed.password.length > 0) throw new HarnessError('unsupported-source', 'a marketplace entry may not carry credentials in its URL')
      const host = parsed.hostname.replace(/^\[|\]$/gu, '')
      if (proxy === undefined) {
        const addresses = await this.addresses(host, context, true)
        // curl connects to the addresses checked, not to a second answer from the resolver.
        if (isIP(host) === 0) options.push(`http.curloptResolve=${host}:${parsed.port || '443'}:${addresses.map(address => isIP(address) === 6 ? `[${address}]` : address).join(',')}`)
      }
    }
    return { options: [...options.flatMap(option => ['-c', option]), ...extra], url, env }
  }

  private runGit(options: readonly string[], args: readonly string[], context: FetchContext, step: { readonly cwd?: string; readonly watch?: string; readonly stepMs?: number; readonly what: string; readonly env?: Readonly<Record<string, string>> }): Promise<string> {
    return this.run(this.deps.git, 'git', [...options, ...args], context, { cwd: step.cwd ?? this.isolation().empty, ...(step.watch !== undefined ? { watch: step.watch } : {}), env: { ...this.gitEnv(), ...step.env }, stepMs: step.stepMs ?? this.limits.fetchMs, what: step.what })
  }

  /** The commit a git source points at now: its pinned SHA, else its ref (or default branch) on the remote. */
  async latest(spec: GitSpec, context: FetchContext = this.context('user')): Promise<string> {
    if (spec.sha !== undefined) {
      if (!isFullSha(spec.sha)) throw new HarnessError('unsupported-source', `not a full commit SHA: ${spec.sha}`)
      return spec.sha
    }
    if (spec.ref !== undefined && !isValidRef(spec.ref)) throw new HarnessError('unsupported-source', `not a branch or tag name git accepts: ${spec.ref}`)
    const git = await this.gitFor(spec.url, context)
    if (git.use) {
      const { options, url, env } = await this.gitOptions(spec.url, context)
      let out: string
      try {
        out = await this.runGit(options, ['ls-remote', '--', url, ...(spec.ref !== undefined ? [spec.ref, `refs/tags/${spec.ref}^{}`] : ['HEAD'])], context, { stepMs: this.limits.lookupMs, what: `reading ${shown(spec.url)}`, env })
      } catch (error: unknown) {
        if (error instanceof HarnessError) throw error
        throw new HarnessError('fetch-failed', `cannot read ${shown(spec.url)}: ${scrub(messageOf(error))}`, { cause: error, suggestion: 'Check the URL, that the repository is public, and the network connection.' })
      }
      const lines = out.split(/\r?\n/u).map(line => line.split(/\s+/u)).filter(([sha]) => sha !== undefined && isFullSha(sha))
      // An annotated tag's commit is its peeled line.
      const found = lines.find(([, ref]) => ref?.endsWith('^{}') === true) ?? lines[0]
      if (found?.[0] === undefined) throw new HarnessError('fetch-failed', `${shown(spec.url)} has no ${spec.ref ?? 'default branch'}`)
      return found[0]
    }
    if (spec.github !== undefined) {
      const text = (await this.download(githubCommitApi(spec.github.owner, spec.github.repo, spec.ref), 4096, this.limits.lookupMs, context, { accept: 'application/vnd.github.sha' })).toString('utf8').trim()
      if (!isFullSha(text)) throw new HarnessError('fetch-failed', `GitHub did not name the commit of ${spec.github.owner}/${spec.github.repo}${spec.ref !== undefined ? `#${spec.ref}` : ''}`)
      return text
    }
    throw this.gitRequired(spec, git.why)
  }

  private gitRequired(spec: GitSpec, why = 'git is not installed'): HarnessError {
    return why === 'git is not installed'
      ? new HarnessError('fetch-failed', `git is needed to fetch ${shown(spec.url)}`, { suggestion: 'Install git (https://git-scm.com/downloads); without it Harness Forge can fetch from GitHub only.' })
      : new HarnessError('fetch-failed', `Harness Forge does not fetch ${shown(spec.url)} for a marketplace: ${why}`, { suggestion: why.startsWith('behind a proxy') ? `If you trust it, paste ${shown(spec.url)} yourself.` : 'Update git to 2.37 or later, or paste the repository yourself.' })
  }

  /** Where checkouts of one source (URL and directory) are kept. */
  cacheDir(spec: GitSpec): string {
    return join(this.root, 'cache', 'git', cacheKey(spec.url, spec.subpath ?? ''))
  }

  /**
   * Check out a git source at `sha` (else at what it points at now) under the
   * cache, reusing a checkout of that commit. A checkout is never replaced:
   * one is made in a directory of its own and renamed into place; old ones are
   * collected by the service between operations.
   */
  async checkout(spec: GitSpec, context: FetchContext = this.context('user'), sha?: string): Promise<Checkout> {
    const wanted = sha ?? spec.sha
    if (wanted !== undefined && !isFullSha(wanted)) throw new HarnessError('unsupported-source', `not a full commit SHA: ${wanted}`)
    if (spec.ref !== undefined && !isValidRef(spec.ref)) throw new HarnessError('unsupported-source', `not a branch or tag name git accepts: ${spec.ref}`)
    const keyDir = this.cacheDir(spec)
    if (wanted !== undefined && existsSync(join(keyDir, wanted))) return { dir: join(keyDir, wanted), sha: wanted }
    const git = await this.gitFor(spec.url, context)
    if (!git.use && spec.github === undefined) throw this.gitRequired(spec, git.why)
    const tmp = temporary(keyDir)
    try {
      const resolved = git.use ? await this.gitCheckout(spec, wanted, tmp, context) : await this.tarballCheckout(spec, wanted, tmp, context)
      if (treeSize(tmp, this.limits.tree).over) throw tooLargeError(spec.url, this.limits.tree)
      const dir = join(keyDir, resolved)
      if (existsSync(dir)) rmSync(tmp, { recursive: true, force: true })
      else renameSync(tmp, dir)
      return { dir, sha: resolved }
    } catch (error: unknown) {
      rmSync(tmp, { recursive: true, force: true })
      throw error
    }
  }

  /** Fetch one commit (depth 1, no blobs but those checked out, only the plugin's directory) into an empty repository. */
  private async gitCheckout(spec: GitSpec, sha: string | undefined, dir: string, context: FetchContext): Promise<string> {
    const { options, url, env } = await this.gitOptions(spec.url, context)
    const what = `fetching ${shown(spec.url)}`
    const git = (args: readonly string[], stepMs?: number): Promise<string> => this.runGit(options, args, context, { cwd: dir, watch: dir, what, env, ...(stepMs !== undefined ? { stepMs } : {}) })
    mkdirSync(dir, { recursive: true })
    try {
      await git(['init', '--quiet', `--template=${this.isolation().template}`], this.limits.lookupMs)
      await git(['remote', 'add', '--', 'origin', url], this.limits.lookupMs)
      if (spec.subpath !== undefined) await git(['sparse-checkout', 'set', '--', spec.subpath], this.limits.lookupMs)
      const target = sha ?? spec.ref ?? 'HEAD'
      try {
        await git(['fetch', '--quiet', '--depth=1', '--filter=blob:none', '--no-tags', '--', 'origin', target])
      } catch (error: unknown) {
        if (error instanceof HarnessError || sha === undefined) throw error
        // Claude Code names AWS CodeCommit as a server that does not serve a commit by SHA; fetching its whole history instead is unbounded.
        throw new HarnessError('fetch-failed', `${shown(spec.url)} does not serve commit ${sha.slice(0, 12)} on its own: ${scrub(messageOf(error))}`, { cause: error, suggestion: 'The server must allow fetching a commit by its SHA (GitHub, GitLab and Bitbucket do); Harness Forge does not download a whole history to find it.' })
      }
      const head = (await git(['rev-parse', '--verify', '--end-of-options', 'FETCH_HEAD^{commit}'], this.limits.lookupMs)).trim()
      if (!isFullSha(head)) throw new HarnessError('fetch-failed', `git did not name the commit fetched from ${shown(spec.url)}`)
      if (sha !== undefined && head !== sha) throw new HarnessError('fetch-failed', `${shown(spec.url)} answered commit ${head.slice(0, 12)} for ${sha.slice(0, 12)}`)
      await git(['checkout', '--quiet', '--detach', head])
      rmSync(join(dir, '.git'), { recursive: true, force: true })
      return head
    } catch (error: unknown) {
      if (error instanceof HarnessError) throw error
      throw new HarnessError('fetch-failed', `git could not fetch ${shown(spec.url)}${spec.ref !== undefined ? ` (${spec.ref})` : ''}: ${scrub(messageOf(error))}`, { cause: error, suggestion: 'Check the URL and ref, that the repository is public, and the network connection.' })
    }
  }

  private async tarballCheckout(spec: GitSpec, sha: string | undefined, dir: string, context: FetchContext): Promise<string> {
    const { owner, repo } = spec.github!
    const archive = await this.download(githubTarball(owner, repo, sha ?? spec.ref ?? 'HEAD'), this.limits.archiveBytes, this.limits.fetchMs, context)
    const { commit } = await extractTarGz(archive, dir, { strip: 1, limits: this.limits.tree, signal: context.signal })
    if (sha !== undefined && commit !== undefined && commit !== sha) throw new HarnessError('fetch-failed', `the GitHub archive of ${owner}/${repo} is commit ${commit.slice(0, 12)}, not ${sha.slice(0, 12)}`)
    const resolved = commit ?? sha
    if (resolved === undefined) throw new HarnessError('fetch-failed', `the GitHub archive of ${owner}/${repo} does not name its commit`)
    return resolved
  }

  // --- npm ------------------------------------------------------------------

  /**
   * The registry npm is configured with, read without running npm:
   * `npm_config_registry`, else the `registry=` line of the user's `.npmrc`,
   * else npm's own. Per-scope registries and auth are not read.
   */
  configuredRegistry(): string {
    const fromEnv = process.env['npm_config_registry'] ?? process.env['NPM_CONFIG_REGISTRY']
    if (fromEnv !== undefined && normalizeRegistry(fromEnv) !== undefined) return normalizeRegistry(fromEnv)!
    try {
      const npmrc = readFileSync(process.env['npm_config_userconfig'] ?? join(homedir(), '.npmrc'), 'utf8')
      const line = /^[ \t]*registry[ \t]*=[ \t]*(\S+)[ \t]*\r?$/mu.exec(npmrc)?.[1]
      if (line !== undefined && !line.includes('${') && normalizeRegistry(line) !== undefined) return normalizeRegistry(line)!
    } catch {
      // No .npmrc.
    }
    return NPM_REGISTRY
  }

  /** The registry an npm source is fetched from: the configured one, or one a marketplace names when it is npm's own or the configured one. */
  registryOf(spec: NpmSpec): string {
    const configured = this.configuredRegistry()
    if (spec.registry === undefined) return configured
    const named = normalizeRegistry(spec.registry)
    if (named !== undefined && (named === NPM_REGISTRY || named === configured)) return named
    throw new HarnessError('unsupported-source', `the marketplace names the npm registry ${spec.registry}; Harness Forge fetches only from npm's own registry or the one npm is configured with (${configured})`)
  }

  /**
   * The exact version an npm source names now (an exact version, or a
   * dist-tag such as `latest`; not a range), with its tarball and integrity,
   * read from the registry's document by Harness Forge itself.
   */
  async npmLatest(spec: NpmSpec, context: FetchContext = this.context('user')): Promise<NpmVersion> {
    const wanted = spec.version ?? 'latest'
    if (!EXACT_VERSION.test(wanted) && !DIST_TAG.test(wanted)) throw new HarnessError('unsupported-source', `Harness Forge installs an exact npm version or a tag such as latest, not a range: ${spec.package}@${wanted}`, { suggestion: `Name an exact version, such as ${spec.package}@1.2.3.` })
    const registry = this.registryOf(spec)
    // The registry is the person's choice (or npm's own); what it redirects to is checked.
    const registryContext = RemoteFetcher.as(context, 'user')
    const document = await this.json(`${registry}${spec.package.replace('/', '%2f')}`, registryContext, PACKUMENT_BYTES, 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8')
    const tags = isRecord(document['dist-tags']) ? document['dist-tags'] : {}
    const version = EXACT_VERSION.test(wanted) ? wanted : tags[wanted]
    const entry = typeof version === 'string' && isRecord(document['versions']) ? document['versions'][version] : undefined
    if (typeof version !== 'string' || !EXACT_VERSION.test(version) || !isRecord(entry)) throw new HarnessError('fetch-failed', `${registry} has no version of ${spec.package} matching ${wanted}`)
    const dist = isRecord(entry['dist']) ? entry['dist'] : {}
    const tarball = typeof dist['tarball'] === 'string' ? dist['tarball'] : ''
    const integrity = typeof dist['integrity'] === 'string' ? dist['integrity'] : ''
    if (entry['name'] !== spec.package || entry['version'] !== version) throw new HarnessError('manifest-invalid', `${registry} describes ${spec.package}@${version} as another package`)
    let origin: string | undefined
    try {
      origin = new URL(tarball).origin
    } catch {
      origin = undefined
    }
    if (origin !== new URL(registry).origin) throw new HarnessError('fetch-failed', `the tarball of ${spec.package}@${version} is not on ${registry}: ${shown(tarball)}`)
    if (!SHA512.test(integrity)) throw new HarnessError('fetch-failed', `${registry} gives no sha512 integrity for ${spec.package}@${version}`)
    return { name: spec.package, version, integrity, registry, tarball }
  }

  /**
   * Download one package version's tarball (nothing else), check it against
   * its integrity, and unpack it to `<dest>/package`. npm does not run.
   * @returns the package directory and its `package.json`.
   */
  async npmFetch(pkg: NpmVersion, dest: string, context: FetchContext): Promise<{ dir: string; manifest: Record<string, unknown> }> {
    const bytes = await this.download(pkg.tarball, this.limits.archiveBytes, this.limits.fetchMs, RemoteFetcher.as(context, 'user'))
    if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== pkg.integrity) throw new HarnessError('fetch-failed', `${pkg.name}@${pkg.version} does not match the integrity its registry gives`)
    const dir = join(dest, 'package')
    await extractTarGz(bytes, dir, { strip: 1, limits: PLUGIN_LIMITS, signal: context.signal })
    let manifest: unknown
    try {
      manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    } catch {
      manifest = undefined
    }
    if (!isRecord(manifest)) throw new HarnessError('manifest-invalid', `${pkg.name}@${pkg.version} has no package.json`)
    if (manifest['name'] !== pkg.name || manifest['version'] !== pkg.version) throw new HarnessError('manifest-invalid', `the tarball of ${pkg.name}@${pkg.version} is ${String(manifest['name'])}@${String(manifest['version'])}`)
    return { dir, manifest }
  }

  /**
   * Install a confirmed package's dependencies into `prefix` (its own
   * `package.json` naming only them). The person confirmed the plugin, so its
   * registry dependencies are trusted, as OpenCode installs plugins; still,
   * install scripts do not run, npm's cache is inside `prefix` (in the size
   * bound), and the resolved tree is refused when any package in it is not a
   * tarball from the registry with an integrity.
   */
  async npmDependencies(prefix: string, dependencies: NpmDependencies, registry: string, context: FetchContext): Promise<void> {
    writeJson(join(prefix, 'package.json'), { name: 'harness-forge-remote', private: true, dependencies: dependencies.dependencies, optionalDependencies: dependencies.optionalDependencies })
    if (Object.keys(dependencies.dependencies).length + Object.keys(dependencies.optionalDependencies).length === 0) return
    const cache = join(prefix, '.npm-cache')
    // The lockfile version is forced, so a person's npmrc cannot pick one the audit cannot read.
    const args = ['--ignore-scripts', '--no-audit', '--no-fund', `--lockfile-version=${String(NPM_LOCKFILE_VERSION)}`, `--registry=${registry}`, `--cache=${cache}`]
    const step = { cwd: prefix, watch: prefix, stepMs: this.limits.fetchMs, what: 'installing the dependencies' }
    try {
      await this.run(this.deps.npm, 'npm', ['install', '--package-lock-only', ...args], context, step)
      refuseForeignPackages(JSON.parse(readFileSync(join(prefix, 'package-lock.json'), 'utf8')) as Lockfile, registry)
      await this.run(this.deps.npm, 'npm', ['ci', '--omit=dev', ...args], context, step)
    } catch (error: unknown) {
      throw error instanceof HarnessError ? error : npmError('the dependencies', error)
    } finally {
      rmSync(cache, { recursive: true, force: true })
    }
  }

  // --- archives ---------------------------------------------------------------

  /** Download and unpack a zip `archive` source into `dest`; its sha256 is the revision. */
  async archive(spec: ArchiveSpec, dest: string, context: FetchContext): Promise<{ root: string; digest: string }> {
    const bytes = await this.download(spec.url, this.limits.archiveBytes, this.limits.fetchMs, context)
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (spec.sha256 !== undefined && spec.sha256 !== digest) throw new HarnessError('fetch-failed', `${shown(spec.url)} does not match its sha256 pin (got ${digest})`)
    await extractZip(bytes, dest, { signal: context.signal })
    return { root: zipRoot(dest), digest }
  }

  /** A directory inside `root`, or a failure naming the path that leaves it. */
  static inside(root: string, path: string | undefined): string {
    const target = path === undefined ? resolve(root) : resolve(root, path)
    if (target !== resolve(root) && !isInside(root, target)) throw new HarnessError('path-escape', `the plugin path leaves its repository: ${path ?? ''}`)
    if (!existsSync(target)) throw new HarnessError('manifest-not-found', `the repository has no ${path ?? ''} directory`)
    // Reached through no link: its real path is where its path says.
    if (!lstatSync(target).isDirectory() || relative(realpathSync(root), realpathSync(target)) !== relative(resolve(root), target)) throw new HarnessError('path-escape', `the plugin path is a link or reached through one: ${path ?? '.'}`)
    refuseLinkedManifests(target)
    return target
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The lockfile version npm is told to write: 3, the default of npm 7 and
 * later, holds only the `packages` map the audit reads (version 1 has none,
 * so an audit of it would see nothing).
 */
export const NPM_LOCKFILE_VERSION = 3
/** Lockfile versions with a `packages` map (2 carries it beside version 1's data). */
const AUDITED_LOCKFILE_VERSIONS: readonly unknown[] = [2, 3]

interface Lockfile {
  readonly lockfileVersion?: unknown
  readonly packages?: Readonly<Record<string, { readonly resolved?: unknown; readonly integrity?: unknown; readonly link?: unknown; readonly inBundle?: unknown }>>
}

/**
 * Refuse a resolved dependency tree with any package that is not a registry
 * tarball: a link (`file:`, `link:`, `workspace:`), a git or URL source, a
 * tarball on another origin, or one without an integrity. Bundled packages
 * come inside a registry tarball; `npm:` aliases resolve to registry tarballs
 * like any other.
 */
export function refuseForeignPackages(lock: Lockfile, registry: string): void {
  const origin = new URL(registry).origin
  // Fail closed: a lockfile the audit cannot read is not a tree with nothing in it.
  if (!AUDITED_LOCKFILE_VERSIONS.includes(lock.lockfileVersion) || !isRecord(lock.packages)) {
    throw new HarnessError('unsupported-source', `npm wrote a lockfile Harness Forge cannot check (lockfileVersion ${JSON.stringify(lock.lockfileVersion ?? null)}${isRecord(lock.packages) ? '' : ', no packages map'}), so the dependencies are not installed`, { suggestion: `Use npm 7 or later; Harness Forge asks it for lockfile version ${String(NPM_LOCKFILE_VERSION)}.` })
  }
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === '' || entry.inBundle === true) continue
    const name = path.replace(/^.*node_modules\//u, '')
    const resolved = typeof entry.resolved === 'string' ? entry.resolved : undefined
    let url: URL | undefined
    try {
      url = resolved === undefined ? undefined : new URL(resolved)
    } catch {
      url = undefined
    }
    const fromRegistry = entry.link !== true && url !== undefined && (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === origin && url.pathname.endsWith('.tgz')
    const pinned = typeof entry.integrity === 'string' && /^sha(?:512|1)-/u.test(entry.integrity)
    if (!fromRegistry || !pinned) {
      throw new HarnessError('unsupported-source', `the dependency ${name} would come from ${resolved ?? 'a local folder'}${fromRegistry ? ' without an integrity' : `, not from ${registry}`}; Harness Forge installs dependencies from the registry only`, { suggestion: 'Ask the plugin\'s author to publish that dependency to npm.' })
    }
  }
}

/** A package's dependencies to install, each a registry lookup. */
export interface NpmDependencies {
  readonly dependencies: Readonly<Record<string, string>>
  readonly optionalDependencies: Readonly<Record<string, string>>
}

/**
 * What a package declares to install with it, refused when any of it is not
 * a registry lookup (git, GitHub, `file:`, `link:`, `workspace:`, a URL).
 */
export function dependenciesOf(manifest: Readonly<Record<string, unknown>>): NpmDependencies {
  const read = (key: string): Record<string, string> => {
    const value = manifest[key]
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  }
  const dependencies = read('dependencies')
  const optionalDependencies = read('optionalDependencies')
  const problems = [...Object.entries(dependencies), ...Object.entries(optionalDependencies)].flatMap(([name, spec]) => {
    const problem = dependencyProblem(name, spec)
    return problem === undefined ? [] : [problem]
  })
  if (problems.length > 0) throw new HarnessError('unsupported-source', `${String(manifest['name'])} cannot be installed: ${problems.join('; ')}`, { suggestion: 'Ask the plugin\'s author to depend on published npm packages only.' })
  return { dependencies, optionalDependencies }
}

function npmError(name: string, error: unknown): HarnessError {
  if ((error as { code?: unknown }).code === 'ENOENT') return new HarnessError('fetch-failed', 'npm is needed to install npm packages', { suggestion: 'Install Node.js with npm (https://nodejs.org).' })
  return new HarnessError('fetch-failed', `npm could not fetch ${name}: ${messageOf(error)}`, { cause: error, suggestion: 'Check the package name and the network connection.' })
}
