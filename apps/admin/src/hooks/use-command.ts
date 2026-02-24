'use client'

import { useMutation } from '@tanstack/react-query'

interface CommandResult {
  stdout: string
  stderr: string
  exit_code: number
  duration_ms: number
}

export function useCommand(serverId: string) {
  return useMutation({
    mutationFn: async (command: string): Promise<CommandResult> => {
      const res = await fetch(`/api/command/${serverId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      })
      if (!res.ok) throw new Error('Failed to execute command')
      return res.json() as Promise<CommandResult>
    },
  })
}
