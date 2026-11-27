/**
 * Behind a proxy the proxy resolves hosts, so Harness Forge pins nothing and
 * reaches only GitHub, npm and the hosts the person pasted, through it.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect, createServer as createTcpServer, type AddressInfo, type Server as TcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { httpClient, proxyFor, RemoteFetcher, SYSTEM_DEPS, type FetchDeps } from '../src/forge/remote/fetch.js'

const KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'] as const
const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]))
function setEnv(values: Partial<Record<(typeof KEYS)[number], string>>): void {
  for (const key of KEYS) delete process.env[key]
  Object.assign(process.env, values)
}

const roots: string[] = []
afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  seen.length = 0
  auth.length = 0
  lookups.length = 0
})

/** The origin the proxy reaches for every host: a marketplace, and a redirect off the allowlist. */
let origin: Server
/** A proxy that forwards http requests to the origin and answers CONNECT, then hangs up. */
let proxy: Server
let proxyUrl = ''
let originPort = 0
const seen: string[] = []
const auth: Array<string | undefined> = []
const lookups: string[] = []

beforeAll(async () => {
  origin = createServer((request, response) => {
    if (request.url === '/moved') {
      response.writeHead(302, { location: 'http://other.test/marketplace.json' })
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"name":"through-the-proxy"}')
  })
  await new Promise<void>((resolve) => { origin.listen(0, '127.0.0.1', resolve) })
  originPort = (origin.address() as AddressInfo).port
  proxy = createServer((request, response) => {
    seen.push(`GET ${request.url ?? ''}`)
    auth.push(request.headers['proxy-authorization'])
    const target = new URL(request.url ?? '')
    const upstream = httpRequest({ host: '127.0.0.1', port: originPort, path: target.pathname, headers: { host: target.host } }, (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(response)
    })
    upstream.end()
  })
  proxy.on('connect', (request, socket) => {
    socket.on('error', () => undefined)
    seen.push(`CONNECT ${request.url ?? ''}`)
    // The tunnel is opened, then closed: what matters is that it was asked for, by name.
    socket.end('HTTP/1.1 200 Connection Established\r\n\r\n')
  })
  await new Promise<void>((resolve) => { proxy.listen(0, '127.0.0.1', resolve) })
  proxyUrl = `http://127.0.0.1:${String((proxy.address() as AddressInfo).port)}`
})
afterAll(() => {
  // Tunnels are not the servers' to close: they are dropped with the process.
  for (const server of [origin, proxy]) {
    server.closeAllConnections()
    server.close()
    server.unref()
  }
})

/** A fetcher whose own resolver records every name asked: behind a proxy it must ask none. */
function fetcher(): RemoteFetcher {
  const root = mkdtempSync(join(tmpdir(), 'harness-forge-proxy-'))
  roots.push(root)
  const lookup: FetchDeps['lookup'] = async (host) => { lookups.push(host); return ['93.184.216.34'] }
  return new RemoteFetcher(root, { ...SYSTEM_DEPS, lookup })
}

