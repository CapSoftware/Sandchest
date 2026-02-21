'use client'

import {
  useMutation,
  useQueryClient,
  useInfiniteQuery,
} from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import type {
  SandboxStatus,
  SandboxSummary,
  ListSandboxesResponse,
  StopSandboxResponse,
} from '@sandchest/contract'

export const sandboxKeys = {
  all: ['sandboxes'] as const,
  lists: () => [...sandboxKeys.all, 'list'] as const,
  list: (status: SandboxStatus | '') =>
    [...sandboxKeys.lists(), status] as const,
}

export function useSandboxes(status: SandboxStatus | '') {
  return useInfiniteQuery({
    queryKey: sandboxKeys.list(status),
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams()
      if (status) params.set('status', status)
      if (pageParam) params.set('cursor', pageParam)
      params.set('limit', '20')

      const query = params.toString()
      return apiFetch<ListSandboxesResponse>(
        `/v1/sandboxes${query ? `?${query}` : ''}`,
      )
    },
    initialPageParam: '' as string,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
  })
}

export function useStopSandbox() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (sandboxId: string) => {
      return apiFetch<StopSandboxResponse>(
        `/v1/sandboxes/${sandboxId}/stop`,
        { method: 'POST' },
      )
    },
    onMutate: async (sandboxId) => {
      await queryClient.cancelQueries({ queryKey: sandboxKeys.lists() })

      const previousData = queryClient.getQueriesData<{
        pages: ListSandboxesResponse[]
        pageParams: string[]
      }>({ queryKey: sandboxKeys.lists() })

      queryClient.setQueriesData<{
        pages: ListSandboxesResponse[]
        pageParams: string[]
      }>({ queryKey: sandboxKeys.lists() }, (old) => {
        if (!old) return old
        return {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            sandboxes: page.sandboxes.map((sb: SandboxSummary) =>
              sb.sandbox_id === sandboxId
                ? { ...sb, status: 'stopping' as const }
                : sb,
            ),
          })),
        }
      })

      return { previousData }
    },
    onError: (_err, _sandboxId, context) => {
      if (context?.previousData) {
        for (const [key, data] of context.previousData) {
          queryClient.setQueryData(key, data)
        }
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: sandboxKeys.lists() })
    },
  })
}
