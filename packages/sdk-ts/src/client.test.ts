import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { Sandchest } from './client.js'
import { Sandbox } from './sandbox.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('Sandchest', () => {
  const originalEnv = process.env['SANDCHEST_API_KEY']
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    delete process.env['SANDCHEST_API_KEY']
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['SANDCHEST_API_KEY'] = originalEnv
    } else {
      delete process.env['SANDCHEST_API_KEY']
    }
    globalThis.fetch = originalFetch
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

  describe('create', () => {
    test('sends POST to /v1/sandboxes and returns Sandbox', async () => {
      let callCount = 0
      globalThis.fetch = mock(async (url: string | URL | Request) => {
        callCount++
        const urlStr = String(url)
        if (urlStr.endsWith('/v1/sandboxes') && callCount === 1) {
          return jsonResponse({
            sandbox_id: 'sb_new',
            status: 'queued',
            queue_position: 1,
            estimated_ready_seconds: 5,
            replay_url: 'https://replay.sandchest.com/sb_new',
            created_at: '2024-01-01T00:00:00Z',
          }, 201)
        }
        // waitReady polling
        return jsonResponse({
          sandbox_id: 'sb_new',
          status: 'running',
          image: 'ubuntu-22.04',
          profile: 'small',
          env: {},
          forked_from: null,
          fork_count: 0,
          created_at: '2024-01-01T00:00:00Z',
          started_at: '2024-01-01T00:00:01Z',
          ended_at: null,
          failure_reason: null,
          replay_url: 'https://replay.sandchest.com/sb_new',
        })
      }) as unknown as typeof fetch

      const client = new Sandchest({ apiKey: 'sk_test', retries: 0 })
      const sandbox = await client.create()

      expect(sandbox).toBeInstanceOf(Sandbox)
      expect(sandbox.id).toBe('sb_new')
      expect(sandbox.status).toBe('running')
      expect(sandbox.replayUrl).toBe('https://replay.sandchest.com/sb_new')
    })

    test('passes creation options as snake_case body', async () => {
      let capturedBody: string | undefined
      let callCount = 0
      globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
        callCount++
        if (callCount === 1) {
          capturedBody = init?.body as string
          return jsonResponse({
            sandbox_id: 'sb_new',
            status: 'running',
            queue_position: 0,
            estimated_ready_seconds: 0,
            replay_url: 'https://replay.sandchest.com/sb_new',
            created_at: '2024-01-01T00:00:00Z',
          }, 201)
        }
        return jsonResponse({
          sandbox_id: 'sb_new',
          status: 'running',
          image: 'node:20',
          profile: 'medium',
          env: { NODE_ENV: 'test' },
          forked_from: null,
          fork_count: 0,
          created_at: '2024-01-01T00:00:00Z',
          started_at: null,
          ended_at: null,
          failure_reason: null,
          replay_url: 'https://replay.sandchest.com/sb_new',
        })
      }) as unknown as typeof fetch

      const client = new Sandchest({ apiKey: 'sk_test', retries: 0 })
      await client.create({
        image: 'node:20',
        profile: 'medium',
        env: { NODE_ENV: 'test' },
        ttlSeconds: 7200,
        queueTimeoutSeconds: 60,
      })

      const body = JSON.parse(capturedBody!)
      expect(body.image).toBe('node:20')
      expect(body.profile).toBe('medium')
      expect(body.env).toEqual({ NODE_ENV: 'test' })
      expect(body.ttl_seconds).toBe(7200)
      expect(body.queue_timeout_seconds).toBe(60)
    })

    test('skips waitReady when waitReady is false', async () => {
      let callCount = 0
      globalThis.fetch = mock(async () => {
        callCount++
        return jsonResponse({
          sandbox_id: 'sb_new',
          status: 'queued',
          queue_position: 1,
          estimated_ready_seconds: 5,
          replay_url: 'https://replay.sandchest.com/sb_new',
          created_at: '2024-01-01T00:00:00Z',
        }, 201)
      }) as unknown as typeof fetch

      const client = new Sandchest({ apiKey: 'sk_test', retries: 0 })
      const sandbox = await client.create({ waitReady: false })

      expect(sandbox.status).toBe('queued')
      expect(callCount).toBe(1) // Only create call, no polling
    })
  })

  describe('get', () => {
    test('sends GET to /v1/sandboxes/:id and returns Sandbox', async () => {
      let capturedUrl = ''
      globalThis.fetch = mock(async (url: string | URL | Request) => {
        capturedUrl = String(url)
        return jsonResponse({
          sandbox_id: 'sb_abc',
          status: 'running',
          image: 'ubuntu-22.04',
          profile: 'small',
          env: {},
          forked_from: null,
          fork_count: 0,
          created_at: '2024-01-01T00:00:00Z',
          started_at: '2024-01-01T00:00:01Z',
          ended_at: null,
          failure_reason: null,
          replay_url: 'https://replay.sandchest.com/sb_abc',
        })
      }) as unknown as typeof fetch

      const client = new Sandchest({ apiKey: 'sk_test', retries: 0 })
      const sandbox = await client.get('sb_abc')

      expect(capturedUrl).toBe('https://api.sandchest.com/v1/sandboxes/sb_abc')
      expect(sandbox).toBeInstanceOf(Sandbox)
      expect(sandbox.id).toBe('sb_abc')
      expect(sandbox.status).toBe('running')
    })
  })

  describe('list', () => {
    test('sends GET to /v1/sandboxes and returns Sandbox[]', async () => {
      globalThis.fetch = mock(async () =>
        jsonResponse({
          sandboxes: [
            {
              sandbox_id: 'sb_1',
              status: 'running',
              image: 'ubuntu-22.04',
              profile: 'small',
              forked_from: null,
              created_at: '2024-01-01T00:00:00Z',
              replay_url: 'https://replay.sandchest.com/sb_1',
            },
            {
              sandbox_id: 'sb_2',
              status: 'stopped',
              image: 'node:20',
              profile: 'medium',
              forked_from: 'sb_1',
              created_at: '2024-01-01T00:01:00Z',
              replay_url: 'https://replay.sandchest.com/sb_2',
            },
          ],
          next_cursor: null,
        }),
      ) as unknown as typeof fetch

      const client = new Sandchest({ apiKey: 'sk_test', retries: 0 })
      const sandboxes = await client.list()

      expect(sandboxes).toHaveLength(2)
      expect(sandboxes[0]).toBeInstanceOf(Sandbox)
      expect(sandboxes[0]!.id).toBe('sb_1')
      expect(sandboxes[1]!.id).toBe('sb_2')
    })

    test('passes filter options as query parameters', async () => {
      let capturedUrl = ''
      globalThis.fetch = mock(async (url: string | URL | Request) => {
        capturedUrl = String(url)
        return jsonResponse({ sandboxes: [], next_cursor: null })
      }) as unknown as typeof fetch

      const client = new Sandchest({ apiKey: 'sk_test', retries: 0 })
      await client.list({ status: 'running', limit: 10, forkedFrom: 'sb_parent' })

      const url = new URL(capturedUrl)
      expect(url.searchParams.get('status')).toBe('running')
      expect(url.searchParams.get('limit')).toBe('10')
      expect(url.searchParams.get('forked_from')).toBe('sb_parent')
    })
  })
})
