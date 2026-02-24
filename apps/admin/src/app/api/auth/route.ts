import { NextResponse } from 'next/server'
import { validatePassword, createSessionToken, SESSION_COOKIE } from '@/lib/auth'

export async function POST(request: Request) {
  const body = await request.json() as { password?: string }
  const password = body.password

  if (typeof password !== 'string' || !validatePassword(password)) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 })
  }

  const token = await createSessionToken()
  const response = NextResponse.json({ ok: true })

  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24, // 24 hours
  })

  return response
}
