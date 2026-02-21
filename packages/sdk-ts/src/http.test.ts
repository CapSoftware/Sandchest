import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { HttpClient } from './http.js'
import {
  SandchestError,
  NotFoundError,
  RateLimitError,
  SandboxNotRunningError,
  ValidationError,
  AuthenticationError,
  TimeoutError,
  ConnectionError,
} from './errors.js'

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function errorBody(error: string, message: string, requestId = 'req_test'): unknown {
  return { error, message, request_id: requestId, retry_after: null }
}

describe('HttpClient', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function createClient(overrides?: Partial<{ retries: number; timeout: number }>) {
    return new HttpClient({
      apiKey: 'sk_test_key',
      baseUrl: 'https://api.sandchest.com',
      timeout: overrides?.timeout ?? 30_000,
      retries: overrides?.retries ?? 0,
    })
  }

  describe('request headers', () => {
    test('sends Authorization header with Bearer token', async () => {
      let capturedInit: RequestInit | undefined
      globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedInit = init
        return jsonResponse({ ok: true })
      }) as unknown as typeof fetch

      const client = createClient()
      await client.request({ method: 'GET', path: '/v1/sandboxes' })

      const headers = capturedInit?.headers as Record<string, string>
      expect(headers['Authorization']).toBe('Bearer sk_test_key')
    })

    test('sends Content-Type and Accept as application/json', async () => {
      let capturedInit: RequestInit | undefined
      globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedInit = init
        return jsonResponse({ ok: true })
      }) as unknown as typeof fetch

      const client = createClient()
      await client.request({ method: 'GET', path: '/v1/sandboxes' })

      const headers = capturedInit?.headers as Record<string, string>
      expect(headers['Content-Type']).toBe('application/json')
      expect(headers['Accept']).toBe('application/json')
    })

    test('adds Idempotency-Key for mutation requests', async () => {
      let capturedInit: RequestInit | undefined
      globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedInit = init
        return jsonResponse({ sandbox_id: 'sb_test' })
      }) as unknown as typeof fetch

      const client = createClient()
      await client.request({ method: 'POST', path: '/v1/sandboxes', body: {} })

      const headers = capturedInit?.headers as Record<string, string>
      expect(headers['Idempotency-Key']).toBeDefined()
      expect(headers['Idempotency-Key'].length).toBe(32) // 16 bytes hex = 32 chars
    })

    test('does not add Idempotency-Key for GET requests', async () => {
      let capturedInit: RequestInit | undefined
      globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedInit = init
        return jsonResponse({ items: [] })
      }) as unknown as typeof fetch

      const client = createClient()
      await client.request({ method: 'GET', path: '/v1/sandboxes' })

      const headers = capturedInit?.headers as Record<string, string>
      expect(headers['Idempotency-Key']).toBeUndefined()
    })

    test('uses provided idempotencyKey', async () => {
      let capturedInit: RequestInit | undefined
      globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedInit = init
        return jsonResponse({ ok: true })
      }) as unknown as typeof fetch

      const client = createClient()
      await client.request({
        method: 'POST',
        path: '/v1/sandboxes',
        body: {},
        idempotencyKey: 'custom_key_123',
      })

      const headers = capturedInit?.headers as Record<string, string>
      expect(headers['Idempotency-Key']).toBe('custom_key_123')
    })
  })

  describe('URL building', () => {
    test('constructs URL from base and path', async () => {
      let capturedUrl = ''
      globalThis.fetch = mock(async (url: string | URL | Request) => {
        capturedUrl = String(url)
        return jsonResponse({})
      }) as unknown as typeof fetch

      const client = createClient()
      await client.request({ method: 'GET', path: '/v1/sandboxes' })

      expect(capturedUrl).toBe('https://api.sandchest.com/v1/sandboxes')
    })

    test('appends query parameters', async () => {
      let capturedUrl = ''
      globalThis.fetch = mock(async (url: string | URL | Request) => {
        capturedUrl = String(url)
        return jsonResponse({})
      }) as unknown as typeof fetch

      const client = createClient()
      await client.request({
        method: 'GET',
        path: '/v1/sandboxes',
        query: { status: 'running', limit: 10 },
      })

      const url = new URL(capturedUrl)
      expect(url.searchParams.get('status')).toBe('running')
      expect(url.searchParams.get('limit')).toBe('10')
    })

    test('omits undefined query parameters', async () => {
      let capturedUrl = ''
      globalThis.fetch = mock(async (url: string | URL | Request) => {
        capturedUrl = String(url)
        return jsonResponse({})
      }) as unknown as typeof fetch

      const client = createClient()
      await client.request({
        method: 'GET',
        path: '/v1/sandboxes',
        query: { status: 'running', image: undefined },
      })

      const url = new URL(capturedUrl)
      expect(url.searchParams.get('status')).toBe('running')
      expect(url.searchParams.has('image')).toBe(false)
    })

    test('strips trailing slash from base URL', async () => {
      let capturedUrl = ''
      globalThis.fetch = mock(async (url: string | URL | Request) => {
        capturedUrl = String(url)
        return jsonResponse({})
      }) as unknown as typeof fetch

      const client = new HttpClient({
        apiKey: 'sk_test',
        baseUrl: 'https://api.sandchest.com/',
        timeout: 30_000,
        retries: 0,
      })
      await client.request({ method: 'GET', path: '/v1/sandboxes' })

      expect(capturedUrl).toBe('https://api.sandchest.com/v1/sandboxes')
    })
  })

  describe('request body', () => {
    test('sends JSON body for POST requests', async () => {
      let capturedInit: RequestInit | undefined
      globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedInit = init
        return jsonResponse({ sandbox_id: 'sb_test' })
      }) as unknown as typeof fetch

      const client = createClient()
      const body = { image: 'node:20', profile: 'small' }
      await client.request({ method: 'POST', path: '/v1/sandboxes', body })

      expect(capturedInit?.body).toBe(JSON.stringify(body))
      expect(capturedInit?.method).toBe('POST')
    })

    test('does not send body for GET requests', async () => {
      let capturedInit: RequestInit | undefined
      globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedInit = init
        return jsonResponse({})
      }) as unknown as typeof fetch

      const client = createClient()
      await client.request({ method: 'GET', path: '/v1/sandboxes' })

      expect(capturedInit?.body).toBeUndefined()
    })
  })

  describe('successful responses', () => {
    test('returns parsed JSON body', async () => {
      const responseData = { sandbox_id: 'sb_abc', status: 'running' }
      globalThis.fetch = mock(async () => jsonResponse(responseData)) as unknown as typeof fetch

      const client = createClient()
      const result = await client.request<{ sandbox_id: string; status: string }>({
        method: 'GET',
        path: '/v1/sandboxes/sb_abc',
      })

      expect(result).toEqual(responseData)
    })
  })

  describe('error parsing', () => {
    test('400 returns ValidationError', async () => {
      globalThis.fetch = mock(async () =>
        jsonResponse(errorBody('validation_error', 'Invalid body'), 400),
      ) as unknown as typeof fetch

      const client = createClient()
      try {
        await client.request({ method: 'POST', path: '/v1/sandboxes', body: {} })
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError)
        expect((err as ValidationError).status).toBe(400)
        expect((err as ValidationError).code).toBe('validation_error')
      }
    })

    test('401 returns AuthenticationError', async () => {
      globalThis.fetch = mock(async () =>
        jsonResponse(errorBody('unauthorized', 'Invalid API key'), 401),
      ) as unknown as typeof fetch

      const client = createClient()
      try {
        await client.request({ method: 'GET', path: '/v1/sandboxes' })
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(AuthenticationError)
        expect((err as AuthenticationError).status).toBe(401)
      }
    })

    test('404 returns NotFoundError', async () => {
      globalThis.fetch = mock(async () =>
        jsonResponse(errorBody('not_found', 'Sandbox not found'), 404),
      ) as unknown as typeof fetch

      const client = createClient()
      try {
        await client.request({ method: 'GET', path: '/v1/sandboxes/sb_missing' })
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(NotFoundError)
        expect((err as NotFoundError).status).toBe(404)
      }
    })

    test('409 returns SandboxNotRunningError', async () => {
      globalThis.fetch = mock(async () =>
        jsonResponse(errorBody('sandbox_not_running', 'Sandbox is stopped'), 409),
      ) as unknown as typeof fetch

      const client = createClient()
      try {
        await client.request({ method: 'POST', path: '/v1/sandboxes/sb_x/exec', body: {} })
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(SandboxNotRunningError)
        expect((err as SandboxNotRunningError).status).toBe(409)
      }
    })

    test('429 returns RateLimitError with retryAfter', async () => {
      globalThis.fetch = mock(async () =>
        jsonResponse(
          { error: 'rate_limited', message: 'Too many requests', request_id: 'req_rl', retry_after: 30 },
          429,
        ),
      ) as unknown as typeof fetch

      const client = createClient()
      try {
        await client.request({ method: 'GET', path: '/v1/sandboxes' })
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(RateLimitError)
        expect((err as RateLimitError).retryAfter).toBe(30)
      }
    })

    test('429 defaults retryAfter to 1 when not provided', async () => {
      globalThis.fetch = mock(async () =>
        jsonResponse(
          { error: 'rate_limited', message: 'Too many requests', request_id: 'req_rl2', retry_after: null },
          429,
        ),
      ) as unknown as typeof fetch

      const client = createClient()
      try {
        await client.request({ method: 'GET', path: '/v1/sandboxes' })
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(RateLimitError)
        expect((err as RateLimitError).retryAfter).toBe(1)
      }
    })

    test('unknown status returns generic SandchestError', async () => {
      globalThis.fetch = mock(async () =>
        jsonResponse(errorBody('forbidden', 'Forbidden'), 403),
      ) as unknown as typeof fetch

      const client = createClient()
      try {
        await client.request({ method: 'GET', path: '/v1/sandboxes' })
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(SandchestError)
        expect((err as SandchestError).status).toBe(403)
        expect((err as SandchestError).code).toBe('forbidden')
      }
    })

    test('extracts requestId from error body', async () => {
      globalThis.fetch = mock(async () =>
        jsonResponse(errorBody('not_found', 'Not found', 'req_custom_id'), 404),
      ) as unknown as typeof fetch

      const client = createClient()
      try {
        await client.request({ method: 'GET', path: '/v1/sandboxes/sb_x' })
        expect.unreachable('should have thrown')
      } catch (err) {
        expect((err as SandchestError).requestId).toBe('req_custom_id')
      }
    })
  })

  describe('retries', () => {
    test('retries on 500 errors up to max retries', async () => {
      let callCount = 0
      globalThis.fetch = mock(async () => {
        callCount++
        if (callCount <= 2) {
          return jsonResponse(errorBody('internal_error', 'Server error'), 500)
        }
        return jsonResponse({ ok: true })
      }) as unknown as typeof fetch

      const client = createClient({ retries: 2 })
      const result = await client.request<{ ok: boolean }>({
        method: 'GET',
        path: '/v1/sandboxes',
      })

      expect(result).toEqual({ ok: true })
      expect(callCount).toBe(3)
    })

    test('throws after exhausting retries on 500', async () => {
      globalThis.fetch = mock(async () =>
        jsonResponse(errorBody('internal_error', 'Server error'), 500),
      ) as unknown as typeof fetch

      const client = createClient({ retries: 1 })
      try {
        await client.request({ method: 'GET', path: '/v1/sandboxes' })
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(SandchestError)
        expect((err as SandchestError).status).toBe(500)
      }
    })

    test('does not retry on 4xx client errors', async () => {
      let callCount = 0
      globalThis.fetch = mock(async () => {
        callCount++
        return jsonResponse(errorBody('not_found', 'Not found'), 404)
      }) as unknown as typeof fetch

      const client = createClient({ retries: 2 })
      try {
        await client.request({ method: 'GET', path: '/v1/sandboxes/sb_x' })
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(NotFoundError)
        expect(callCount).toBe(1)
      }
    })

    test('retries on network errors', async () => {
      let callCount = 0
      globalThis.fetch = mock(async () => {
        callCount++
        if (callCount === 1) {
          throw new TypeError('Failed to fetch')
        }
        return jsonResponse({ ok: true })
      }) as unknown as typeof fetch

      const client = createClient({ retries: 1 })
      const result = await client.request<{ ok: boolean }>({
        method: 'GET',
        path: '/v1/sandboxes',
      })

      expect(result).toEqual({ ok: true })
      expect(callCount).toBe(2)
    })

    test('retries on 429 rate limit errors', async () => {
      let callCount = 0
      globalThis.fetch = mock(async () => {
        callCount++
        if (callCount === 1) {
          return jsonResponse(
            { error: 'rate_limited', message: 'Too many requests', request_id: 'req_rl', retry_after: 0.001 },
            429,
          )
        }
        return jsonResponse({ ok: true })
      }) as unknown as typeof fetch

      const client = createClient({ retries: 1 })
      const result = await client.request<{ ok: boolean }>({
        method: 'GET',
        path: '/v1/sandboxes',
      })

      expect(result).toEqual({ ok: true })
      expect(callCount).toBe(2)
    })

    test('throws RateLimitError after exhausting retries on 429', async () => {
      globalThis.fetch = mock(async () =>
        jsonResponse(
          { error: 'rate_limited', message: 'Too many requests', request_id: 'req_rl', retry_after: 0.001 },
          429,
        ),
      ) as unknown as typeof fetch

      const client = createClient({ retries: 1 })
      try {
        await client.request({ method: 'GET', path: '/v1/sandboxes' })
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(RateLimitError)
        expect((err as RateLimitError).status).toBe(429)
      }
    })
  })

  describe('204 No Content', () => {
    test('returns undefined for 204 responses', async () => {
      globalThis.fetch = mock(async () =>
        new Response(null, { status: 204 }),
      ) as unknown as typeof fetch

      const client = createClient()
      const result = await client.request<void>({
        method: 'DELETE',
        path: '/v1/sandboxes/sb_x',
      })

      expect(result).toBeUndefined()
    })
  })

  describe('error wrapping', () => {
    test('wraps timeout abort into TimeoutError', async () => {
      globalThis.fetch = mock(async () => {
        const error = new DOMException('The operation was aborted', 'AbortError')
        throw error
      }) as unknown as typeof fetch

      const client = createClient({ retries: 0 })
      try {
        await client.request({ method: 'GET', path: '/v1/sandboxes', timeout: 100 })
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(TimeoutError)
        expect((err as TimeoutError).timeoutMs).toBe(100)
        expect((err as TimeoutError).code).toBe('timeout')
      }
    })

    test('wraps network errors into ConnectionError', async () => {
      globalThis.fetch = mock(async () => {
        throw new TypeError('Failed to fetch')
      }) as unknown as typeof fetch

      const client = createClient({ retries: 0 })
      try {
        await client.request({ method: 'GET', path: '/v1/sandboxes' })
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectionError)
        expect((err as ConnectionError).code).toBe('connection_error')
        expect((err as ConnectionError).cause).toBeInstanceOf(TypeError)
      }
    })

    test('wraps network errors into ConnectionError after exhausting retries', async () => {
      globalThis.fetch = mock(async () => {
        throw new TypeError('Failed to fetch')
      }) as unknown as typeof fetch

      const client = createClient({ retries: 1 })
      try {
        await client.request({ method: 'GET', path: '/v1/sandboxes' })
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectionError)
        expect((err as ConnectionError).message).toBe('Failed to fetch')
      }
    })

    test('preserves SandchestError subclasses through retry exhaustion', async () => {
      globalThis.fetch = mock(async () =>
        jsonResponse(errorBody('internal_error', 'Server error'), 500),
      ) as unknown as typeof fetch

      const client = createClient({ retries: 1 })
      try {
        await client.request({ method: 'GET', path: '/v1/sandboxes' })
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(SandchestError)
        expect((err as SandchestError).status).toBe(500)
      }
    })
  })
})
