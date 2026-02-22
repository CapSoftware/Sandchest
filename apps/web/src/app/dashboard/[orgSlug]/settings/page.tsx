import type { Metadata } from 'next'
import OrgSettings from '@/components/dashboard/OrgSettings'

export const metadata: Metadata = {
  title: 'Settings — Sandchest',
}

export default function SettingsPage() {
  return <OrgSettings />
}
