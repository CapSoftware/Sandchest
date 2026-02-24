'use client'

import { useQuery } from '@tanstack/react-query'

export interface ServerDetail {
  id: string
  name: string
  ip: string
  ssh_port: number
  ssh_user: string
  provision_status: 'pending' | 'provisioning' | 'completed' | 'failed'
  provision_step: string | null
  provision_error: string | null
  provision_steps: Array<{ id: string; status: string; output?: string | undefined }> | null
  slots_total: number
  system_info: {
    cpu?: string | undefined
    ram?: string | undefined
    disk?: string | undefined
    os?: string | undefined
  } | null
  node_id: string | null
  created_at: string
  updated_at: string
}

async function fetchServer(serverId: string): Promise<ServerDetail> {
  const res = await fetch(`/api/servers/${serverId}`)
  if (!res.ok) throw new Error('Failed to fetch server')
  return res.json() as Promise<ServerDetail>
}

export function useServer(serverId: string) {
  return useQuery({
    queryKey: ['server', serverId],
    queryFn: () => fetchServer(serverId),
    refetchInterval: 15_000,
  })
}
