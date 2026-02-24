'use client'

import { useQuery } from '@tanstack/react-query'
import type { ServerSummary } from '@/components/ServerCard'

async function fetchServers(): Promise<ServerSummary[]> {
  const res = await fetch('/api/servers')
  if (!res.ok) throw new Error('Failed to fetch servers')
  const data = await res.json() as { servers: ServerSummary[] }
  return data.servers
}

export function useServers() {
  return useQuery({
    queryKey: ['servers'],
    queryFn: fetchServers,
    refetchInterval: 10_000,
  })
}
