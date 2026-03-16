import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { getApiKey, getClient } from '../config.js'
import { success, error, handleError, info } from '../output.js'

function hasClaudeCodeSkill(): boolean {
  const home = process.env['HOME'] ?? homedir()
  return (
    existsSync(join(process.cwd(), '.claude', 'skills', 'sandchest', 'SKILL.md')) ||
    existsSync(join(home, '.claude', 'skills', 'sandchest', 'SKILL.md'))
  )
}

async function hasMcpPackage(): Promise<boolean> {
  try {
    const pkg = '@sandchest/mcp'
    await import(pkg)
    return true
  } catch {
    const here = dirname(fileURLToPath(import.meta.url))
    const workspacePackage = resolve(here, '../../../mcp/package.json')
    return existsSync(workspacePackage)
  }
}

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
        if (await hasMcpPackage()) {
          success('MCP package found')
        } else {
          error('@sandchest/mcp package not found. Install it: bun add @sandchest/mcp')
          process.exit(1)
        }

        const allowedRoots = process.env['SANDCHEST_MCP_ALLOWED_PATHS']
        if (allowedRoots) {
          success(`Approved local roots configured: ${allowedRoots}`)
        } else {
          info(
            'Warning: SANDCHEST_MCP_ALLOWED_PATHS is not set in this shell. In Claude Code, local upload tools stay disabled unless the client config sets approved roots.',
          )
        }

        if (hasClaudeCodeSkill()) {
          success('Claude Code skill installed')
        } else {
          info('Tip: install the Claude Code skill with `sandchest skill install` or `sandchest skill install --global`.')
        }

        success('MCP server ready')
      } catch (err) {
        handleError(err)
      }
    })
}
