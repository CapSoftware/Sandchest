import { describe, expect, test, afterEach, mock } from 'bun:test'
import { apiFetch, ApiError } from './api'

describe('apiFetch', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function mockFetch(fn: (...args: unknown[]) => Promise<Response>) {
    globalThis.fetch = mock(fn) as unknown as typeof fetch
  }

  test('makes a request with correct defaults', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined

    mockFetch(async (url, init) => {
      capturedUrl = url as string
      capturedInit = init as RequestInit
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    await apiFetch('/v1/sandboxes')

    expect(capturedUrl).toContain('/v1/sandboxes')
    expect(capturedInit?.credentials).toBe('include')
    expect((capturedInit?.headers as Record<string, string>)?.['Content-Type']).toBe('application/json')
  })

  test('returns parsed JSON on success', async () => {
    mockFetch(async () => {
      return new Response(JSON.stringify({ sandboxes: [], next_cursor: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    const data = await apiFetch<{ sandboxes: unknown[]; next_cursor: null }>('/v1/sandboxes')
    expect(data.sandboxes).toEqual([])
    expect(data.next_cursor).toBeNull()
  })

  test('throws ApiError on non-ok response with error message', async () => {
    mockFetch(async () => {
      return new Response(JSON.stringify({ message: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    expect.assertions(3)
    try {
      await apiFetch('/v1/sandboxes/missing')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).message).toBe('Not found')
      expect((err as ApiError).status).toBe(404)
    }
  })

  test('throws ApiError with generic message when response body is not JSON', async () => {
    mockFetch(async () => {
      return new Response('Internal Server Error', { status: 500 })
    })

    expect.assertions(2)
    try {
      await apiFetch('/v1/sandboxes')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).message).toBe('Request failed: 500')
    }
  })

  test('passes custom method and headers', async () => {
    let capturedInit: RequestInit | undefined

    mockFetch(async (_url, init) => {
      capturedInit = init as RequestInit
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    await apiFetch('/v1/sandboxes/123/stop', { method: 'POST' })
    expect(capturedInit?.method).toBe('POST')
  })

  test('includes error code from API response', async () => {
    mockFetch(async () => {
      return new Response(
        JSON.stringify({ message: 'Limit reached', code: 'billing_limit' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      )
    })

    expect.assertions(3)
    try {
      await apiFetch('/v1/sandboxes')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).status).toBe(403)
      expect((err as ApiError).code).toBe('billing_limit')
    }
  })
})

describe('ApiError', () => {
  test('has correct name', () => {
    const err = new ApiError(404, 'Not found')
    expect(err.name).toBe('ApiError')
  })

  test('is an instance of Error', () => {
    const err = new ApiError(500, 'Server error')
    expect(err).toBeInstanceOf(Error)
  })

  test('stores status and code', () => {
    const err = new ApiError(403, 'Forbidden', 'billing_limit')
    expect(err.status).toBe(403)
    expect(err.code).toBe('billing_limit')
    expect(err.message).toBe('Forbidden')
  })

  test('code is undefined when not provided', () => {
    const err = new ApiError(404, 'Not found')
    expect(err.code).toBeUndefined()
  })
})
