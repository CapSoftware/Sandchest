import { describe, expect, test, afterEach, mock } from 'bun:test'
import { apiFetch } from './api'

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

  test('throws on non-ok response with error message', async () => {
    mockFetch(async () => {
      return new Response(JSON.stringify({ message: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    expect.assertions(1)
    try {
      await apiFetch('/v1/sandboxes/missing')
    } catch (err) {
      expect((err as Error).message).toBe('Not found')
    }
  })

  test('throws generic error when response body is not JSON', async () => {
    mockFetch(async () => {
      return new Response('Internal Server Error', { status: 500 })
    })

    expect.assertions(1)
    try {
      await apiFetch('/v1/sandboxes')
    } catch (err) {
      expect((err as Error).message).toBe('Request failed: 500')
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
})
