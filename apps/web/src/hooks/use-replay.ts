'use client'

import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import type { ReplayBundle, ReplayEvent } from '@sandchest/contract'

const LIVE_POLL_MS = 3000
const EVENT_POLL_MS = 1500

/** Fetch the replay bundle with live polling when in_progress. */
export function useReplayBundle(sandboxId: string) {
  return useQuery<ReplayBundle>({
    queryKey: ['replay', sandboxId],
    queryFn: () => apiFetch<ReplayBundle>(`/v1/public/replay/${sandboxId}`),
    refetchInterval: (query) => {
      const data = query.state.data
      if (data?.status === 'in_progress') return LIVE_POLL_MS
      return false
    },
    staleTime: 5000,
    retry: 1,
  })
}

/** Fetch events from the presigned events_url, polling when live. */
export function useReplayEvents(eventsUrl: string | undefined, isLive: boolean) {
  return useQuery<ReplayEvent[]>({
    queryKey: ['replay-events', eventsUrl],
    queryFn: async () => {
      if (!eventsUrl) return []
      const res = await fetch(eventsUrl)
      if (!res.ok) return []
      const text = await res.text()
      return text
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ReplayEvent)
    },
    enabled: !!eventsUrl,
    refetchInterval: isLive ? EVENT_POLL_MS : false,
    staleTime: isLive ? 1000 : 30000,
  })
}
