import type { SandboxSummary } from '@/hooks/use-server-sandboxes'

function formatUptime(startedAt: string | null): string {
  if (!startedAt) return '-'
  const ms = Date.now() - new Date(startedAt).getTime()
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainMinutes = minutes % 60
  if (hours < 24) return `${hours}h ${remainMinutes}m`
  const days = Math.floor(hours / 24)
  const remainHours = hours % 24
  return `${days}d ${remainHours}h`
}

function formatRelative(iso: string | null): string {
  if (!iso) return '-'
  const ms = Date.now() - new Date(iso).getTime()
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ago`
}

function truncateId(id: string): string {
  if (id.length <= 12) return id
  return id.slice(0, 12) + '...'
}

function SkeletonRows() {
  return (
    <>
      {[1, 2, 3].map((i) => (
        <tr key={i}>
          {[1, 2, 3, 4, 5, 6].map((j) => (
            <td key={j} className="vm-table-cell">
              <span className="skeleton skeleton-text" style={{ width: `${3 + j}rem` }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}

export default function SandboxTable({
  sandboxes,
  loading,
}: {
  sandboxes: SandboxSummary[]
  loading: boolean
}) {
  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
        <span className="card-section-title">Live VMs</span>
        {!loading && (
          <span className="vm-count">{sandboxes.length}</span>
        )}
      </div>

      {!loading && sandboxes.length === 0 ? (
        <div className="text-weak" style={{ fontSize: '0.75rem', padding: '1rem 0' }}>
          No VMs running
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="vm-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Status</th>
                <th>Profile</th>
                <th>Org</th>
                <th>Uptime</th>
                <th>Last Activity</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <SkeletonRows />
              ) : (
                sandboxes.map((sb) => (
                  <tr key={sb.id}>
                    <td className="vm-table-cell" style={{ fontFamily: 'var(--font-mono)' }}>
                      {truncateId(sb.id)}
                    </td>
                    <td className="vm-table-cell">
                      <span className="badge badge-online" style={{ fontSize: '0.6875rem' }}>
                        <span className="badge-dot" />
                        {sb.status}
                      </span>
                    </td>
                    <td className="vm-table-cell">{sb.profile_name}</td>
                    <td className="vm-table-cell" style={{ fontFamily: 'var(--font-mono)' }}>
                      {sb.org_id.slice(0, 8)}...
                    </td>
                    <td className="vm-table-cell">{formatUptime(sb.started_at)}</td>
                    <td className="vm-table-cell">{formatRelative(sb.last_activity_at)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
