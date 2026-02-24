import Link from 'next/link'
import StatusBadge from './StatusBadge'

export interface ServerSummary {
  id: string
  name: string
  ip: string
  provision_status: 'pending' | 'provisioning' | 'completed' | 'failed'
  node_status?: 'online' | 'offline' | 'draining' | 'disabled' | undefined
  heartbeat_active?: boolean | undefined
  slots_total: number
  slots_used?: number | undefined
  cpu_percent?: number | undefined
  memory_percent?: number | undefined
  disk_percent?: number | undefined
}

function MetricBar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  const level = pct > 90 ? 'danger' : pct > 70 ? 'warning' : undefined

  return (
    <div className="metric-bar-container">
      <div className="metric-bar-label">
        <span>{label}</span>
        <span>{pct}%</span>
      </div>
      <div className="metric-bar-track">
        <div
          className="metric-bar-fill"
          style={{ width: `${pct}%` }}
          data-level={level}
        />
      </div>
    </div>
  )
}

export default function ServerCard({ server }: { server: ServerSummary }) {
  const displayStatus = server.provision_status === 'completed'
    ? server.heartbeat_active
      ? 'online'
      : server.node_status && server.node_status !== 'offline'
        ? server.node_status
        : 'awaiting-daemon' as const
    : server.provision_status

  return (
    <Link href={`/servers/${server.id}`} style={{ textDecoration: 'none' }}>
      <div className="card" style={{ cursor: 'pointer', transition: 'border-color 0.15s' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
          <div>
            <div style={{ fontWeight: 600, color: 'var(--color-text-strong)', fontSize: '0.875rem' }}>
              {server.name}
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--color-text-weak)', marginTop: '0.125rem' }}>
              {server.ip}
            </div>
          </div>
          <StatusBadge status={displayStatus} />
        </div>

        {server.provision_status === 'completed' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--color-text-weak)' }}>
              Slots: {server.slots_used ?? 0} / {server.slots_total}
            </div>
            {server.cpu_percent !== undefined && (
              <MetricBar label="CPU" value={server.cpu_percent} max={100} />
            )}
            {server.memory_percent !== undefined && (
              <MetricBar label="Memory" value={server.memory_percent} max={100} />
            )}
            {server.disk_percent !== undefined && (
              <MetricBar label="Disk" value={server.disk_percent} max={100} />
            )}
          </div>
        )}
      </div>
    </Link>
  )
}
