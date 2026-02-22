import { redirect } from 'next/navigation'
import { getSession, getOrgs } from '@/lib/server-auth'

export default async function DashboardRedirect() {
  const session = await getSession()
  if (!session) redirect('/login')

  const orgs = await getOrgs()
  if (orgs.length === 0) redirect('/onboarding')

  const activeOrgId = session.session.activeOrganizationId
  const activeOrg = orgs.find((o) => o.id === activeOrgId) ?? orgs[0]
  redirect(`/dashboard/${activeOrg.slug}`)
}
