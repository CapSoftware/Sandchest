'use client'

import { useQuery } from '@tanstack/react-query'

export interface SandboxSummary {
  id: string
  status: string
  profile_name: string
  org_id: string
  started_at: string | null
  last_activity_at: string | null
  ttl_seconds: number
  created_at: string
}

interface SandboxesResponse {
  sandboxes: SandboxSummary[]
  count: number
}

async function fetchSandboxes(serverId: string): Promise<SandboxesResponse> {
  const res = await fetch(`/api/servers/${serverId}/sandboxes`)
  if (!res.ok) throw new Error('Failed to fetch sandboxes')
  return res.json() as Promise<SandboxesResponse>
}

export function useServerSandboxes(serverId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['server-sandboxes', serverId],
    queryFn: () => fetchSandboxes(serverId),
    enabled,
    refetchInterval: 10_000,
    refetchOnWindowFocus: false,
  })
}
