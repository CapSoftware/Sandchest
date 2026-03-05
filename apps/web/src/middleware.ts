import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const AUTH_COOKIE = 'better-auth.session_token'
const SECURE_AUTH_COOKIE = '__Secure-better-auth.session_token'

const PROTECTED_PREFIXES = ['/dashboard', '/onboarding']

function hasSessionCookie(request: NextRequest): boolean {
  return request.cookies.has(AUTH_COOKIE) || request.cookies.has(SECURE_AUTH_COOKIE)
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Redirect unauthenticated users away from protected routes
  if (PROTECTED_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    if (!hasSessionCookie(request)) {
      const loginUrl = request.nextUrl.clone()
      loginUrl.pathname = '/login'
      return NextResponse.redirect(loginUrl)
    }
  }

  // Auth pages (/login, /signup, /verify) handle their own redirect logic
  // server-side via getSession() to avoid loops when cookies outlive sessions.

  return NextResponse.next()
}

export const config = {
  matcher: ['/dashboard/:path*', '/onboarding'],
}
