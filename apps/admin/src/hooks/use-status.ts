'use client'

import { useQuery } from '@tanstack/react-query'

export interface SystemStatus {
  api: {
    status: 'ok' | 'error' | 'unreachable'
    uptime_seconds: number
    version: string
    draining: boolean
  }
  redis: {
    status: 'ok' | 'fail' | 'unknown'
  }
  workers: Array<{
    name: string
    active: boolean
    ttl_ms: number
  }>
  nodes: Array<{
    id: string
    status: string
    heartbeat_active: boolean
  }>
  error?: string
}

async function fetchStatus(): Promise<SystemStatus> {
  const res = await fetch('/api/status')
  if (!res.ok) throw new Error('Failed to fetch status')
  return res.json() as Promise<SystemStatus>
}

export function useStatus() {
  return useQuery({
    queryKey: ['system-status'],
    queryFn: fetchStatus,
    refetchInterval: 15_000,
  })
}
