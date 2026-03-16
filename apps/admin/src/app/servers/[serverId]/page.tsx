'use client'

import { use, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServer } from '@/hooks/use-server'
import { useServerMetrics } from '@/hooks/use-server-metrics'
import { useServerSandboxes } from '@/hooks/use-server-sandboxes'
import { deriveStatus } from '@/lib/derive-status'
import StatusBadge from '@/components/StatusBadge'
import ServerMetrics from '@/components/ServerMetrics'
import SandboxTable from '@/components/SandboxTable'
import CommandRunner from '@/components/CommandRunner'

const codeBlockStyle: React.CSSProperties = {
  marginTop: '0.75rem',
  fontSize: '0.6875rem',
  lineHeight: 1.5,
  background: 'var(--bg-inset)',
  padding: '0.75rem',
  borderRadius: '6px',
  overflow: 'auto',
  maxHeight: '24rem',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
}

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
  const { data: metricsData, isLoading: metricsLoading } = useServerMetrics(serverId, isProvisioned)
  const { data: sandboxData, isLoading: sandboxLoading } = useServerSandboxes(serverId, isProvisioned)

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

  const reinstallMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/servers/${serverId}/reinstall`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Reinstall failed' })) as { error: string }
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

  const destroyAllVmsMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/servers/${serverId}/destroy-all-vms`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed to destroy VMs' })) as { error: string }
        throw new Error(data.error)
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['server', serverId] })
      queryClient.invalidateQueries({ queryKey: ['server-sandboxes', serverId] })
      queryClient.invalidateQueries({ queryKey: ['server-metrics', serverId] })
    },
  })

  const [mtlsResult, setMtlsResult] = useState<{ flySecretsSet: boolean; flyCommand?: string; flyError?: string } | null>(null)
  const [diagOutput, setDiagOutput] = useState<string | null>(null)
  const [logsOutput, setLogsOutput] = useState<string | null>(null)

  const diagnoseMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/servers/${serverId}/diagnose-vm`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Diagnostic failed' })) as { error: string }
        throw new Error(data.error)
      }
      return res.json() as Promise<{ output: string; exitCode: number }>
    },
    onSuccess: (data) => {
      setDiagOutput(data.output)
    },
  })

  const logsMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/servers/${serverId}/diagnose-vm/logs?lines=100`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed to fetch logs' })) as { error: string }
        throw new Error(data.error)
      }
      return res.json() as Promise<{ output: string; exitCode: number }>
    },
    onSuccess: (data) => {
      setLogsOutput(data.output)
    },
  })

  const mtlsMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/servers/${serverId}/setup-mtls`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'mTLS setup failed' })) as { error: string }
        throw new Error(data.error)
      }
      return res.json() as Promise<{ success: boolean; flySecretsSet: boolean; flyCommand?: string; flyError?: string }>
    },
    onSuccess: (data) => {
      setMtlsResult(data)
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
            <>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => provisionMutation.mutate()}
                disabled={provisionMutation.isPending}
              >
                {provisionMutation.isPending ? <><span className="spinner" style={{ width: '0.75rem', height: '0.75rem', marginRight: '0.375rem' }} /> Provisioning…</> : 'Re-provision'}
              </button>
              <Link href={`/servers/${serverId}/provision`} className="btn btn-sm">
                View Logs
              </Link>
            </>
          )}
          {server.provision_status === 'provisioning' && (
            <>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => provisionMutation.mutate()}
                disabled={provisionMutation.isPending}
              >
                {provisionMutation.isPending ? <><span className="spinner" style={{ width: '0.75rem', height: '0.75rem', marginRight: '0.375rem' }} /> Provisioning…</> : 'Re-provision'}
              </button>
              <Link href={`/servers/${serverId}/provision`} className="btn btn-sm">
                View Progress
              </Link>
            </>
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
          Daemon and images updated. Waiting for heartbeat…
        </div>
      )}

      {/* Reinstall feedback */}
      {reinstallMutation.isError && (
        <div className="card feedback-card feedback-danger" style={{ marginBottom: '1rem' }}>
          Reinstall failed: {reinstallMutation.error.message}
        </div>
      )}
      {reinstallMutation.isSuccess && (
        <div className="card feedback-card feedback-success" style={{ marginBottom: '1rem' }}>
          Reinstall started. This takes ~10 minutes (rescue → install → reboot → key setup). Refresh the page to check progress.
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
      {isProvisioned && (
        <div style={{ marginBottom: '1rem' }}>
          <ServerMetrics
            metrics={metricsData?.metrics ?? null}
            loading={metricsLoading}
            reason={metricsData?.reason}
          />
        </div>
      )}

      {/* Live VMs */}
      {isProvisioned && (
        <div style={{ marginBottom: '1rem' }}>
          <SandboxTable
            sandboxes={sandboxData?.sandboxes ?? []}
            loading={sandboxLoading}
          />
        </div>
      )}

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
              className="btn btn-primary btn-sm"
              onClick={() => deployMutation.mutate()}
              disabled={deployMutation.isPending}
            >
              {deployMutation.isPending ? <><span className="spinner" style={{ width: '0.75rem', height: '0.75rem', marginRight: '0.375rem' }} /> Deploying…</> : 'Redeploy Daemon'}
            </button>
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
            <button
              className="btn btn-danger btn-sm"
              onClick={() => {
                if (confirm('Destroy ALL VMs on this server? This will kill every Firecracker process and clean up all sandbox data.')) {
                  destroyAllVmsMutation.mutate()
                }
              }}
              disabled={destroyAllVmsMutation.isPending}
            >
              {destroyAllVmsMutation.isPending ? <><span className="spinner" style={{ width: '0.75rem', height: '0.75rem', marginRight: '0.375rem' }} /> Destroying…</> : 'Destroy All VMs'}
            </button>
          </div>
          {destroyAllVmsMutation.isError && (
            <div className="feedback-card feedback-danger" style={{ marginTop: '0.75rem' }}>
              {destroyAllVmsMutation.error.message}
            </div>
          )}
          {destroyAllVmsMutation.isSuccess && (
            <div className="feedback-card feedback-success" style={{ marginTop: '0.75rem' }}>
              All VMs destroyed and daemon restarted.
            </div>
          )}
        </div>
      )}

      {/* mTLS Certificates */}
      {server.provision_status === 'completed' && (
        <div className="card" style={{ marginBottom: '1rem' }}>
          <div className="card-section-title" style={{ marginBottom: '0.75rem' }}>
            mTLS Certificates
          </div>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-weak)', marginBottom: '0.75rem' }}>
            Generate mTLS certificates for secure API-to-node gRPC communication.
          </p>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => {
              if (confirm('Generate new mTLS certificates? This will overwrite any existing certs and restart the daemon.')) {
                mtlsMutation.mutate()
              }
            }}
            disabled={mtlsMutation.isPending}
          >
            {mtlsMutation.isPending ? <><span className="spinner" style={{ width: '0.75rem', height: '0.75rem', marginRight: '0.375rem' }} /> Setting up mTLS…</> : 'Setup mTLS'}
          </button>
          {mtlsMutation.isError && (
            <div className="feedback-card feedback-danger" style={{ marginTop: '0.75rem' }}>
              mTLS setup failed: {mtlsMutation.error.message}
            </div>
          )}
          {mtlsResult && (
            <div style={{ marginTop: '0.75rem' }}>
              {mtlsResult.flySecretsSet ? (
                <div className="feedback-card feedback-success">
                  mTLS certificates generated, daemon restarted, and Fly secrets updated.
                </div>
              ) : (
                <>
                  <div className="feedback-card feedback-warning" style={{ marginBottom: '0.5rem' }}>
                    {mtlsResult.flyError
                      ? `mTLS certs generated but Fly secrets failed: ${mtlsResult.flyError}. Set them manually:`
                      : 'mTLS certs generated. No FLY_ACCESS_TOKEN configured — set Fly secrets manually:'}
                  </div>
                  {mtlsResult.flyCommand && (
                    <pre style={{
                      fontSize: '0.6875rem',
                      background: 'var(--bg-inset)',
                      padding: '0.75rem',
                      borderRadius: '6px',
                      overflow: 'auto',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                      userSelect: 'all',
                    }}>
                      {mtlsResult.flyCommand}
                    </pre>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Diagnostics */}
      {server.provision_status === 'completed' && server.node_id && (
        <div className="card" style={{ marginBottom: '1rem' }}>
          <div className="card-section-title" style={{ marginBottom: '0.75rem' }}>
            Diagnostics
          </div>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-weak)', marginBottom: '0.75rem' }}>
            Debug sandbox creation issues. &ldquo;Boot Test&rdquo; launches an unjailed Firecracker VM and captures the serial console to reveal kernel panics, overlay-init failures, and guest agent crashes.
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button
              className="btn btn-sm"
              onClick={() => { setDiagOutput(null); diagnoseMutation.mutate() }}
              disabled={diagnoseMutation.isPending}
            >
              {diagnoseMutation.isPending ? <><span className="spinner" style={{ width: '0.75rem', height: '0.75rem', marginRight: '0.375rem' }} /> Booting VM…</> : 'Boot Test'}
            </button>
            <button
              className="btn btn-sm"
              onClick={() => { setLogsOutput(null); logsMutation.mutate() }}
              disabled={logsMutation.isPending}
            >
              {logsMutation.isPending ? <><span className="spinner" style={{ width: '0.75rem', height: '0.75rem', marginRight: '0.375rem' }} /> Fetching…</> : 'Daemon Logs'}
            </button>
          </div>
          {diagnoseMutation.isError && (
            <div className="feedback-card feedback-danger" style={{ marginTop: '0.75rem' }}>
              {diagnoseMutation.error.message}
            </div>
          )}
          {diagOutput && (
            <pre style={codeBlockStyle}>
              {diagOutput}
            </pre>
          )}
          {logsMutation.isError && (
            <div className="feedback-card feedback-danger" style={{ marginTop: '0.75rem' }}>
              {logsMutation.error.message}
            </div>
          )}
          {logsOutput && (
            <pre style={codeBlockStyle}>
              {logsOutput}
            </pre>
          )}
        </div>
      )}

      {/* Danger Zone */}
      <div className="card danger-zone">
        <div className="card-section-title danger-title" style={{ marginBottom: '0.75rem' }}>
          Danger Zone
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button
            className="btn btn-danger btn-sm"
            onClick={() => {
              if (confirm(`Reinstall OS on "${server.name}"? This will wipe all data and install Ubuntu 24.04.`)) {
                reinstallMutation.mutate()
              }
            }}
            disabled={reinstallMutation.isPending}
          >
            {reinstallMutation.isPending ? <><span className="spinner" style={{ width: '0.75rem', height: '0.75rem', marginRight: '0.375rem' }} /> Reinstalling…</> : 'Reinstall OS'}
          </button>
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
    </div>
  )
}
