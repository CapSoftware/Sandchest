import { timingSafeEqual } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'

function getPassword(): string {
  const pw = process.env.ADMIN_PASSWORD
  if (!pw) throw new Error('Missing ADMIN_PASSWORD env var')
  return pw
}

function getSecret(): Uint8Array {
  const secret = process.env.ADMIN_SESSION_SECRET
  if (!secret || secret.length < 32) {
    throw new Error('ADMIN_SESSION_SECRET must be at least 32 characters')
  }
  return new TextEncoder().encode(secret)
}

export function validatePassword(input: string): boolean {
  const expected = getPassword()
  if (input.length !== expected.length) return false
  const a = new TextEncoder().encode(input)
  const b = new TextEncoder().encode(expected)
  return timingSafeEqual(a, b)
}

export async function createSessionToken(): Promise<string> {
  return new SignJWT({ role: 'admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(getSecret())
}

export async function verifySessionToken(token: string): Promise<boolean> {
  try {
    await jwtVerify(token, getSecret())
    return true
  } catch {
    return false
  }
}

export const SESSION_COOKIE = 'admin-session'
