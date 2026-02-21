import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const AUTH_COOKIE = 'better-auth.session_token'

const PROTECTED_PREFIXES = ['/dashboard']
const AUTH_PAGES = ['/login', '/signup', '/verify']

function hasSessionCookie(request: NextRequest): boolean {
  return request.cookies.has(AUTH_COOKIE)
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const authenticated = hasSessionCookie(request)

  // Redirect unauthenticated users away from protected routes
  if (PROTECTED_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    if (!authenticated) {
      const loginUrl = request.nextUrl.clone()
      loginUrl.pathname = '/login'
      return NextResponse.redirect(loginUrl)
    }
  }

  // Redirect authenticated users away from auth pages
  if (AUTH_PAGES.some((page) => pathname === page)) {
    if (authenticated) {
      const dashboardUrl = request.nextUrl.clone()
      dashboardUrl.pathname = '/dashboard'
      return NextResponse.redirect(dashboardUrl)
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/dashboard/:path*', '/login', '/signup', '/verify'],
}
