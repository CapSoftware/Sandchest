import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { loadEnv } from './env.js'

describe('loadEnv', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    // Start with a clean env containing only the required vars
    for (const key of Object.keys(process.env)) {
      delete process.env[key]
    }
    process.env.DATABASE_URL = 'mysql://test:test@localhost:3306/test'
    process.env.BETTER_AUTH_SECRET = 'test-secret-key'
    process.env.RESEND_API_KEY = 're_test_key'
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  // --- Required secrets ---

  test('returns all required secrets from env vars', () => {
    const env = loadEnv()
    expect(env.DATABASE_URL).toBe('mysql://test:test@localhost:3306/test')
    expect(env.BETTER_AUTH_SECRET).toBe('test-secret-key')
    expect(env.RESEND_API_KEY).toBe('re_test_key')
  })

  test('throws when DATABASE_URL is missing', () => {
    delete process.env.DATABASE_URL
    expect(() => loadEnv()).toThrow('Missing required environment variable: DATABASE_URL')
  })

  test('throws when BETTER_AUTH_SECRET is missing', () => {
    delete process.env.BETTER_AUTH_SECRET
    expect(() => loadEnv()).toThrow('Missing required environment variable: BETTER_AUTH_SECRET')
  })

  test('throws when RESEND_API_KEY is missing', () => {
    delete process.env.RESEND_API_KEY
    expect(() => loadEnv()).toThrow('Missing required environment variable: RESEND_API_KEY')
  })

  // --- Optional vars ---

  test('returns undefined for optional AUTUMN_SECRET_KEY when unset', () => {
    const env = loadEnv()
    expect(env.AUTUMN_SECRET_KEY).toBeUndefined()
  })

  test('returns AUTUMN_SECRET_KEY when set', () => {
    process.env.AUTUMN_SECRET_KEY = 'autumn-key'
    const env = loadEnv()
    expect(env.AUTUMN_SECRET_KEY).toBe('autumn-key')
  })

  test('returns undefined for optional REDIS_URL when unset', () => {
    const env = loadEnv()
    expect(env.REDIS_URL).toBeUndefined()
  })

  test('returns REDIS_URL when set', () => {
    process.env.REDIS_URL = 'redis://localhost:6379'
    const env = loadEnv()
    expect(env.REDIS_URL).toBe('redis://localhost:6379')
  })

  test('returns undefined for ARTIFACT_BUCKET_NAME when unset', () => {
    const env = loadEnv()
    expect(env.ARTIFACT_BUCKET_NAME).toBeUndefined()
  })

  test('returns ARTIFACT_BUCKET_NAME from env var', () => {
    process.env.ARTIFACT_BUCKET_NAME = 'my-bucket'
    const env = loadEnv()
    expect(env.ARTIFACT_BUCKET_NAME).toBe('my-bucket')
  })

  // --- Defaults ---

  test('uses default PORT when unset', () => {
    const env = loadEnv()
    expect(env.PORT).toBe(3001)
  })

  test('parses PORT from env', () => {
    process.env.PORT = '8080'
    const env = loadEnv()
    expect(env.PORT).toBe(8080)
  })

  test('uses default DRAIN_TIMEOUT_MS when unset', () => {
    const env = loadEnv()
    expect(env.DRAIN_TIMEOUT_MS).toBe(30_000)
  })

  test('uses default BETTER_AUTH_BASE_URL when unset', () => {
    const env = loadEnv()
    expect(env.BETTER_AUTH_BASE_URL).toBe('http://localhost:3001')
  })

  test('reads BETTER_AUTH_BASE_URL from env when set', () => {
    process.env.BETTER_AUTH_BASE_URL = 'https://api.sandchest.com'
    const env = loadEnv()
    expect(env.BETTER_AUTH_BASE_URL).toBe('https://api.sandchest.com')
  })

  test('uses default RESEND_FROM_EMAIL when unset', () => {
    const env = loadEnv()
    expect(env.RESEND_FROM_EMAIL).toBe('Sandchest Auth <noreply@send.sandchest.com>')
  })

  test('reads RESEND_FROM_EMAIL from env when set', () => {
    process.env.RESEND_FROM_EMAIL = 'Custom <custom@example.com>'
    const env = loadEnv()
    expect(env.RESEND_FROM_EMAIL).toBe('Custom <custom@example.com>')
  })

  test('uses default NODE_ENV when unset', () => {
    const env = loadEnv()
    expect(env.NODE_ENV).toBe('development')
  })

  test('reads NODE_ENV from env when set', () => {
    process.env.NODE_ENV = 'production'
    const env = loadEnv()
    expect(env.NODE_ENV).toBe('production')
  })

  test('uses default S3 region of auto', () => {
    const env = loadEnv()
    expect(env.SANDCHEST_S3_REGION).toBe('auto')
  })

  // --- Redis family ---

  test('REDIS_FAMILY defaults to undefined when unset', () => {
    const env = loadEnv()
    expect(env.REDIS_FAMILY).toBeUndefined()
  })

  test('REDIS_FAMILY is 6 when set to "6"', () => {
    process.env.REDIS_FAMILY = '6'
    const env = loadEnv()
    expect(env.REDIS_FAMILY).toBe(6)
  })

  test('REDIS_FAMILY is undefined for non-"6" values', () => {
    process.env.REDIS_FAMILY = '4'
    const env = loadEnv()
    expect(env.REDIS_FAMILY).toBeUndefined()
  })
})
