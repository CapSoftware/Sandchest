'use client'

import { AutumnProvider } from 'autumn-js/react'
import { PaywallProvider } from '@/components/dashboard/PaywallDialog'

export default function DashboardBillingProviders({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <AutumnProvider includeCredentials>
      <PaywallProvider>{children}</PaywallProvider>
    </AutumnProvider>
  )
}
