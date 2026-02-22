import DashboardShell from '@/components/DashboardShell'

export default function OrgDashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <DashboardShell>{children}</DashboardShell>
}
