'use client'

import { useQuery } from '@tanstack/react-query'

async function fetchServersSandboxes(): Promise<Record<string, number>> {
  const res = await fetch('/api/servers/sandboxes')
  if (!res.ok) throw new Error('Failed to fetch sandbox counts')
  const data = await res.json() as { counts: Record<string, number> }
  return data.counts
}

export function useServersSandboxes(enabled: boolean) {
  return useQuery({
    queryKey: ['servers-sandboxes'],
    queryFn: fetchServersSandboxes,
    enabled,
    refetchInterval: 10_000,
    refetchOnWindowFocus: false,
  })
}
