import { requireDashboardAuth } from '@/lib/server-auth'
import DashboardSessionProvider from '@/components/DashboardSessionProvider'
import DashboardShell from '@/components/DashboardShell'

export default async function OrgDashboardLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const { session, orgs, activeOrg } = await requireDashboardAuth(orgSlug)

  return (
    <DashboardSessionProvider session={session} orgs={orgs} activeOrg={activeOrg}>
      <DashboardShell>{children}</DashboardShell>
    </DashboardSessionProvider>
  )
}
