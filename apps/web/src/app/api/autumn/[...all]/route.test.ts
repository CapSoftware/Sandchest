import { describe, expect, test, mock, beforeEach } from 'bun:test'
import { identify } from './identify'

const originalFetch = globalThis.fetch

function mockFetch(fn: () => Promise<Response>) {
  const mocked = mock(fn)
  globalThis.fetch = mocked as unknown as typeof fetch
  return mocked
}

beforeEach(() => {
  globalThis.fetch = originalFetch
})

function makeRequest(cookies?: string): Request {
  const headers = new Headers()
  if (cookies) headers.set('cookie', cookies)
  return new Request('http://localhost:3000/api/autumn/check', { headers })
}

describe('autumn identify', () => {
  test('returns null when no cookie header is present', async () => {
    const result = await identify(makeRequest())
    expect(result).toBeNull()
  })

  test('returns null when session endpoint returns non-ok', async () => {
    mockFetch(() => Promise.resolve(new Response(null, { status: 401 })))

    const result = await identify(makeRequest('better-auth.session_token=abc'))
    expect(result).toBeNull()
  })

  test('returns null when session has no user', async () => {
    mockFetch(() =>
      Promise.resolve(Response.json({ session: null, user: null })),
    )

    const result = await identify(makeRequest('better-auth.session_token=abc'))
    expect(result).toBeNull()
  })

  test('returns customer data from valid session', async () => {
    mockFetch(() =>
      Promise.resolve(
        Response.json({
          user: { id: 'user_123', name: 'Jane Doe', email: 'jane@example.com' },
        }),
      ),
    )

    const result = await identify(makeRequest('better-auth.session_token=abc'))
    expect(result).toEqual({
      customerId: 'user_123',
      customerData: {
        name: 'Jane Doe',
        email: 'jane@example.com',
      },
    })
  })

  test('forwards cookie header to BetterAuth session endpoint', async () => {
    const mocked = mockFetch(() =>
      Promise.resolve(
        Response.json({
          user: { id: 'user_1', name: 'Test', email: 'test@test.com' },
        }),
      ),
    )

    await identify(makeRequest('better-auth.session_token=my-token'))

    expect(mocked).toHaveBeenCalledTimes(1)
    const call = mocked.mock.calls[0] as unknown as [string, RequestInit]
    expect(call[0]).toBe('http://localhost:3001/api/auth/get-session')
    expect(call[1].headers).toEqual({ cookie: 'better-auth.session_token=my-token' })
  })
})
