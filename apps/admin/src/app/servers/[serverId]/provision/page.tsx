'use client'

import { use } from 'react'
import Link from 'next/link'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServer } from '@/hooks/use-server'
import { useProvision } from '@/hooks/use-provision'
import StatusBadge from '@/components/StatusBadge'
import ProvisionSteps from '@/components/ProvisionSteps'

export default function ProvisionPage({
  params,
}: {
  params: Promise<{ serverId: string }>
}) {
  const { serverId } = use(params)
  const queryClient = useQueryClient()
  const { data: server } = useServer(serverId)

  const isActive = server?.provision_status === 'provisioning'
  const { state } = useProvision(serverId, isActive)

  const retryMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/provision/${serverId}/retry`, { method: 'POST' })
      if (!res.ok) throw new Error('Retry failed')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['server', serverId] })
    },
  })

  const reprovisionMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/provision/${serverId}/start`, { method: 'POST' })
      if (!res.ok) throw new Error('Reprovision failed')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['server', serverId] })
    },
  })

  // Use SSE state if streaming, otherwise fall back to server data
  const steps = (state?.steps ?? server?.provision_steps ?? null) as Array<{ id: string; status: string; output?: string | undefined }> | null
  const status = state?.status ?? server?.provision_status ?? 'pending'
  const error = state?.error ?? server?.provision_error

  return (
    <div>
      <div style={{ marginBottom: '1.5rem' }}>
        <Link href={`/servers/${serverId}`} style={{ fontSize: '0.75rem', color: 'var(--color-text-weak)' }}>
          &larr; Back to server
        </Link>
      </div>

      <div className="page-header">
        <div>
          <h1 className="page-title">Provisioning</h1>
          {server && (
            <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-weak)', marginTop: '0.25rem' }}>
              {server.name} ({server.ip})
            </div>
          )}
        </div>
        <StatusBadge status={status} />
      </div>

      {error && (
        <div
          className="card"
          style={{
            marginBottom: '1rem',
            borderColor: 'color-mix(in srgb, var(--color-danger), transparent 70%)',
            color: 'var(--color-danger)',
            fontSize: '0.8125rem',
          }}
        >
          {error}
        </div>
      )}

      <ProvisionSteps
        steps={steps}
        onRetry={status === 'failed' ? () => retryMutation.mutate() : undefined}
        retrying={retryMutation.isPending}
      />

      {status === 'failed' && (
        <div style={{ marginTop: '1rem' }}>
          <button
            className="btn"
            onClick={() => reprovisionMutation.mutate()}
            disabled={reprovisionMutation.isPending}
          >
            {reprovisionMutation.isPending ? <><span className="spinner" /> Reprovisioning...</> : 'Reprovision from scratch'}
          </button>
        </div>
      )}

      {status === 'completed' && (
        <div style={{ marginTop: '1.5rem' }}>
          <Link href={`/servers/${serverId}`} className="btn btn-primary">
            View Server
          </Link>
        </div>
      )}
    </div>
  )
}
