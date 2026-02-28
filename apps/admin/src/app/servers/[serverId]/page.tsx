'use client'

import { use } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServer } from '@/hooks/use-server'
import { useServerMetrics } from '@/hooks/use-server-metrics'
import { deriveStatus } from '@/lib/derive-status'
import StatusBadge from '@/components/StatusBadge'
import ServerMetrics from '@/components/ServerMetrics'
import CommandRunner from '@/components/CommandRunner'

function DetailSkeleton() {
  return (
    <div>
      <div style={{ marginBottom: '1.5rem' }}>
        <div className="skeleton skeleton-text" style={{ width: '6rem', height: '0.75rem' }} />
      </div>

      <div className="page-header">
        <div>
          <div className="skeleton skeleton-text" style={{ width: '10rem', height: '1.25rem' }} />
          <div className="skeleton skeleton-text" style={{ width: '7rem', height: '0.8125rem', marginTop: '0.375rem' }} />
        </div>
        <div className="skeleton skeleton-badge" />
      </div>

      {/* System Info skeleton */}
      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="skeleton skeleton-text" style={{ width: '5rem', height: '0.8125rem', marginBottom: '0.75rem' }} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
          <div className="skeleton skeleton-text" style={{ width: '80%', height: '0.75rem' }} />
          <div className="skeleton skeleton-text" style={{ width: '60%', height: '0.75rem' }} />
          <div className="skeleton skeleton-text" style={{ width: '70%', height: '0.75rem' }} />
          <div className="skeleton skeleton-text" style={{ width: '50%', height: '0.75rem' }} />
        </div>
      </div>

      {/* Metrics skeleton */}
      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="skeleton skeleton-text" style={{ width: '6rem', height: '0.8125rem', marginBottom: '1rem' }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {[1, 2, 3].map((i) => (
            <div key={i} className="metric-bar-container">
              <div className="metric-bar-label">
                <span className="skeleton skeleton-text" style={{ width: '2.5rem' }} />
                <span className="skeleton skeleton-text" style={{ width: '3rem' }} />
              </div>
              <div className="metric-bar-track">
                <div className="skeleton" style={{ height: '100%', width: '100%', borderRadius: '3px' }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function ServerDetailPage({
  params,
}: {
  params: Promise<{ serverId: string }>
}) {
  const { serverId } = use(params)
  const router = useRouter()
  const queryClient = useQueryClient()
  const { data: server, isLoading } = useServer(serverId)
  const isProvisioned = server?.provision_status === 'completed'
  const { data: metricsData } = useServerMetrics(serverId, isProvisioned)

  const status = server
    ? deriveStatus(server.provision_status, server.node_id, metricsData?.daemon_status)
    : 'pending'

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/servers/${serverId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete')
    },
    onSuccess: () => {
      router.push('/servers')
    },
  })

  const provisionMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/provision/${serverId}/start`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed to start provisioning')
    },
    onSuccess: () => {
      router.push(`/servers/${serverId}/provision`)
    },
  })

  const deployMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/servers/${serverId}/deploy-daemon`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Deploy failed' })) as { error: string }
        throw new Error(data.error)
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['server', serverId] })
    },
  })

  const actionMutation = useMutation({
    mutationFn: async (action: string) => {
      if (!server?.node_id) throw new Error('No node linked')
      const res = await fetch(`/api/servers/${serverId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      if (!res.ok) throw new Error('Action failed')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['server', serverId] })
    },
  })

  if (isLoading || !server) {
    return <DetailSkeleton />
  }

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: '1.5rem' }}>
        <Link href="/servers" className="back-link">
          &larr; Back to servers
        </Link>
      </div>

      <div className="page-header">
        <div>
          <h1 className="page-title">{server.name}</h1>
          <div className="detail-subtitle">
            {server.ip}:{server.ssh_port}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <StatusBadge status={status} />

          {server.provision_status === 'pending' && (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => provisionMutation.mutate()}
              disabled={provisionMutation.isPending}
            >
              Provision
            </button>
          )}
          {server.provision_status === 'failed' && (
            <Link href={`/servers/${serverId}/provision`} className="btn btn-sm">
              View Logs
            </Link>
          )}
          {server.provision_status === 'provisioning' && (
            <Link href={`/servers/${serverId}/provision`} className="btn btn-sm">
              View Progress
            </Link>
          )}
          {server.provision_status === 'completed' && !server.node_id && (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => deployMutation.mutate()}
              disabled={deployMutation.isPending}
            >
              {deployMutation.isPending ? <><span className="spinner" style={{ width: '0.75rem', height: '0.75rem', marginRight: '0.375rem' }} /> Deploying…</> : 'Deploy Daemon'}
            </button>
          )}
        </div>
      </div>

      {/* Deploy feedback */}
      {deployMutation.isError && (
        <div className="card feedback-card feedback-danger" style={{ marginBottom: '1rem' }}>
          Deploy failed: {deployMutation.error.message}
        </div>
      )}
      {deployMutation.isSuccess && (
        <div className="card feedback-card feedback-success" style={{ marginBottom: '1rem' }}>
          Daemon deployed successfully. Waiting for heartbeat…
        </div>
      )}

      {/* System Info */}
      {server.system_info && (
        <div className="card" style={{ marginBottom: '1rem' }}>
          <div className="card-section-title">System Info</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', fontSize: '0.75rem' }}>
            {server.system_info.cpu && <div><span className="text-weak">CPU:</span> {server.system_info.cpu}</div>}
            {server.system_info.ram && <div><span className="text-weak">RAM:</span> {server.system_info.ram}</div>}
            {server.system_info.disk && <div><span className="text-weak">Disk:</span> {server.system_info.disk}</div>}
            {server.system_info.os && <div><span className="text-weak">OS:</span> {server.system_info.os}</div>}
          </div>
        </div>
      )}

      {/* Live Metrics */}
      <div style={{ marginBottom: '1rem' }}>
        <ServerMetrics metrics={metricsData?.metrics ?? null} />
      </div>

      {/* Command Runner */}
      {server.provision_status === 'completed' && (
        <div style={{ marginBottom: '1rem' }}>
          <CommandRunner serverId={serverId} />
        </div>
      )}

      {/* Actions */}
      {server.provision_status === 'completed' && server.node_id && (
        <div className="card" style={{ marginBottom: '1rem' }}>
          <div className="card-section-title" style={{ marginBottom: '0.75rem' }}>
            Node Actions
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button
              className="btn btn-sm"
              onClick={() => actionMutation.mutate('drain')}
              disabled={actionMutation.isPending}
            >
              Drain
            </button>
            <button
              className="btn btn-sm"
              onClick={() => actionMutation.mutate('disable')}
              disabled={actionMutation.isPending}
            >
              Disable
            </button>
            <button
              className="btn btn-sm"
              onClick={() => actionMutation.mutate('enable')}
              disabled={actionMutation.isPending}
            >
              Enable
            </button>
          </div>
        </div>
      )}

      {/* Danger Zone */}
      <div className="card danger-zone">
        <div className="card-section-title danger-title" style={{ marginBottom: '0.75rem' }}>
          Danger Zone
        </div>
        <button
          className="btn btn-danger btn-sm"
          onClick={() => {
            if (confirm(`Delete server "${server.name}"? This cannot be undone.`)) {
              deleteMutation.mutate()
            }
          }}
          disabled={deleteMutation.isPending}
        >
          Remove Server
        </button>
      </div>
    </div>
  )
}
