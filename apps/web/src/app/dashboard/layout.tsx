import DashboardBillingProviders from '@/components/dashboard/DashboardBillingProviders'

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <DashboardBillingProviders>{children}</DashboardBillingProviders>
}
