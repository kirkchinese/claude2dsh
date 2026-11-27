/**
 * OAuth for remote MCP servers, as Claude Code's `/mcp` sign-in does it: the
 * MCP SDK discovers the authorization server, registers this client
 * dynamically and runs PKCE; this module supplies the persistent store, the
 * loopback redirect listener and the browser hand-off.
 * @module @kirkchinese/harness-forge
 */
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { OAuthClientProvider } from '@modelcontextprotocol/client'

type Stored<K extends 'clientInformation' | 'tokens' | 'discoveryState'> = Awaited<ReturnType<NonNullable<OAuthClientProvider[K]>>>

/** What is persisted per server URL. */
interface AuthRecord {
  client?: Stored<'clientInformation'>
  tokens?: Stored<'tokens'>
  discovery?: Stored<'discoveryState'>
  verifier?: string
  state?: string
  redirectPort?: number
}

const CALLBACK_PATH = '/callback'
const SIGN_IN_TIMEOUT_MS = 5 * 60_000

/** Persistent OAuth state for remote MCP servers in one profile. */
export class McpAuthStore {
  private listener: { server: Server; port: number } | undefined
  private readonly waiting = new Map<string, (params: URLSearchParams) => void>()

  /**
   * @param root - directory for per-server records.
   * @param open - shows the sign-in page to the user; defaults to the system browser.
   */
  constructor(private readonly root: string, private readonly open: (url: string) => void | Promise<void> = openBrowser) {}

  /** The SDK provider for one server URL. `onAuthorizationUrl` receives the sign-in URL. */
  provider(serverUrl: string, onAuthorizationUrl: (url: URL) => void): OAuthClientProvider {
    const key = shortKey(serverUrl)
    const redirect = (): string | undefined => {
      const port = this.read(key).redirectPort
      return port === undefined ? undefined : `http://127.0.0.1:${port}${CALLBACK_PATH}`
    }
    return {
      get redirectUrl() { return redirect() },
      get clientMetadata() {
        const uri = redirect()
        return {
          client_name: 'DeepSeek Harness (Harness Forge)',
          redirect_uris: uri === undefined ? [] : [uri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }
      },
      state: () => {
        const state = randomBytes(16).toString('hex')
        this.update(key, { state })
        return state
      },
      clientInformation: () => this.read(key).client,
      saveClientInformation: (client) => { this.update(key, { client }) },
      tokens: () => this.read(key).tokens,
      saveTokens: (tokens) => { this.update(key, { tokens }) },
      saveCodeVerifier: (verifier) => { this.update(key, { verifier }) },
      codeVerifier: () => this.read(key).verifier ?? '',
      saveDiscoveryState: (discovery) => { this.update(key, { discovery }) },
      discoveryState: () => this.read(key).discovery,
      invalidateCredentials: (scope) => {
        const record = this.read(key)
        if (scope === 'all' || scope === 'client') delete record.client
        if (scope === 'all' || scope === 'tokens') delete record.tokens
        if (scope === 'all' || scope === 'verifier') delete record.verifier
        if (scope === 'all' || scope === 'discovery') delete record.discovery
        this.write(key, record)
      },
      redirectToAuthorization: (url) => { onAuthorizationUrl(url) },
    }
  }

  /**
   * Make sure the loopback listener runs and the server's redirect URI names
   * it. A changed port drops the old client registration, whose redirect URI
   * no longer matches.
   */
  async prepare(serverUrl: string): Promise<void> {
    const key = shortKey(serverUrl)
    const record = this.read(key)
    const port = await this.listen(record.redirectPort)
    if (port !== record.redirectPort) {
      delete record.client
      this.write(key, { ...record, redirectPort: port })
    }
  }

  /**
   * Show the sign-in page and wait for the redirect back.
   * @returns the callback parameters (`code`, `iss`, …) for `finishAuth`.
   */
  async signIn(serverUrl: string, authorizationUrl: URL): Promise<URLSearchParams> {
    const expected = this.read(shortKey(serverUrl)).state ?? authorizationUrl.searchParams.get('state') ?? ''
    const params = new Promise<URLSearchParams>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(expected)
        reject(new Error('sign-in was not completed within 5 minutes'))
      }, SIGN_IN_TIMEOUT_MS)
      timer.unref?.()
      this.waiting.set(expected, (value) => {
        clearTimeout(timer)
        resolve(value)
      })
    })
    await this.open(authorizationUrl.href)
    return params
  }

  /** Stop the loopback listener. */
  close(): void {
    this.listener?.server.close()
    this.listener = undefined
  }

  private async listen(preferred: number | undefined): Promise<number> {
    if (this.listener !== undefined) return this.listener.port
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== CALLBACK_PATH) {
        response.writeHead(404).end()
        return
      }
      const resolve = this.waiting.get(url.searchParams.get('state') ?? '')
      if (resolve === undefined || !url.searchParams.has('code')) {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('This sign-in link is not the one DSH is waiting for. Start the sign-in again from DSH.')
        return
      }
      this.waiting.delete(url.searchParams.get('state') ?? '')
      resolve(url.searchParams)
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<p>Signed in. You can close this tab and return to DSH.</p>')
    })
    const port = await new Promise<number>((resolve, reject) => {
      const bind = (candidate: number): void => {
        server.once('error', (error: NodeJS.ErrnoException) => {
          if (candidate !== 0 && error.code === 'EADDRINUSE') bind(0)
          else reject(error)
        })
        server.listen(candidate, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
      }
      bind(preferred ?? 0)
    })
    server.unref()
    this.listener = { server, port }
    return port
  }

  private file(key: string): string {
    return join(this.root, `${key}.json`)
  }

  private read(key: string): AuthRecord {
    try {
      return JSON.parse(readFileSync(this.file(key), 'utf8')) as AuthRecord
    } catch {
      return {}
    }
  }

  private update(key: string, patch: AuthRecord): void {
    this.write(key, { ...this.read(key), ...patch })
  }

  private write(key: string, record: AuthRecord): void {
    mkdirSync(this.root, { recursive: true })
    writeFileSync(this.file(key), JSON.stringify(record, null, 2))
  }
}

function shortKey(serverUrl: string): string {
  const url = new URL(serverUrl)
  return `${url.host.replace(/[^A-Za-z0-9.-]/gu, '_')}-${createHash('sha256').update(serverUrl).digest('hex').slice(0, 12)}`
}

/** Open a URL in the user's browser. */
export function openBrowser(url: string): void {
  const [command, args] = process.platform === 'win32'
    ? ['rundll32', ['url.dll,FileProtocolHandler', url]] as const
    : process.platform === 'darwin' ? ['open', [url]] as const : ['xdg-open', [url]] as const
  spawn(command, [...args], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}
