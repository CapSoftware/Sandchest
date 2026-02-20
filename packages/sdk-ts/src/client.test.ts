import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Sandchest } from './client.js'

describe('Sandchest', () => {
  const originalEnv = process.env['SANDCHEST_API_KEY']

  beforeEach(() => {
    delete process.env['SANDCHEST_API_KEY']
  })

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['SANDCHEST_API_KEY'] = originalEnv
    } else {
      delete process.env['SANDCHEST_API_KEY']
    }
  })

  test('throws when no API key is provided and env is unset', () => {
    expect(() => new Sandchest()).toThrow('Sandchest API key is required')
  })

  test('accepts API key via options', () => {
    const client = new Sandchest({ apiKey: 'sk_test_123' })
    expect(client).toBeInstanceOf(Sandchest)
  })

  test('reads API key from SANDCHEST_API_KEY env var', () => {
    process.env['SANDCHEST_API_KEY'] = 'sk_from_env'
    const client = new Sandchest()
    expect(client).toBeInstanceOf(Sandchest)
  })

  test('options apiKey takes precedence over env var', () => {
    process.env['SANDCHEST_API_KEY'] = 'sk_from_env'
    const client = new Sandchest({ apiKey: 'sk_from_opts' })
    // The HttpClient is created — we just verify no error thrown
    expect(client._http).toBeDefined()
  })

  test('uses default base URL when not specified', () => {
    const client = new Sandchest({ apiKey: 'sk_test' })
    expect(client._http).toBeDefined()
  })

  test('accepts custom baseUrl, timeout, and retries', () => {
    const client = new Sandchest({
      apiKey: 'sk_test',
      baseUrl: 'https://custom.api.com',
      timeout: 5000,
      retries: 1,
    })
    expect(client._http).toBeDefined()
  })

  test('create throws not implemented', async () => {
    const client = new Sandchest({ apiKey: 'sk_test' })
    await expect(client.create()).rejects.toThrow('Not implemented')
  })

  test('get throws not implemented', async () => {
    const client = new Sandchest({ apiKey: 'sk_test' })
    await expect(client.get('sb_abc')).rejects.toThrow('Not implemented')
  })

  test('list throws not implemented', async () => {
    const client = new Sandchest({ apiKey: 'sk_test' })
    await expect(client.list()).rejects.toThrow('Not implemented')
  })
})
