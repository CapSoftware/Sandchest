import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { Sandchest } from '@sandchest/sdk'
import { mcpTestCommand } from './mcp-test.js'

describe('mcp test command', () => {
  let tempDir: string
  let previousHome: string | undefined
  let previousApiKey: string | undefined
  let previousAllowedPaths: string | undefined
  let previousCwd: string
  let listImpl: Sandchest['list']
  let logSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sandchest-mcp-test-'))
    previousHome = process.env['HOME']
    previousApiKey = process.env['SANDCHEST_API_KEY']
    previousAllowedPaths = process.env['SANDCHEST_MCP_ALLOWED_PATHS']
    previousCwd = process.cwd()
    process.chdir(tempDir)
    process.env['HOME'] = tempDir
    process.env['SANDCHEST_API_KEY'] = 'sk_test_key'
    process.env['NO_COLOR'] = '1'
    mkdirSync(join(tempDir, 'node_modules', '@sandchest', 'mcp'), { recursive: true })
    writeFileSync(
      join(tempDir, 'node_modules', '@sandchest', 'mcp', 'package.json'),
      JSON.stringify({
        name: '@sandchest/mcp',
        type: 'module',
        exports: './index.js',
      }),
    )
    writeFileSync(join(tempDir, 'node_modules', '@sandchest', 'mcp', 'index.js'), 'export {}\n')
    listImpl = Sandchest.prototype.list
    Sandchest.prototype.list = async () => []
    logSpy = spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    process.chdir(previousCwd)
    rmSync(tempDir, { recursive: true, force: true })
    Sandchest.prototype.list = listImpl
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
    if (previousAllowedPaths === undefined) {
      delete process.env['SANDCHEST_MCP_ALLOWED_PATHS']
    } else {
      process.env['SANDCHEST_MCP_ALLOWED_PATHS'] = previousAllowedPaths
    }
    delete process.env['NO_COLOR']
    logSpy.mockRestore()
  })

  test('reports approved roots and installed Claude Code skill', async () => {
    process.env['SANDCHEST_MCP_ALLOWED_PATHS'] = '/tmp/work'
    mkdirSync(join(tempDir, '.claude', 'skills', 'sandchest'), { recursive: true })
    writeFileSync(join(tempDir, '.claude', 'skills', 'sandchest', 'SKILL.md'), '# skill\n')

    const program = new Command().addCommand(new Command('mcp').addCommand(mcpTestCommand()))
    await program.parseAsync(['node', 'test', 'mcp', 'test'])

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Approved local roots configured: /tmp/work'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Claude Code skill installed'))
  })

  test('prints guidance when approved roots and skill are missing', async () => {
    delete process.env['SANDCHEST_MCP_ALLOWED_PATHS']

    const program = new Command().addCommand(new Command('mcp').addCommand(mcpTestCommand()))
    await program.parseAsync(['node', 'test', 'mcp', 'test'])

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('SANDCHEST_MCP_ALLOWED_PATHS is not set in this shell'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('sandchest skill install'))
  })
})
