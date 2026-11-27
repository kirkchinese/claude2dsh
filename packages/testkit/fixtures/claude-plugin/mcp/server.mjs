// A tiny stdio MCP server (newline-delimited JSON-RPC) with one tool, `echo`, and no dependencies.
import { createInterface } from 'node:readline'

const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) return // notifications need no answer
  if (method === 'initialize') {
    send({ id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'e2e-echo', version: '1.0.0' } } })
  } else if (method === 'tools/list') {
    send({ id, result: { tools: [{ name: 'echo', description: 'Echo the given text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } })
  } else if (method === 'tools/call') {
    send({ id, result: { content: [{ type: 'text', text: `MCP-ECHO:${String(params?.arguments?.text)}` }] } })
  } else {
    send({ id, error: { code: -32601, message: `unknown method ${String(method)}` } })
  }
})
