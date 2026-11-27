/**
 * A Streamable HTTP MCP server behind OAuth 2.1, as remote plugin servers such
 * as Context7 run it: 401 with protected-resource metadata, authorization
 * server metadata, dynamic client registration, PKCE (S256) and a bearer
 * token. `/authorize` approves immediately and redirects back.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { McpServer } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { z } from 'zod'

/** Start the server on a free port. */
export async function startOAuthMcpServer() {
  const clients = new Map()
  const codes = new Map()
  const tokens = new Set()
  let origin = ''
  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body))
  }
  const readBody = async (req) => {
    let text = ''
    for await (const chunk of req) text += chunk
    return text
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', origin)
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin] })
      return
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      json(res, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      })
      return
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      const metadata = JSON.parse(await readBody(req))
      const client_id = `client-${randomBytes(4).toString('hex')}`
      clients.set(client_id, metadata)
      json(res, 201, { ...metadata, client_id, client_id_issued_at: Math.floor(Date.now() / 1000) })
      return
    }
    if (url.pathname === '/authorize') {
      const client = clients.get(url.searchParams.get('client_id'))
      const redirect = url.searchParams.get('redirect_uri')
      if (client === undefined || !client.redirect_uris.includes(redirect)) {
        json(res, 400, { error: 'invalid_request' })
        return
      }
      const code = randomBytes(8).toString('hex')
      codes.set(code, { challenge: url.searchParams.get('code_challenge'), redirect })
      const back = new URL(redirect)
      back.searchParams.set('code', code)
      back.searchParams.set('state', url.searchParams.get('state') ?? '')
      res.writeHead(302, { location: back.href }).end()
      return
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req))
      const grant = codes.get(form.get('code'))
      const verifier = form.get('code_verifier') ?? ''
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      if (grant === undefined || grant.challenge !== challenge || grant.redirect !== form.get('redirect_uri')) {
        json(res, 400, { error: 'invalid_grant' })
        return
      }
      codes.delete(form.get('code'))
      const access_token = randomBytes(12).toString('hex')
      tokens.add(access_token)
      json(res, 200, { access_token, token_type: 'Bearer', expires_in: 3600 })
      return
    }
    if (url.pathname === '/mcp') {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /u, '')
      if (!tokens.has(token)) {
        json(res, 401, { error: 'invalid_token' }, {
          'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        })
        return
      }
      const mcp = new McpServer({ name: 'oauth-fixture', version: '1.0.0' })
      mcp.registerTool('echo', { description: 'Echo text', inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({ content: [{ type: 'text', text }] }))
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      await mcp.connect(transport)
      await transport.handleRequest(req, res)
      return
    }
    res.writeHead(404).end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  return {
    url: `${origin}/mcp`,
    close: () => new Promise(resolve => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    }),
  }
}
