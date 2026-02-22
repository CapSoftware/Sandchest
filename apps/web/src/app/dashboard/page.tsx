'use client'

import { useRouter } from 'next/navigation'
import { useSession } from '@/hooks/use-session'
import { useOrgs } from '@/hooks/use-orgs'

export default function DashboardRedirect() {
  const router = useRouter()
  const { data: session, isPending: sessionLoading } = useSession()
  const { data: orgs, isPending: orgsLoading } = useOrgs()

  if (sessionLoading || orgsLoading) return null

  if (!orgs || orgs.length === 0) {
    router.replace('/onboarding')
    return null
  }

  const activeOrgId = session?.session.activeOrganizationId
  const activeOrg = orgs.find((o) => o.id === activeOrgId) ?? orgs[0]

  router.replace(`/dashboard/${activeOrg.slug}`)
  return null
}
