import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Command } from 'commander'
import { readConfig } from '../config.js'
import { authCommand } from './auth.js'

describe('auth command', () => {
  let tempDir: string
  const originalXdg = process.env['XDG_CONFIG_HOME']
  const originalApiKey = process.env['SANDCHEST_API_KEY']
  let logSpy: ReturnType<typeof spyOn>
  let errorSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sandchest-auth-test-'))
    process.env['XDG_CONFIG_HOME'] = tempDir
    delete process.env['SANDCHEST_API_KEY']
    process.env['NO_COLOR'] = '1'
    logSpy = spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    if (originalXdg !== undefined) {
      process.env['XDG_CONFIG_HOME'] = originalXdg
    } else {
      delete process.env['XDG_CONFIG_HOME']
    }
    if (originalApiKey !== undefined) {
      process.env['SANDCHEST_API_KEY'] = originalApiKey
    } else {
      delete process.env['SANDCHEST_API_KEY']
    }
    delete process.env['NO_COLOR']
    logSpy.mockRestore()
    errorSpy.mockRestore()
  })

  test('login saves API key to config', async () => {
    const program = new Command()
    program.addCommand(authCommand())
    await program.parseAsync(['node', 'test', 'auth', 'login', '--key', 'sk_test_123456'])

    const config = readConfig()
    expect(config.apiKey).toBe('sk_test_123456')
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('API key saved'))
  })

  test('logout removes API key from config', async () => {
    // First login
    const program1 = new Command()
    program1.addCommand(authCommand())
    await program1.parseAsync(['node', 'test', 'auth', 'login', '--key', 'sk_to_remove'])

    expect(readConfig().apiKey).toBe('sk_to_remove')

    // Then logout
    const program2 = new Command()
    program2.addCommand(authCommand())
    await program2.parseAsync(['node', 'test', 'auth', 'logout'])

    expect(readConfig().apiKey).toBeUndefined()
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('API key removed'))
  })

  test('status shows env var source', async () => {
    process.env['SANDCHEST_API_KEY'] = 'sk_envvar_abcdef1234'

    const program = new Command()
    program.addCommand(authCommand())
    await program.parseAsync(['node', 'test', 'auth', 'status'])

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('SANDCHEST_API_KEY environment variable'),
    )
  })

  test('status shows config file source', async () => {
    const program1 = new Command()
    program1.addCommand(authCommand())
    await program1.parseAsync(['node', 'test', 'auth', 'login', '--key', 'sk_config_abcdef1234'])

    const program2 = new Command()
    program2.addCommand(authCommand())
    await program2.parseAsync(['node', 'test', 'auth', 'status'])

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('config file'))
  })

  test('status shows not authenticated', async () => {
    const program = new Command()
    program.addCommand(authCommand())
    await program.parseAsync(['node', 'test', 'auth', 'status'])

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Not authenticated'))
  })
})