describe('behind a proxy', () => {
  it('tunnels to an allowed host by name, resolving nothing itself', async () => {
    setEnv({ HTTPS_PROXY: proxyUrl })
    const forge = fetcher()
    await expect(forge.download('https://registry.npmjs.org/left-pad', 1024, 5_000, forge.context('marketplace'))).rejects.toThrow()
    await expect(forge.download('https://codeload.github.com/a/b/tar.gz/HEAD', 1024, 5_000, forge.context('marketplace'))).rejects.toThrow()
    expect(seen).toEqual(['CONNECT registry.npmjs.org:443', 'CONNECT codeload.github.com:443'])
    expect(lookups).toEqual([])
  })

  it('refuses a host a marketplace names that is not on the allowlist, without asking the proxy', async () => {
    setEnv({ HTTPS_PROXY: proxyUrl })
    const forge = fetcher()
    await expect(forge.download('https://cdn.example/plugin.zip', 1024, 5_000, forge.context('marketplace', ['cdn.example']))).rejects.toThrow(/behind a proxy, Harness Forge reaches only GitHub, npm's registry, your npm registry and the sources you paste, not cdn\.example/u)
    await expect(forge.download('https://10.0.0.5/plugin.zip', 1024, 5_000, forge.context('marketplace'))).rejects.toThrow(/not 10\.0\.0\.5/u)
    expect(seen).toEqual([])
  })

  it('reaches the host the person pasted, with the proxy\'s credentials, and no redirect off the allowlist', async () => {
    setEnv({ HTTP_PROXY: proxyUrl.replace('http://', 'http://me:secret@') })
    const forge = fetcher()
    expect(await forge.json('http://pasted.test/marketplace.json', forge.context('user', ['pasted.test']))).toEqual({ name: 'through-the-proxy' })
    expect(auth).toEqual([`Basic ${Buffer.from('me:secret').toString('base64')}`])
    await expect(forge.json('http://pasted.test/moved', forge.context('user', ['pasted.test']))).rejects.toThrow(/not other\.test/u)
    await expect(forge.json('http://unpasted.test/marketplace.json', forge.context('user', ['pasted.test']))).rejects.toThrow(/not unpasted\.test/u)
    expect(seen).toEqual(['GET http://pasted.test/marketplace.json', 'GET http://pasted.test/moved'])
    expect(lookups).toEqual([])
  })

  it('connects directly, with its own checks, to what NO_PROXY exempts', async () => {
    setEnv({ HTTP_PROXY: proxyUrl, NO_PROXY: 'localhost,127.0.0.1' })
    const forge = fetcher()
    expect(await forge.json(`http://127.0.0.1:${String(originPort)}/marketplace.json`, forge.context('user'))).toEqual({ name: 'through-the-proxy' })
    expect(seen).toEqual([])
  })

  it('reads the proxy variables as git and npm do', () => {
    setEnv({ HTTPS_PROXY: 'proxy.example:3128', NO_PROXY: '.internal.example,github.com:8443' })
    expect(proxyFor(new URL('https://github.com/a'))?.href).toBe('http://proxy.example:3128/')
    expect(proxyFor(new URL('https://x.internal.example/a'))).toBeUndefined()
    expect(proxyFor(new URL('https://github.com:8443/a'))).toBeUndefined()
    expect(proxyFor(new URL('http://github.com/a'))).toBeUndefined()
    setEnv({ ALL_PROXY: 'http://all.example:8080', NO_PROXY: '*' })
    expect(proxyFor(new URL('https://github.com/a'))).toBeUndefined()
    setEnv({ ALL_PROXY: 'socks5://127.0.0.1:1080' })
    expect(() => proxyFor(new URL('https://github.com/a'))).toThrow(/http:\/\/ and https:\/\/ proxies/u)
  })
})

/** A test CA and a certificate for secure.test and 127.0.0.1, made with openssl. */
function certificates(dir: string): { ca: string; key: string; cert: string } {
  const run = (...args: string[]): void => { execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' }) }
  run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '2', '-subj', '/CN=harness-forge-test-ca')
  run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=secure.test')
  writeFileSync(join(dir, 'ext'), 'subjectAltName=DNS:secure.test,IP:127.0.0.1\n')
  run('x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.crt', '-days', '2', '-extfile', 'ext')
  return { ca: readFileSync(join(dir, 'ca.crt'), 'utf8'), key: readFileSync(join(dir, 'leaf.key'), 'utf8'), cert: readFileSync(join(dir, 'leaf.crt'), 'utf8') }
}

describe('through a CONNECT tunnel', { timeout: 60_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-forge-tls-'))
  let tls: ReturnType<typeof certificates>
  let secure: ReturnType<typeof createHttpsServer>
  let tunnels: TcpServer
  let tunnelUrl = ''
  const asked: string[] = []
  const open: Array<import('node:stream').Duplex> = []
  let connections = 0
  beforeAll(async () => {
    tls = certificates(dir)
    secure = createHttpsServer({ key: tls.key, cert: tls.cert }, (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"name":"tunnelled"}')
    })
    secure.on('connection', () => { connections += 1 })
    await new Promise<void>((resolve) => { secure.listen(0, '127.0.0.1', resolve) })
    const securePort = (secure.address() as AddressInfo).port
    // The target is reachable only through this proxy: every name it is asked for leads to the server.
    const proxyServer = createServer()
    proxyServer.on('connect', (request, client, head) => {
      open.push(client)
      asked.push(request.url ?? '')
      const upstream = connect(securePort, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        upstream.write(head)
        upstream.pipe(client)
        client.pipe(upstream)
      })
      upstream.on('error', () => { client.destroy() })
      client.on('error', () => { upstream.destroy() })
    })
    tunnels = proxyServer as unknown as TcpServer
    await new Promise<void>((resolve) => { proxyServer.listen(0, '127.0.0.1', resolve) })
    tunnelUrl = `http://127.0.0.1:${String((proxyServer.address() as AddressInfo).port)}`
  })
  afterAll(() => {
    for (const socket of open) socket.destroy()
    secure.closeAllConnections()
    for (const server of [secure, tunnels]) {
      server.close()
      server.unref()
    }
    rmSync(dir, { recursive: true, force: true })
  })

  function tunnelled(): RemoteFetcher {
    const root = mkdtempSync(join(tmpdir(), 'harness-forge-proxy-'))
    roots.push(root)
    const lookup: FetchDeps['lookup'] = async (host) => { lookups.push(host); throw new Error(`no direct lookup of ${host}`) }
    return new RemoteFetcher(root, { ...SYSTEM_DEPS, fetch: httpClient({ ca: tls.ca }), lookup })
  }

  it('gets the answer through the tunnel, with no direct connection', async () => {
    setEnv({ https_proxy: tunnelUrl })
    const forge = tunnelled()
    const before = connections
    asked.length = 0
    expect(await forge.json('https://secure.test/marketplace.json', forge.context('user', ['secure.test']))).toEqual({ name: 'tunnelled' })
    expect(asked).toEqual(['secure.test:443'])
    // secure.test resolves nowhere: the one connection the server saw is the tunnel's.
    expect(connections - before).toBe(1)
    expect(lookups).toEqual([])
  })

  it('checks the certificate against the target\'s name through the tunnel', async () => {
    setEnv({ https_proxy: tunnelUrl })
    const forge = tunnelled()
    await expect(forge.json('https://wrong.test/marketplace.json', forge.context('user', ['wrong.test']))).rejects.toThrow(/wrong\.test|altnames|certificate/iu)
  })

  it('checks the certificate of an IP address target, which gets no SNI', async () => {
    setEnv({ https_proxy: tunnelUrl })
    const forge = tunnelled()
    expect(await forge.json('https://127.0.0.1/marketplace.json', forge.context('user', ['127.0.0.1']))).toEqual({ name: 'tunnelled' })
    await expect(forge.json('https://127.0.0.2/marketplace.json', forge.context('user', ['127.0.0.2']))).rejects.toThrow(/127\.0\.0\.2|altnames|certificate/iu)
  })
})

