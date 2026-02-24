'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { StepResult } from '@/lib/provisioner'

interface ProvisionState {
  status: 'pending' | 'provisioning' | 'completed' | 'failed'
  current_step: string | null
  steps: StepResult[] | null
  error: string | null
}

export function useProvision(serverId: string, active: boolean) {
  const [state, setState] = useState<ProvisionState | null>(null)
  const [connected, setConnected] = useState(false)
  const sourceRef = useRef<EventSource | null>(null)

  const connect = useCallback(() => {
    if (!active) return

    const source = new EventSource(`/api/provision/${serverId}/stream`)
    sourceRef.current = source

    source.onopen = () => setConnected(true)

    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as ProvisionState
        setState(data)

        if (data.status === 'completed' || data.status === 'failed') {
          source.close()
          setConnected(false)
        }
      } catch {
        // Ignore parse errors
      }
    }

    source.onerror = () => {
      source.close()
      setConnected(false)
    }
  }, [serverId, active])

  useEffect(() => {
    connect()
    return () => {
      sourceRef.current?.close()
    }
  }, [connect])

  return { state, connected }
}
