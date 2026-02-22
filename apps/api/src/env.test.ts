import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { loadEnv, sstResource } from './env.js'

describe('sstResource', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  test('returns parsed JSON when SST_RESOURCE_ env var is set', () => {
    process.env.SST_RESOURCE_Redis = JSON.stringify({ host: 'redis.internal', port: 6379 })
    const result = sstResource<{ host: string; port: number }>('Redis')
    expect(result).toEqual({ host: 'redis.internal', port: 6379 })
  })

  test('returns undefined when SST_RESOURCE_ env var is not set', () => {
    delete process.env.SST_RESOURCE_Redis
    expect(sstResource('Redis')).toBeUndefined()
  })

  test('returns undefined when SST_RESOURCE_ env var is invalid JSON', () => {
    process.env.SST_RESOURCE_Redis = 'not-json'
    expect(sstResource('Redis')).toBeUndefined()
  })

  test('parses SST secret format', () => {
    process.env.SST_RESOURCE_DatabaseUrl = JSON.stringify({ value: 'mysql://prod:secret@rds:3306/db' })
    const result = sstResource<{ value: string }>('DatabaseUrl')
    expect(result?.value).toBe('mysql://prod:secret@rds:3306/db')
  })
})

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

  // --- Plain env var path (local development) ---

  test('returns all required secrets from plain env vars', () => {
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

  test('returns ARTIFACT_BUCKET_NAME from plain env var', () => {
    process.env.ARTIFACT_BUCKET_NAME = 'my-bucket'
    const env = loadEnv()
    expect(env.ARTIFACT_BUCKET_NAME).toBe('my-bucket')
  })

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

  // --- SST-linked resource path (ECS deployment) ---

  test('reads DATABASE_URL from SST-linked secret', () => {
    delete process.env.DATABASE_URL
    process.env.SST_RESOURCE_DatabaseUrl = JSON.stringify({ value: 'mysql://prod:secret@rds:3306/db' })
    const env = loadEnv()
    expect(env.DATABASE_URL).toBe('mysql://prod:secret@rds:3306/db')
  })

  test('reads BETTER_AUTH_SECRET from SST-linked secret', () => {
    delete process.env.BETTER_AUTH_SECRET
    process.env.SST_RESOURCE_BetterAuthSecret = JSON.stringify({ value: 'sst-auth-secret' })
    const env = loadEnv()
    expect(env.BETTER_AUTH_SECRET).toBe('sst-auth-secret')
  })

  test('reads RESEND_API_KEY from SST-linked secret', () => {
    delete process.env.RESEND_API_KEY
    process.env.SST_RESOURCE_ResendApiKey = JSON.stringify({ value: 're_prod_key' })
    const env = loadEnv()
    expect(env.RESEND_API_KEY).toBe('re_prod_key')
  })

  test('reads AUTUMN_SECRET_KEY from SST-linked secret', () => {
    process.env.SST_RESOURCE_AutumnSecretKey = JSON.stringify({ value: 'autumn-sst-key' })
    const env = loadEnv()
    expect(env.AUTUMN_SECRET_KEY).toBe('autumn-sst-key')
  })

  test('constructs REDIS_URL from SST-linked Redis resource', () => {
    process.env.SST_RESOURCE_Redis = JSON.stringify({ host: 'redis.cluster.internal', port: 6380 })
    const env = loadEnv()
    expect(env.REDIS_URL).toBe('redis://redis.cluster.internal:6380')
  })

  test('reads ARTIFACT_BUCKET_NAME from SST-linked Bucket resource', () => {
    process.env.SST_RESOURCE_ArtifactBucket = JSON.stringify({ name: 'sandchest-artifacts-prod' })
    const env = loadEnv()
    expect(env.ARTIFACT_BUCKET_NAME).toBe('sandchest-artifacts-prod')
  })

  test('SST-linked secret takes precedence over plain env var', () => {
    process.env.DATABASE_URL = 'mysql://local@localhost/test'
    process.env.SST_RESOURCE_DatabaseUrl = JSON.stringify({ value: 'mysql://prod@rds/prod' })
    const env = loadEnv()
    expect(env.DATABASE_URL).toBe('mysql://prod@rds/prod')
  })

  test('SST-linked Redis takes precedence over REDIS_URL env var', () => {
    process.env.REDIS_URL = 'redis://localhost:6379'
    process.env.SST_RESOURCE_Redis = JSON.stringify({ host: 'redis.prod', port: 6379 })
    const env = loadEnv()
    expect(env.REDIS_URL).toBe('redis://redis.prod:6379')
  })

  test('SST-linked Bucket takes precedence over ARTIFACT_BUCKET_NAME env var', () => {
    process.env.ARTIFACT_BUCKET_NAME = 'local-bucket'
    process.env.SST_RESOURCE_ArtifactBucket = JSON.stringify({ name: 'prod-bucket' })
    const env = loadEnv()
    expect(env.ARTIFACT_BUCKET_NAME).toBe('prod-bucket')
  })

  test('falls back to env var when SST resource JSON is malformed', () => {
    process.env.SST_RESOURCE_DatabaseUrl = 'not-json'
    const env = loadEnv()
    expect(env.DATABASE_URL).toBe('mysql://test:test@localhost:3306/test')
  })
})
