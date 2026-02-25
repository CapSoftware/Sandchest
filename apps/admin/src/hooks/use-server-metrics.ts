'use client'

import { useQuery } from '@tanstack/react-query'
import type { MetricsData } from '@/components/ServerMetrics'

interface ServerMetricsResponse {
  metrics: MetricsData | null
  daemon_status: string
  collected_at: string
}

async function fetchMetrics(serverId: string): Promise<ServerMetricsResponse> {
  const res = await fetch(`/api/servers/${serverId}/metrics`)
  if (!res.ok) throw new Error('Failed to fetch metrics')
  return res.json() as Promise<ServerMetricsResponse>
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
