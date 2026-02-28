'use client'

import { useQuery } from '@tanstack/react-query'
import type { MetricsResult } from '@/lib/metrics'

async function fetchServersMetrics(): Promise<Record<string, MetricsResult>> {
  const res = await fetch('/api/servers/metrics')
  if (!res.ok) throw new Error('Failed to fetch metrics')
  const data = await res.json() as { metrics: Record<string, MetricsResult> }
  return data.metrics
}

export function useServersMetrics(enabled: boolean) {
  return useQuery({
    queryKey: ['servers-metrics'],
    queryFn: fetchServersMetrics,
    enabled,
    refetchInterval: 15_000,
    refetchOnWindowFocus: false,
  })
}
