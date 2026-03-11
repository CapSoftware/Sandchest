import { Command } from 'commander'
import { getApiKey, getClient } from '../config.js'
import { success, error, handleError } from '../output.js'

export function mcpTestCommand(): Command {
  return new Command('test')
    .description('Test MCP server configuration')
    .action(async () => {
      try {
        // Check 1: API key
        const apiKey = getApiKey()
        if (!apiKey) {
          error('SANDCHEST_API_KEY is not set. Run: sandchest auth login --key <api-key>')
          process.exit(1)
        }
        success('API key configured')

        // Check 2: API reachable
        try {
          const client = getClient()
          await client.list({ limit: 1 })
          success('API reachable')
        } catch (err) {
          error(`API unreachable: ${err instanceof Error ? err.message : String(err)}`)
          process.exit(1)
        }

        // Check 3: MCP package importable (runtime check, not a compile-time dependency)
        try {
          const mcpPkg = '@sandchest/mcp'
          await import(mcpPkg)
          success('MCP package found')
        } catch {
          error('@sandchest/mcp package not found. Install it: bun add @sandchest/mcp')
          process.exit(1)
        }

        success('MCP server ready')
      } catch (err) {
        handleError(err)
      }
    })
}
