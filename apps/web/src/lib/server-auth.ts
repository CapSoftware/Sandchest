import 'server-only'

import { cache } from 'react'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

const AUTH_COOKIE = 'better-auth.session_token'
const SECURE_AUTH_COOKIE = '__Secure-better-auth.session_token'

export interface ServerSession {
  session: {
    id: string
    userId: string
    activeOrganizationId: string | null
    token: string
    expiresAt: string
  }
  user: {
    id: string
    name: string
    email: string
    image: string | null
  }
}

export interface ServerOrg {
  id: string
  name: string
  slug: string
}

async function hasSessionCookie(): Promise<boolean> {
  const cookieStore = await cookies()
  return cookieStore.has(AUTH_COOKIE) || cookieStore.has(SECURE_AUTH_COOKIE)
}

async function authFetch<T>(path: string, init?: RequestInit): Promise<T | null> {
  const cookieStore = await cookies()
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ')

  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      cookie: cookieHeader,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
    cache: 'no-store',
  })

  if (!res.ok) return null
  return res.json() as Promise<T>
}

export const getSession = cache(async (): Promise<ServerSession | null> => {
  if (!(await hasSessionCookie())) return null
  return authFetch<ServerSession>('/api/auth/get-session')
})

export const getOrgs = cache(async (): Promise<ServerOrg[]> => {
  if (!(await hasSessionCookie())) return []
  const data = await authFetch<ServerOrg[]>('/api/auth/organization/list')
  return data ?? []
})

async function setActiveOrgServer(organizationId: string): Promise<void> {
  await authFetch('/api/auth/organization/set-active', {
    method: 'POST',
    body: JSON.stringify({ organizationId }),
  })
}

export async function requireDashboardAuth(orgSlug: string): Promise<{
  session: ServerSession
  orgs: ServerOrg[]
  activeOrg: ServerOrg
}> {
  const [session, orgs] = await Promise.all([getSession(), getOrgs()])

  if (!session) redirect('/login')
  if (orgs.length === 0) redirect('/onboarding')

  const urlOrg = orgs.find((o) => o.slug === orgSlug)
  if (!urlOrg) redirect('/dashboard')

  // Sync active org if it doesn't match the URL slug
  if (session.session.activeOrganizationId !== urlOrg.id) {
    await setActiveOrgServer(urlOrg.id)
    session.session.activeOrganizationId = urlOrg.id
  }

  return { session, orgs, activeOrg: urlOrg }
}
