import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getConfigDir, getConfigPath, readConfig, writeConfig, getApiKey, getClient } from './config.js'

describe('config', () => {
  let tempDir: string
  const originalXdg = process.env['XDG_CONFIG_HOME']
  const originalApiKey = process.env['SANDCHEST_API_KEY']

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sandchest-test-'))
    process.env['XDG_CONFIG_HOME'] = tempDir
    delete process.env['SANDCHEST_API_KEY']
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
  })

  test('getConfigDir uses XDG_CONFIG_HOME when set', () => {
    expect(getConfigDir()).toBe(join(tempDir, 'sandchest'))
  })

  test('getConfigPath returns config.json inside config dir', () => {
    expect(getConfigPath()).toBe(join(tempDir, 'sandchest', 'config.json'))
  })

  test('readConfig returns empty object when file does not exist', () => {
    expect(readConfig()).toEqual({})
  })

  test('writeConfig then readConfig roundtrips', () => {
    writeConfig({ apiKey: 'sk_test_abc123' })
    const config = readConfig()
    expect(config.apiKey).toBe('sk_test_abc123')
  })

  test('writeConfig creates config directory if missing', () => {
    writeConfig({ apiKey: 'sk_new' })
    const raw = readFileSync(getConfigPath(), 'utf-8')
    expect(JSON.parse(raw)).toEqual({ apiKey: 'sk_new' })
  })

  test('writeConfig preserves other fields', () => {
    writeConfig({ apiKey: 'sk_1', baseUrl: 'https://custom.api.com' })
    const config = readConfig()
    expect(config.apiKey).toBe('sk_1')
    expect(config.baseUrl).toBe('https://custom.api.com')
  })

  describe('getApiKey', () => {
    test('returns env var when set', () => {
      process.env['SANDCHEST_API_KEY'] = 'sk_from_env'
      expect(getApiKey()).toBe('sk_from_env')
    })

    test('returns config file key when env is unset', () => {
      writeConfig({ apiKey: 'sk_from_config' })
      expect(getApiKey()).toBe('sk_from_config')
    })

    test('env var takes precedence over config file', () => {
      process.env['SANDCHEST_API_KEY'] = 'sk_env'
      writeConfig({ apiKey: 'sk_config' })
      expect(getApiKey()).toBe('sk_env')
    })

    test('returns undefined when nothing is set', () => {
      expect(getApiKey()).toBeUndefined()
    })
  })

  describe('getClient', () => {
    test('throws when no API key is available', () => {
      expect(() => getClient()).toThrow('Not authenticated')
    })

    test('returns Sandchest client when API key is set', () => {
      process.env['SANDCHEST_API_KEY'] = 'sk_test_key'
      const client = getClient()
      expect(client).toBeDefined()
    })
  })
})
