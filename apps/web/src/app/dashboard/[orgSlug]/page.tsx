import type { Metadata } from 'next'
import UsageOverview from '@/components/dashboard/UsageOverview'
import SandboxList from '@/components/dashboard/SandboxList'

export const metadata: Metadata = {
  title: 'Sandboxes — Sandchest',
}

export default function DashboardPage() {
  return (
    <>
      <UsageOverview />
      <SandboxList />
    </>
  )
}
