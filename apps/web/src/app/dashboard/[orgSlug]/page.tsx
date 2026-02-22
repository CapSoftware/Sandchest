import type { Metadata } from 'next'
import SandboxList from '@/components/dashboard/SandboxList'

export const metadata: Metadata = {
  title: 'Sandboxes — Sandchest',
}

export default function DashboardPage() {
  return <SandboxList />
}
