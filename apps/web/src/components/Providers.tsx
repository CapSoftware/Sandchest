'use client'

import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from '@/lib/api'

function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401
}

export default function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: (failureCount, error) => {
              if (isUnauthorized(error)) return false
              return failureCount < 1
            },
          },
          mutations: {
            onError: (error) => {
              if (isUnauthorized(error) && typeof window !== 'undefined') {
                window.location.href = '/login'
              }
            },
          },
        },
      }),
  )

  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  )
}
