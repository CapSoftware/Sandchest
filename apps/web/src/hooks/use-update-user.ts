'use client'

import { useMutation } from '@tanstack/react-query'
import { authClient } from '@/lib/auth-client'

interface UpdateUserInput {
  name: string
}

export function useUpdateUser() {
  return useMutation({
    mutationFn: async ({ name }: UpdateUserInput) => {
      const { error } = await authClient.updateUser({ name })
      if (error) throw new Error(error.message ?? 'Failed to update profile')
    },
  })
}
