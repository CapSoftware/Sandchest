'use client'

export interface MetricsData {
  cpu_percent: number
  memory_used_bytes: number
  memory_total_bytes: number
  disk_used_bytes: number
  disk_total_bytes: number
  network_rx_bytes: number
  network_tx_bytes: number
  load_avg_1: number
  load_avg_5: number
  load_avg_15: number
}

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

export default function ServerMetrics({ metrics }: { metrics: MetricsData | null }) {
  if (!metrics) {
    return (
      <div className="card" style={{ padding: '2rem', textAlign: 'center', color: 'var(--color-text-weak)' }}>
        No metrics data available
      </div>
    )
  }

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ fontWeight: 600, fontSize: '0.8125rem', color: 'var(--color-text-strong)' }}>
        System Metrics
      </div>
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
        <div style={{ fontSize: '0.75rem', color: 'var(--color-text-weak)' }}>
          Network RX: {formatBytes(metrics.network_rx_bytes)}
        </div>
        <div style={{ fontSize: '0.75rem', color: 'var(--color-text-weak)' }}>
          Network TX: {formatBytes(metrics.network_tx_bytes)}
        </div>
        <div style={{ fontSize: '0.75rem', color: 'var(--color-text-weak)' }}>
          Load Avg: {metrics.load_avg_1.toFixed(2)} / {metrics.load_avg_5.toFixed(2)} / {metrics.load_avg_15.toFixed(2)}
        </div>
      </div>
    </div>
  )
}
