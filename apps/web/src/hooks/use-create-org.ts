'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { authClient } from '@/lib/auth-client'

interface CreateOrgInput {
  name: string
  slug: string
}

export function useCreateOrg() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ name, slug }: CreateOrgInput) => {
      const { data, error } = await authClient.organization.create({
        name,
        slug,
      })
      if (error)
        throw new Error(error.message ?? 'Failed to create organization')

      await authClient.organization.setActive({ organizationId: data.id })

      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['orgs'] })
    },
  })
}
