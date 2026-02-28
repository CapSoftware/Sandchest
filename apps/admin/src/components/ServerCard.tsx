import Link from 'next/link'
import StatusBadge from './StatusBadge'
import { deriveStatus } from '@/lib/derive-status'
import type { MetricsResult } from '@/lib/metrics'

export interface ServerSummary {
  id: string
  name: string
  ip: string
  provision_status: 'pending' | 'provisioning' | 'completed' | 'failed'
  node_id: string | null
  slots_total: number
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(1)} ${units[i]}`
}

function MetricBar({ label, value, max, detail }: { label: string; value: number; max: number; detail?: string | undefined }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  const level = pct > 90 ? 'danger' : pct > 70 ? 'warning' : undefined

  return (
    <div className="metric-bar-container">
      <div className="metric-bar-label">
        <span>{label}</span>
        <span>{detail ?? `${pct}%`}</span>
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

function MetricBarSkeleton() {
  return (
    <div className="metric-bar-container">
      <div className="metric-bar-label">
        <span className="skeleton skeleton-text" style={{ width: '2.5rem' }} />
        <span className="skeleton skeleton-text" style={{ width: '2rem' }} />
      </div>
      <div className="metric-bar-track">
        <div className="skeleton" style={{ height: '100%', width: '100%', borderRadius: '3px' }} />
      </div>
    </div>
  )
}

export default function ServerCard({
  server,
  metricsResult,
}: {
  server: ServerSummary
  metricsResult?: MetricsResult | undefined
}) {
  const status = deriveStatus(
    server.provision_status,
    server.node_id,
    metricsResult?.daemon_status,
  )

  const isProvisioned = server.provision_status === 'completed'
  const metrics = metricsResult?.metrics

  return (
    <Link href={`/servers/${server.id}`} className="card-link">
      <div className="card card-hover">
        <div className="card-header">
          <div>
            <div className="card-title">{server.name}</div>
            <div className="card-subtitle">{server.ip}</div>
          </div>
          <StatusBadge status={status} />
        </div>

        {isProvisioned && (
          <div className="card-metrics">
            {metrics ? (
              <>
                <MetricBar label="CPU" value={metrics.cpu_percent} max={100} />
                <MetricBar
                  label="Memory"
                  value={metrics.memory_used_bytes}
                  max={metrics.memory_total_bytes}
                  detail={`${formatBytes(metrics.memory_used_bytes)} / ${formatBytes(metrics.memory_total_bytes)}`}
                />
                <MetricBar
                  label="Disk"
                  value={metrics.disk_used_bytes}
                  max={metrics.disk_total_bytes}
                  detail={`${formatBytes(metrics.disk_used_bytes)} / ${formatBytes(metrics.disk_total_bytes)}`}
                />
              </>
            ) : (
              <>
                <MetricBarSkeleton />
                <MetricBarSkeleton />
                <MetricBarSkeleton />
              </>
            )}
          </div>
        )}
      </div>
    </Link>
  )
}

export function ServerCardSkeleton() {
  return (
    <div className="card">
      <div className="card-header">
        <div>
          <div className="skeleton skeleton-text" style={{ width: '8rem', height: '0.875rem' }} />
          <div className="skeleton skeleton-text" style={{ width: '5rem', height: '0.75rem', marginTop: '0.25rem' }} />
        </div>
        <div className="skeleton skeleton-badge" />
      </div>
      <div className="card-metrics">
        <MetricBarSkeleton />
        <MetricBarSkeleton />
        <MetricBarSkeleton />
      </div>
    </div>
  )
}
