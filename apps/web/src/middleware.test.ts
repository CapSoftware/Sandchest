import { describe, expect, test } from 'bun:test'
import { middleware, config } from './middleware'
import { NextRequest } from 'next/server'

function makeRequest(pathname: string, cookies: Record<string, string> = {}): NextRequest {
  const url = new URL(pathname, 'http://localhost:3000')
  const request = new NextRequest(url)
  for (const [name, value] of Object.entries(cookies)) {
    request.cookies.set(name, value)
  }
  return request
}

const SESSION_COOKIE = { 'better-auth.session_token': 'test-session-token' }
const SECURE_SESSION_COOKIE = { '__Secure-better-auth.session_token': 'test-session-token' }

describe('auth middleware', () => {
  describe('protected routes', () => {
    test('redirects unauthenticated users to /login', () => {
      const res = middleware(makeRequest('/dashboard'))
      expect(res.status).toBe(307)
      expect(new URL(res.headers.get('location')!).pathname).toBe('/login')
    })

    test('redirects unauthenticated users from org-slug dashboard routes', () => {
      const res = middleware(makeRequest('/dashboard/acme-inc'))
      expect(res.status).toBe(307)
      expect(new URL(res.headers.get('location')!).pathname).toBe('/login')
    })

    test('redirects unauthenticated users from nested org-slug routes', () => {
      const res = middleware(makeRequest('/dashboard/acme-inc/keys'))
      expect(res.status).toBe(307)
      expect(new URL(res.headers.get('location')!).pathname).toBe('/login')
    })

    test('allows authenticated users to access dashboard', () => {
      const res = middleware(makeRequest('/dashboard', SESSION_COOKIE))
      expect(res.status).toBe(200)
    })

    test('allows authenticated users with __Secure- prefixed cookie', () => {
      const res = middleware(makeRequest('/dashboard', SECURE_SESSION_COOKIE))
      expect(res.status).toBe(200)
    })

    test('allows authenticated users to access org-slug dashboard routes', () => {
      const res = middleware(makeRequest('/dashboard/acme-inc', SESSION_COOKIE))
      expect(res.status).toBe(200)
    })

    test('allows authenticated users to access nested org-slug routes', () => {
      const res = middleware(makeRequest('/dashboard/acme-inc/settings', SESSION_COOKIE))
      expect(res.status).toBe(200)
    })

    test('redirects unauthenticated users from /onboarding to /login', () => {
      const res = middleware(makeRequest('/onboarding'))
      expect(res.status).toBe(307)
      expect(new URL(res.headers.get('location')!).pathname).toBe('/login')
    })

    test('allows authenticated users to access /onboarding', () => {
      const res = middleware(makeRequest('/onboarding', SESSION_COOKIE))
      expect(res.status).toBe(200)
    })
  })

  describe('auth pages', () => {
    test('does not redirect from auth pages — pages handle their own auth logic', () => {
      // Auth pages (/login, /signup, /verify) validate sessions server-side
      // via getSession() instead of relying on cookie existence checks.
      // This prevents redirect loops when cookies outlive sessions.
      const loginRes = middleware(makeRequest('/login', SESSION_COOKIE))
      expect(loginRes.status).toBe(200)

      const signupRes = middleware(makeRequest('/signup', SESSION_COOKIE))
      expect(signupRes.status).toBe(200)

      const verifyRes = middleware(makeRequest('/verify', SESSION_COOKIE))
      expect(verifyRes.status).toBe(200)
    })
  })

  describe('matcher config', () => {
    test('includes dashboard routes', () => {
      expect(config.matcher).toContain('/dashboard/:path*')
    })

    test('includes onboarding route', () => {
      expect(config.matcher).toContain('/onboarding')
    })

    test('does not include auth pages — they handle auth server-side', () => {
      expect(config.matcher).not.toContain('/login')
      expect(config.matcher).not.toContain('/signup')
      expect(config.matcher).not.toContain('/verify')
    })
  })
})
