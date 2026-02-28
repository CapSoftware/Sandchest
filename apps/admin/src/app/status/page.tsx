'use client'

import { useStatus } from '@/hooks/use-status'

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const parts: string[] = []
  if (d > 0) parts.push(`${d}d`)
  if (h > 0) parts.push(`${h}h`)
  if (m > 0) parts.push(`${m}m`)
  parts.push(`${s}s`)
  return parts.join(' ')
}

function StatusBadge({ status }: { status: string }) {
  const badgeClass =
    status === 'ok' || status === 'online'
      ? 'badge-online'
      : status === 'draining'
        ? 'badge-draining'
        : status === 'fail' || status === 'error' || status === 'offline' || status === 'disabled'
          ? 'badge-offline'
          : 'badge-pending'

  return (
    <span className={`badge ${badgeClass}`}>
      <span className="badge-dot" />
      {status}
    </span>
  )
}

function SectionSkeleton() {
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <div className="skeleton skeleton-text" style={{ width: '40%' }} />
      <div className="skeleton skeleton-text" style={{ width: '60%' }} />
      <div className="skeleton skeleton-text" style={{ width: '50%' }} />
    </div>
  )
}

export default function StatusPage() {
  const { data, isLoading, error } = useStatus()

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">System Status</h1>
      </div>

      {error ? (
        <div className="card feedback-card feedback-danger">
          Failed to fetch system status
        </div>
      ) : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {/* API Section */}
        {isLoading ? (
          <SectionSkeleton />
        ) : data ? (
          <div className="card">
            <div className="card-header">
              <span className="card-title">API</span>
              <StatusBadge status={data.api.status} />
            </div>
            {data.api.status === 'unreachable' || !data.api.uptime_seconds ? (
              <p style={{ fontSize: '0.8125rem' }} className="text-weak">
                {data.api.status === 'unreachable' ? 'Control plane is unreachable' : `API status: ${data.api.status}`}
              </p>
            ) : (
              <div className="card-metrics">
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem' }}>
                  <span className="text-weak">Uptime</span>
                  <span>{formatUptime(data.api.uptime_seconds)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem' }}>
                  <span className="text-weak">Version</span>
                  <span>{data.api.version}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem' }}>
                  <span className="text-weak">Draining</span>
                  <span>{data.api.draining ? 'Yes' : 'No'}</span>
                </div>
              </div>
            )}
          </div>
        ) : null}

        {/* Redis Section */}
        {isLoading ? (
          <SectionSkeleton />
        ) : data?.redis ? (
          <div className="card">
            <div className="card-header">
              <span className="card-title">Redis</span>
              <StatusBadge status={data.redis.status} />
            </div>
          </div>
        ) : null}

        {/* Workers Section */}
        {isLoading ? (
          <SectionSkeleton />
        ) : data?.workers ? (
          <div className="card">
            <div className="card-header" style={{ marginBottom: '0.5rem' }}>
              <span className="card-title">Workers</span>
              <span style={{ fontSize: '0.75rem' }} className="text-weak">
                {data.workers.filter((w) => w.active).length}/{data.workers.length} active
              </span>
            </div>
            {data.workers.length === 0 ? (
              <p style={{ fontSize: '0.8125rem' }} className="text-weak">
                No worker data available
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                {data.workers.map((worker) => (
                  <div
                    key={worker.name}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      fontSize: '0.8125rem',
                      padding: '0.375rem 0',
                      borderBottom: '1px solid var(--color-border-weak)',
                    }}
                  >
                    <span>{worker.name}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      {worker.active && worker.ttl_ms > 0 ? (
                        <span className="text-weak" style={{ fontSize: '0.75rem' }}>
                          TTL {Math.round(worker.ttl_ms / 1000)}s
                        </span>
                      ) : null}
                      <StatusBadge status={worker.active ? 'ok' : 'offline'} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}

        {/* Nodes Section */}
        {isLoading ? (
          <SectionSkeleton />
        ) : data?.nodes ? (
          <div className="card">
            <div className="card-header" style={{ marginBottom: '0.5rem' }}>
              <span className="card-title">Nodes</span>
              <span style={{ fontSize: '0.75rem' }} className="text-weak">
                {data.nodes.length} registered
              </span>
            </div>
            {data.nodes.length === 0 ? (
              <p style={{ fontSize: '0.8125rem' }} className="text-weak">
                No nodes registered
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                {data.nodes.map((node) => (
                  <div
                    key={node.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      fontSize: '0.8125rem',
                      padding: '0.375rem 0',
                      borderBottom: '1px solid var(--color-border-weak)',
                    }}
                  >
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}>
                      {node.id}
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <StatusBadge status={node.status} />
                      <span
                        className={`badge ${node.heartbeat_active ? 'badge-online' : 'badge-offline'}`}
                      >
                        <span className="badge-dot" />
                        {node.heartbeat_active ? 'heartbeat' : 'no heartbeat'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </>
  )
}
