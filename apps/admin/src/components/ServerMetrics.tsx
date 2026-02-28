'use client'

import type { MetricsData } from '@/lib/metrics'

export type { MetricsData }

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(1)} ${units[i]}`
}

function Bar({ label, value, max, format }: { label: string; value: number; max: number; format?: 'bytes' | 'percent' }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  const level = pct > 90 ? 'danger' : pct > 70 ? 'warning' : undefined

  let displayValue: string
  if (format === 'bytes') {
    displayValue = `${formatBytes(value)} / ${formatBytes(max)}`
  } else {
    displayValue = `${pct}%`
  }

  return (
    <div className="metric-bar-container">
      <div className="metric-bar-label">
        <span>{label}</span>
        <span>{displayValue}</span>
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

function BarSkeleton() {
  return (
    <div className="metric-bar-container">
      <div className="metric-bar-label">
        <span className="skeleton skeleton-text" style={{ width: '2.5rem' }} />
        <span className="skeleton skeleton-text" style={{ width: '4rem' }} />
      </div>
      <div className="metric-bar-track">
        <div className="skeleton" style={{ height: '100%', width: '100%', borderRadius: '3px' }} />
      </div>
    </div>
  )
}

export default function ServerMetrics({ metrics }: { metrics: MetricsData | null }) {
  if (!metrics) {
    return (
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div className="card-section-title">System Metrics</div>
        <BarSkeleton />
        <BarSkeleton />
        <BarSkeleton />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginTop: '0.25rem' }}>
          <div className="skeleton skeleton-text" style={{ width: '70%' }} />
          <div className="skeleton skeleton-text" style={{ width: '70%' }} />
          <div className="skeleton skeleton-text" style={{ width: '80%' }} />
        </div>
      </div>
    )
  }

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div className="card-section-title">System Metrics</div>
      <Bar label="CPU" value={metrics.cpu_percent} max={100} />
      <Bar
        label="Memory"
        value={metrics.memory_used_bytes}
        max={metrics.memory_total_bytes}
        format="bytes"
      />
      <Bar
        label="Disk"
        value={metrics.disk_used_bytes}
        max={metrics.disk_total_bytes}
        format="bytes"
      />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginTop: '0.25rem' }}>
        <div className="detail-stat">
          Network RX: {formatBytes(metrics.network_rx_bytes)}
        </div>
        <div className="detail-stat">
          Network TX: {formatBytes(metrics.network_tx_bytes)}
        </div>
        <div className="detail-stat">
          Load Avg: {metrics.load_avg_1.toFixed(2)} / {metrics.load_avg_5.toFixed(2)} / {metrics.load_avg_15.toFixed(2)}
        </div>
      </div>
    </div>
  )
}
