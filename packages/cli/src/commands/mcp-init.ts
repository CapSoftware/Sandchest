import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Command } from 'commander'
import { getApiKey } from '../config.js'
import { handleError, info, success } from '../output.js'

type McpClient = 'claude' | 'claude-code' | 'cursor' | 'windsurf'

interface McpServerConfig {
  command?: string
  args?: string[]
  env?: Record<string, string>
  [key: string]: unknown
}

interface McpConfig {
  mcpServers?: Record<string, McpServerConfig>
  [key: string]: unknown
}

function collectAllowPath(value: string, previous: string[]): string[] {
  return [...previous, value]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getClientLabel(client: McpClient): string {
  switch (client) {
    case 'claude':
      return 'Claude Desktop'
    case 'claude-code':
      return 'Claude Code'
    case 'cursor':
      return 'Cursor'
    case 'windsurf':
      return 'Windsurf'
  }
}

function getHomeDir(): string {
  return process.env['HOME'] ?? homedir()
}

export function getMcpConfigPath(client: McpClient): string {
  const home = getHomeDir()
  switch (client) {
    case 'claude':
      return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    case 'claude-code':
      return join(home, '.claude', 'mcp.json')
    case 'cursor':
      return join(home, '.cursor', 'mcp.json')
    case 'windsurf':
      return join(home, '.windsurf', 'mcp.json')
  }
}

function readMcpConfig(configPath: string): McpConfig {
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8')) as McpConfig
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {}
    }
    throw new Error(`Failed to read MCP config at ${configPath}`, { cause: error })
  }
}

function normalizeAllowPaths(paths: string[]): string | undefined {
  if (paths.length === 0) {
    return undefined
  }

  const normalized = [...new Set(paths.map((path) => resolve(path)))]
  return normalized.join(',')
}

function buildSandchestServer(
  existing: McpServerConfig | undefined,
  options: {
    apiKey: string | undefined
    allowedPaths: string | undefined
    bunx: boolean | undefined
  },
): McpServerConfig {
  const env = isRecord(existing?.env)
    ? Object.fromEntries(
        Object.entries(existing.env).filter((entry): entry is [string, string] => {
          return typeof entry[1] === 'string'
        }),
      )
    : {}

  if (options.apiKey) {
    env['SANDCHEST_API_KEY'] = options.apiKey
  } else if (!env['SANDCHEST_API_KEY']) {
    env['SANDCHEST_API_KEY'] = '<your-api-key>'
  }

  if (options.allowedPaths) {
    env['SANDCHEST_MCP_ALLOWED_PATHS'] = options.allowedPaths
  }

  return {
    ...existing,
    command: options.bunx ? 'bunx' : 'npx',
    args: options.bunx ? ['@sandchest/mcp'] : ['-y', '@sandchest/mcp'],
    env,
  }
}

function writeMcpConfig(configPath: string, config: McpConfig): void {
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8')
}

export function mcpInitCommand(): Command {
  return new Command('init')
    .description('Add Sandchest to an MCP client config')
    .argument('<client>', 'MCP client to configure (claude, claude-code, cursor, windsurf)')
    .option('--allow-path <path>', 'Approved local root for MCP filesystem tools (repeatable)', collectAllowPath, [])
    .option('--bunx', 'Use bunx instead of npx in the generated config')
    .action(async (client: McpClient, options: { allowPath: string[]; bunx?: boolean }) => {
      try {
        const configPath = getMcpConfigPath(client)
        const config = readMcpConfig(configPath)
        const mcpServers = isRecord(config.mcpServers)
          ? Object.fromEntries(
              Object.entries(config.mcpServers).map(([name, value]) => {
                return [name, isRecord(value) ? (value as McpServerConfig) : {}]
              }),
            )
          : {}
        const existingServer = isRecord(mcpServers['sandchest'])
          ? (mcpServers['sandchest'] as McpServerConfig)
          : undefined
        // Verify API key if present
        const currentApiKey = getApiKey()
        if (currentApiKey && currentApiKey !== '<your-api-key>') {
          try {
            const { Sandchest } = await import('@sandchest/sdk')
            const testClient = new Sandchest({ apiKey: currentApiKey })
            await testClient.list({ limit: 1 })
          } catch {
            process.stderr.write('warning: API key could not be verified. The API may be unreachable.\n')
          }
        }

        const allowedPaths = normalizeAllowPaths(options.allowPath)
        const sandchestServer = buildSandchestServer(existingServer, {
          apiKey: getApiKey(),
          allowedPaths,
          bunx: options.bunx,
        })

        writeMcpConfig(configPath, {
          ...config,
          mcpServers: {
            ...mcpServers,
            sandchest: sandchestServer,
          },
        })

        success(`Updated ${getClientLabel(client)} MCP config`)
        info(`Config: ${configPath}`)

        const configuredRoots = sandchestServer.env?.['SANDCHEST_MCP_ALLOWED_PATHS']
        if (configuredRoots) {
          info(`Approved local roots: ${configuredRoots}`)
        } else {
          info(
            'Warning: no local roots configured. sandbox_upload_dir and sandbox_download_dir remain disabled until SANDCHEST_MCP_ALLOWED_PATHS is set.',
          )
        }

        if (sandchestServer.env?.['SANDCHEST_API_KEY'] === '<your-api-key>') {
          info('Next: replace <your-api-key> with a real Sandchest API key.')
        }
        info(`Next: restart ${getClientLabel(client)}.`)
      } catch (error) {
        handleError(error)
      }
    })
}
