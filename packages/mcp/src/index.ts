#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Sandchest } from '@sandchest/sdk'
import { createServer } from './server.js'

async function main() {
  // Validate API key is configured
  const apiKey = process.env['SANDCHEST_API_KEY']
  if (!apiKey) {
    process.stderr.write(
      'sandchest-mcp: SANDCHEST_API_KEY environment variable is required.\n' +
      'Set it in your MCP client config or run: sandchest mcp init <client>\n',
    )
    process.exit(1)
  }

  let sandchest: Sandchest
  try {
    sandchest = new Sandchest()
  } catch (err) {
    process.stderr.write(`sandchest-mcp: failed to initialize SDK: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }

  // Verify API connectivity (best-effort, don't block startup)
  sandchest.list({ limit: 1 }).catch((err) => {
    process.stderr.write(`sandchest-mcp: API connectivity check failed: ${err instanceof Error ? err.message : String(err)}\n`)
    process.stderr.write('sandchest-mcp: MCP server started but API may be unreachable.\n')
  })

  const server = createServer(sandchest)
  const transport = new StdioServerTransport()

  try {
    await server.connect(transport)
  } catch (err) {
    process.stderr.write(`sandchest-mcp: failed to connect transport: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}

main().catch((err) => {
  process.stderr.write(`sandchest-mcp: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
