import 'server-only'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

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

export async function getSession(): Promise<ServerSession | null> {
  return authFetch<ServerSession>('/api/auth/get-session')
}

export async function getOrgs(): Promise<ServerOrg[]> {
  const data = await authFetch<ServerOrg[]>('/api/auth/organization/list')
  return data ?? []
}

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
