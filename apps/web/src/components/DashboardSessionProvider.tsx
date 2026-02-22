'use client'

import { createContext, useContext, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { authClient } from '@/lib/auth-client'
import type { ServerSession, ServerOrg } from '@/lib/server-auth'

interface DashboardSessionContextValue {
  session: ServerSession
  orgs: ServerOrg[]
  activeOrg: ServerOrg
  refresh: () => void
}

const DashboardSessionContext = createContext<DashboardSessionContextValue | null>(null)

export function useDashboardSession(): DashboardSessionContextValue {
  const ctx = useContext(DashboardSessionContext)
  if (!ctx) {
    throw new Error('useDashboardSession must be used within a DashboardSessionProvider')
  }
  return ctx
}

export default function DashboardSessionProvider({
  session,
  orgs,
  activeOrg,
  children,
}: {
  session: ServerSession
  orgs: ServerOrg[]
  activeOrg: ServerOrg
  children: React.ReactNode
}) {
  const router = useRouter()

  // Check session validity every 5 minutes — external system sync (valid useEffect)
  useEffect(() => {
    const interval = setInterval(async () => {
      const { data } = await authClient.getSession()
      if (!data) {
        window.location.href = '/login'
      }
    }, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [])

  return (
    <DashboardSessionContext.Provider
      value={{
        session,
        orgs,
        activeOrg,
        refresh: () => router.refresh(),
      }}
    >
      {children}
    </DashboardSessionContext.Provider>
  )
}
