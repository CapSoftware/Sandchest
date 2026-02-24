'use client'

import { AutumnProvider } from 'autumn-js/react'

export default function OnboardingBillingProvider({
  children,
}: {
  children: React.ReactNode
}) {
  return <AutumnProvider includeCredentials>{children}</AutumnProvider>
}
