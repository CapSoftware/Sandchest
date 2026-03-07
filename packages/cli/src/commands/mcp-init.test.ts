import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Command } from 'commander'
import { mcpInitCommand, getMcpConfigPath } from './mcp-init.js'

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
}

describe('mcp init command', () => {
  let tempDir: string
  let previousHome: string | undefined
  let previousApiKey: string | undefined
  let logSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sandchest-mcp-init-'))
    previousHome = process.env['HOME']
    previousApiKey = process.env['SANDCHEST_API_KEY']
    process.env['HOME'] = tempDir
    process.env['SANDCHEST_API_KEY'] = 'sk_test_key'
    process.env['NO_COLOR'] = '1'
    logSpy = spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    if (previousHome === undefined) {
      delete process.env['HOME']
    } else {
      process.env['HOME'] = previousHome
    }
    if (previousApiKey === undefined) {
      delete process.env['SANDCHEST_API_KEY']
    } else {
      process.env['SANDCHEST_API_KEY'] = previousApiKey
    }
    delete process.env['NO_COLOR']
    logSpy.mockRestore()
  })

  test('writes allowed paths into the generated config', async () => {
    const allowPath = join(tempDir, 'projects')
    const program = new Command().addCommand(new Command('mcp').addCommand(mcpInitCommand()))

    await program.parseAsync(['node', 'test', 'mcp', 'init', 'claude', '--allow-path', allowPath])

    const config = readJson(getMcpConfigPath('claude'))
    const sandchest = (
      ((config.mcpServers as Record<string, unknown>)['sandchest'] ?? {}) as Record<string, unknown>
    )
    const env = sandchest['env'] as Record<string, string>

    expect(sandchest['command']).toBe('npx')
    expect(sandchest['args']).toEqual(['-y', '@sandchest/mcp'])
    expect(env['SANDCHEST_API_KEY']).toBe('sk_test_key')
    expect(env['SANDCHEST_MCP_ALLOWED_PATHS']).toBe(resolve(allowPath))
  })

  test('serializes repeated allow-path flags as a comma-separated env value', async () => {
    const first = join(tempDir, 'apps')
    const second = join(tempDir, 'repos')
    const program = new Command().addCommand(new Command('mcp').addCommand(mcpInitCommand()))

    await program.parseAsync([
      'node',
      'test',
      'mcp',
      'init',
      'cursor',
      '--allow-path',
      first,
      '--allow-path',
      second,
    ])

    const config = readJson(getMcpConfigPath('cursor'))
    const sandchest = (
      ((config.mcpServers as Record<string, unknown>)['sandchest'] ?? {}) as Record<string, unknown>
    )
    const env = sandchest['env'] as Record<string, string>

    expect(env['SANDCHEST_MCP_ALLOWED_PATHS']).toBe([resolve(first), resolve(second)].join(','))
  })

  test('merges into an existing config without deleting unrelated servers', async () => {
    delete process.env['SANDCHEST_API_KEY']
    const configPath = getMcpConfigPath('claude')
    mkdirSync(join(tempDir, 'Library', 'Application Support', 'Claude'), { recursive: true })
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            other: {
              command: 'npx',
              args: ['other-server'],
            },
            sandchest: {
              env: {
                EXISTING: '1',
                SANDCHEST_API_KEY: 'sk_existing',
              },
            },
          },
        },
        null,
        2,
      ),
    )

    const allowPath = join(tempDir, 'workspace')
    const program = new Command().addCommand(new Command('mcp').addCommand(mcpInitCommand()))
    await program.parseAsync([
      'node',
      'test',
      'mcp',
      'init',
      'claude',
      '--allow-path',
      allowPath,
    ])

    const config = readJson(configPath)
    const servers = config.mcpServers as Record<string, Record<string, unknown>>
    const sandchest = servers['sandchest']
    const env = sandchest['env'] as Record<string, string>

    expect(servers['other']).toEqual({
      command: 'npx',
      args: ['other-server'],
    })
    expect(env['EXISTING']).toBe('1')
    expect(env['SANDCHEST_API_KEY']).toBe('sk_existing')
    expect(env['SANDCHEST_MCP_ALLOWED_PATHS']).toBe(resolve(allowPath))
  })

  test('prints a warning when local filesystem tools remain disabled', async () => {
    const program = new Command().addCommand(new Command('mcp').addCommand(mcpInitCommand()))
    await program.parseAsync(['node', 'test', 'mcp', 'init', 'windsurf'])

    const config = readJson(getMcpConfigPath('windsurf'))
    const sandchest = (
      ((config.mcpServers as Record<string, unknown>)['sandchest'] ?? {}) as Record<string, unknown>
    )
    const env = sandchest['env'] as Record<string, string>

    expect(env['SANDCHEST_MCP_ALLOWED_PATHS']).toBeUndefined()
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('sandbox_upload_dir'))
  })

  test('uses bunx without changing env merging behavior', async () => {
    const configPath = getMcpConfigPath('cursor')
    mkdirSync(join(tempDir, '.cursor'), { recursive: true })
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            sandchest: {
              env: {
                KEEP_ME: '1',
              },
            },
          },
        },
        null,
        2,
      ),
    )

    const allowPath = join(tempDir, 'projects')
    const program = new Command().addCommand(new Command('mcp').addCommand(mcpInitCommand()))
    await program.parseAsync([
      'node',
      'test',
      'mcp',
      'init',
      'cursor',
      '--bunx',
      '--allow-path',
      allowPath,
    ])

    const config = readJson(configPath)
    const sandchest = (
      ((config.mcpServers as Record<string, unknown>)['sandchest'] ?? {}) as Record<string, unknown>
    )
    const env = sandchest['env'] as Record<string, string>

    expect(sandchest['command']).toBe('bunx')
    expect(sandchest['args']).toEqual(['@sandchest/mcp'])
    expect(env['KEEP_ME']).toBe('1')
    expect(env['SANDCHEST_API_KEY']).toBe('sk_test_key')
    expect(env['SANDCHEST_MCP_ALLOWED_PATHS']).toBe(resolve(allowPath))
  })
})
