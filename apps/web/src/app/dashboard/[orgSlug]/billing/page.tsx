import type { Metadata } from 'next'
import BillingManagement from '@/components/dashboard/BillingManagement'

export const metadata: Metadata = {
  title: 'Billing — Sandchest',
}

export default function BillingPage() {
  return <BillingManagement />
}
