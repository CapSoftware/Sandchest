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

describe('auth middleware', () => {
  describe('protected routes', () => {
    test('redirects unauthenticated users to /login', () => {
      const res = middleware(makeRequest('/dashboard'))
      expect(res.status).toBe(307)
      expect(new URL(res.headers.get('location')!).pathname).toBe('/login')
    })

    test('redirects unauthenticated users from nested dashboard routes', () => {
      const res = middleware(makeRequest('/dashboard/keys'))
      expect(res.status).toBe(307)
      expect(new URL(res.headers.get('location')!).pathname).toBe('/login')
    })

    test('allows authenticated users to access dashboard', () => {
      const res = middleware(makeRequest('/dashboard', SESSION_COOKIE))
      expect(res.status).toBe(200)
    })

    test('allows authenticated users to access nested dashboard routes', () => {
      const res = middleware(makeRequest('/dashboard/settings', SESSION_COOKIE))
      expect(res.status).toBe(200)
    })
  })

  describe('auth pages', () => {
    test('redirects authenticated users from /login to /dashboard', () => {
      const res = middleware(makeRequest('/login', SESSION_COOKIE))
      expect(res.status).toBe(307)
      expect(new URL(res.headers.get('location')!).pathname).toBe('/dashboard')
    })

    test('redirects authenticated users from /signup to /dashboard', () => {
      const res = middleware(makeRequest('/signup', SESSION_COOKIE))
      expect(res.status).toBe(307)
      expect(new URL(res.headers.get('location')!).pathname).toBe('/dashboard')
    })

    test('redirects authenticated users from /verify to /dashboard', () => {
      const res = middleware(makeRequest('/verify', SESSION_COOKIE))
      expect(res.status).toBe(307)
      expect(new URL(res.headers.get('location')!).pathname).toBe('/dashboard')
    })

    test('allows unauthenticated users to access /login', () => {
      const res = middleware(makeRequest('/login'))
      expect(res.status).toBe(200)
    })

    test('allows unauthenticated users to access /signup', () => {
      const res = middleware(makeRequest('/signup'))
      expect(res.status).toBe(200)
    })

    test('allows unauthenticated users to access /verify', () => {
      const res = middleware(makeRequest('/verify'))
      expect(res.status).toBe(200)
    })
  })

  describe('matcher config', () => {
    test('includes dashboard routes', () => {
      expect(config.matcher).toContain('/dashboard/:path*')
    })

    test('includes auth pages', () => {
      expect(config.matcher).toContain('/login')
      expect(config.matcher).toContain('/signup')
      expect(config.matcher).toContain('/verify')
    })
  })
})