describe('a server that does not speak HTTP properly', () => {
  it('rejects a status outside 200-599 instead of crashing', async () => {
    const sockets: Array<import('node:net').Socket> = []
    const raw = createTcpServer((socket) => { sockets.push(socket); socket.end('HTTP/1.1 600 Nope\r\nContent-Length: 0\r\n\r\n') })
    await new Promise<void>((resolve) => { raw.listen(0, '127.0.0.1', resolve) })
    try {
      setEnv({})
      const forge = fetcher()
      await expect(forge.download(`http://127.0.0.1:${String((raw.address() as AddressInfo).port)}/`, 1024, 5_000, forge.context('user'))).rejects.toThrow(/status 600/u)
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => { raw.close(() => { resolve() }) })
    }
  })
})

describe('a proxy that opens the tunnel and then says nothing', () => {
  let stalling: Server
  let stallingUrl = ''
  const sockets: Array<import('node:stream').Duplex> = []
  /** Tunnels whose client end has gone: the client closed its side. */
  const ended = new Set<import('node:stream').Duplex>()
  beforeAll(async () => {
    stalling = createServer()
    stalling.on('connect', (_request, socket) => {
      sockets.push(socket)
      socket.on('error', () => { ended.add(socket) })
      socket.on('end', () => { ended.add(socket) })
      socket.on('close', () => { ended.add(socket) })
      // What the client sends is read and dropped (so its end is seen); no TLS ever comes back.
      socket.resume()
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    })
    await new Promise<void>((resolve) => { stalling.listen(0, '127.0.0.1', resolve) })
    stallingUrl = `http://127.0.0.1:${String((stalling.address() as AddressInfo).port)}`
  })
  afterAll(() => {
    for (const socket of sockets) socket.destroy()
    stalling.close()
    stalling.unref()
  })

  /** Whether every tunnel's client end is gone within a second. */
  const allClosed = async (): Promise<boolean> => {
    for (let waited = 0; waited < 1_000; waited += 50) {
      if (sockets.length > 0 && sockets.every(socket => ended.has(socket))) return true
      await new Promise((resolve) => { setTimeout(resolve, 50) })
    }
    return false
  }

  it('gives up on the TLS handshake at the operation\'s deadline and closes the tunnel', async () => {
    setEnv({ https_proxy: stallingUrl })
    const forge = fetcher()
    const started = Date.now()
    await expect(forge.download('https://registry.npmjs.org/left-pad', 1024, 300, forge.context('user'))).rejects.toThrow(/timed out/u)
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(await allClosed()).toBe(true)
  })

  it('gives up on the TLS handshake when the operation is cancelled', async () => {
    setEnv({ https_proxy: stallingUrl })
    const forge = fetcher()
    const controller = new AbortController()
    const context = { ...forge.context('user'), signal: controller.signal }
    setTimeout(() => { controller.abort(new Error('cancelled by the person')) }, 150)
    await expect(forge.download('https://registry.npmjs.org/left-pad', 1024, 60_000, context)).rejects.toThrow(/cancelled|timed out/u)
    expect(await allClosed()).toBe(true)
  })
})
