#!/usr/bin/env node
/**
 * Legacy MCP SSE fixture: GET /sse opens the event stream, POST /message
 * receives JSON-RPC and replies through the stream. Used only by the Harness
 * Forge acceptance test for transports DSH's built-in client does not carry.
 *
 * Each SSE connection gets its own McpServer/transport pair because the SDK
 * protocol instance rejects a second connect. This mirrors a normal server that
 * supports multiple clients, and keeps the fixture alive across reconnects.
 */
import { createServer } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { z } from 'zod'

const port = Number(process.env.PORT ?? 3978)
const transports = new Map()
const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
  if (req.method === 'GET' && url.pathname === '/sse') {
    const server = new McpServer({ name: 'sse-fixture', version: '0.1.0' })
    server.tool('echo', { text: z.string() }, async ({ text }) => ({
      content: [{ type: 'text', text }],
    }))
    const transport = new SSEServerTransport('/message', res)
    transports.set(transport.sessionId, transport)
    res.on('close', () => {
      transports.delete(transport.sessionId)
      void transport.close()
    })
    await server.connect(transport)
    return
  }
  if (req.method === 'POST' && url.pathname === '/message') {
    const transport = transports.get(url.searchParams.get('sessionId'))
    if (transport === undefined) {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('SSE stream not open')
      return
    }
    await transport.handlePostMessage(req, res)
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
})
http.listen(port, '127.0.0.1', () => console.log(`SSE-MCP-LISTENING http://127.0.0.1:${port}/sse`))
