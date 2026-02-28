'use client'

import { useQuery } from '@tanstack/react-query'
import type { MetricsResult } from '@/lib/metrics'

async function fetchMetrics(serverId: string): Promise<MetricsResult> {
  const res = await fetch(`/api/servers/${serverId}/metrics`)
  if (!res.ok) throw new Error('Failed to fetch metrics')
  return res.json() as Promise<MetricsResult>
}

export function useServerMetrics(serverId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['server-metrics', serverId],
    queryFn: () => fetchMetrics(serverId),
    enabled,
    refetchInterval: 15_000,
    refetchOnWindowFocus: false,
  })
}
