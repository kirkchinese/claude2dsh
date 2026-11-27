import { createServer } from 'node:http'
import { McpServer } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport, localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node'
import { z } from 'zod'

const port = Number(process.env.PORT ?? 3977)
const mcp = new McpServer({ name: 'http-fixture', version: '1.0.0' })
mcp.registerTool(
  'echo',
  { description: 'Echo text through Streamable HTTP', inputSchema: z.object({ text: z.string() }) },
  async ({ text }) => ({ content: [{ type: 'text', text }] }),
)

const validateHost = localhostHostValidation()
const validateOrigin = localhostOriginValidation()
createServer(async (req, res) => {
  if (!validateHost(req, res) || !validateOrigin(req, res)) return
  if (req.url !== '/mcp') {
    res.writeHead(404).end()
    return
  }
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  await mcp.connect(transport)
  await transport.handleRequest(req, res)
}).listen(port, '127.0.0.1', () => {
  console.log(`http-mcp listening on ${port}`)
})
