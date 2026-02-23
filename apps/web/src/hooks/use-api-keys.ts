'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { authClient } from '@/lib/auth-client'

interface ApiKey {
  id: string
  name: string | null
  start: string | null
  createdAt: Date
}

const apiKeyKeys = {
  all: ['apiKeys'] as const,
  list: () => [...apiKeyKeys.all, 'list'] as const,
}

export function useApiKeys() {
  return useQuery({
    queryKey: apiKeyKeys.list(),
    queryFn: async (): Promise<ApiKey[]> => {
      const { data, error } = await authClient.apiKey.list()
      if (error) throw new Error(error.message ?? 'Failed to load API keys')
      return (data ?? []) as ApiKey[]
    },
  })
}

export function useCreateApiKey() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (name: string | undefined) => {
      const { data, error } = await authClient.apiKey.create({
        name: name || undefined,
      })
      if (error) throw new Error(error.message ?? 'Failed to create API key')
      return data as { key: string } | null
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: apiKeyKeys.list() })
    },
  })
}

export function useRevokeApiKey() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (keyId: string) => {
      const { error } = await authClient.apiKey.delete({ keyId })
      if (error) throw new Error(error.message ?? 'Failed to revoke API key')
    },
    onMutate: async (keyId) => {
      await queryClient.cancelQueries({ queryKey: apiKeyKeys.list() })

      const previousKeys = queryClient.getQueryData<ApiKey[]>(
        apiKeyKeys.list(),
      )

      queryClient.setQueryData<ApiKey[]>(apiKeyKeys.list(), (old) =>
        old ? old.filter((k) => k.id !== keyId) : old,
      )

      return { previousKeys }
    },
    onError: (_err, _keyId, context) => {
      if (context?.previousKeys) {
        queryClient.setQueryData(apiKeyKeys.list(), context.previousKeys)
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: apiKeyKeys.list() })
    },
  })
}
