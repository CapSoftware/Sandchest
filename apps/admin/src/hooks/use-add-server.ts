'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'

interface AddServerInput {
  name: string
  ip: string
  ssh_port: number
  ssh_user: string
  ssh_key?: string | undefined
  ssh_password?: string | undefined
  slots_total: number
}

async function addServer(input: AddServerInput): Promise<{ id: string }> {
  const res = await fetch('/api/servers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: 'Failed to add server' })) as { error: string }
    throw new Error(data.error)
  }
  return res.json() as Promise<{ id: string }>
}

export function useAddServer() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: addServer,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['servers'] })
    },
  })
}
