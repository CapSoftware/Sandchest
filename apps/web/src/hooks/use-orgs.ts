'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { authClient } from '@/lib/auth-client'

interface Org {
  id: string
  name: string
  slug: string
}

export function useOrgs() {
  return useQuery({
    queryKey: ['orgs'],
    queryFn: async (): Promise<Org[]> => {
      const { data, error } = await authClient.organization.list()
      if (error) throw new Error(error.message ?? 'Failed to list organizations')
      return (data ?? []) as Org[]
    },
  })
}

export function useSetActiveOrg() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (organizationId: string) => {
      const { error } = await authClient.organization.setActive({
        organizationId,
      })
      if (error) throw new Error(error.message ?? 'Failed to switch organization')
    },
    onSuccess: () => {
      queryClient.invalidateQueries()
    },
  })
}
