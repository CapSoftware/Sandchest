'use client'

import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AutumnProvider } from 'autumn-js/react'
import { PaywallProvider } from '@/components/dashboard/PaywallDialog'

export default function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: 1,
          },
        },
      }),
  )

  return (
    <QueryClientProvider client={queryClient}>
      <AutumnProvider includeCredentials>
        <PaywallProvider>{children}</PaywallProvider>
      </AutumnProvider>
    </QueryClientProvider>
  )
}
