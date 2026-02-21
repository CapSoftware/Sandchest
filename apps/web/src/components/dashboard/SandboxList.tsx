import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../../lib/api'
import { formatRelativeTime } from '../../lib/format'
import type { SandboxSummary, ListSandboxesResponse, SandboxStatus } from '@sandchest/contract'

const STATUS_COLORS: Record<SandboxStatus, string> = {
  queued: 'var(--color-text-weak)',
  provisioning: 'hsl(40, 80%, 60%)',
  running: 'hsl(140, 60%, 50%)',
  stopping: 'hsl(40, 80%, 60%)',
  stopped: 'var(--color-text-weak)',
  failed: 'hsl(0, 70%, 60%)',
  deleted: 'var(--color-text-weak)',
}

const FILTER_OPTIONS: Array<{ label: string; value: SandboxStatus | '' }> = [
  { label: 'All', value: '' },
  { label: 'Running', value: 'running' },
  { label: 'Stopped', value: 'stopped' },
  { label: 'Failed', value: 'failed' },
  { label: 'Queued', value: 'queued' },
]

export default function SandboxList() {
  const [sandboxes, setSandboxes] = useState<SandboxSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [statusFilter, setStatusFilter] = useState<SandboxStatus | ''>('')
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [stopping, setStopping] = useState<Set<string>>(new Set())

  const fetchSandboxes = useCallback(async (cursor?: string) => {
    setError('')
    try {
      const params = new URLSearchParams()
      if (statusFilter) params.set('status', statusFilter)
      if (cursor) params.set('cursor', cursor)
      params.set('limit', '20')

      const query = params.toString()
      const data = await apiFetch<ListSandboxesResponse>(
        `/v1/sandboxes${query ? `?${query}` : ''}`,
      )

      if (cursor) {
        setSandboxes((prev) => [...prev, ...data.sandboxes])
      } else {
        setSandboxes(data.sandboxes)
      }
      setNextCursor(data.next_cursor)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sandboxes')
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

  useEffect(() => {
    setLoading(true)
    setSandboxes([])
    fetchSandboxes()
  }, [fetchSandboxes])

  async function handleStop(sandboxId: string) {
    setStopping((prev) => new Set(prev).add(sandboxId))
    try {
      await apiFetch(`/v1/sandboxes/${sandboxId}/stop`, { method: 'POST' })
      setSandboxes((prev) =>
        prev.map((s) =>
          s.sandbox_id === sandboxId ? { ...s, status: 'stopping' as const } : s,
        ),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop sandbox')
    } finally {
      setStopping((prev) => {
        const next = new Set(prev)
        next.delete(sandboxId)
        return next
      })
    }
  }

  return (
    <div>
      <div className="dash-page-header">
        <h1 className="dash-page-title">Sandboxes</h1>
      </div>

      <div className="dash-filters">
        {FILTER_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            className={`dash-filter-btn${statusFilter === opt.value ? ' active' : ''}`}
            onClick={() => setStatusFilter(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {error && <p className="dash-error">{error}</p>}

      {loading ? (
        <div className="dash-empty">Loading sandboxes...</div>
      ) : sandboxes.length === 0 ? (
        <div className="dash-empty">
          {statusFilter ? `No ${statusFilter} sandboxes found.` : 'No sandboxes yet. Create one using the SDK or CLI.'}
        </div>
      ) : (
        <>
          <div className="dash-table-wrap">
            <table className="dash-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Status</th>
                  <th>Image</th>
                  <th>Profile</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sandboxes.map((sb) => (
                  <tr key={sb.sandbox_id}>
                    <td>
                      <a
                        href={sb.replay_url}
                        target="_blank"
                        rel="noopener"
                        className="dash-id-link"
                      >
                        {sb.sandbox_id}
                      </a>
                    </td>
                    <td>
                      <span
                        className="dash-status"
                        style={{ color: STATUS_COLORS[sb.status] }}
                      >
                        {sb.status}
                      </span>
                    </td>
                    <td className="dash-text-weak">{sb.image}</td>
                    <td className="dash-text-weak">{sb.profile}</td>
                    <td className="dash-text-weak">{formatRelativeTime(sb.created_at)}</td>
                    <td>
                      {(sb.status === 'running' || sb.status === 'queued') && (
                        <button
                          className="dash-action-btn danger"
                          onClick={() => handleStop(sb.sandbox_id)}
                          disabled={stopping.has(sb.sandbox_id)}
                        >
                          {stopping.has(sb.sandbox_id) ? 'Stopping...' : 'Stop'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {nextCursor && (
            <button
              className="dash-load-more"
              onClick={() => fetchSandboxes(nextCursor)}
            >
              Load more
            </button>
          )}
        </>
      )}
    </div>
  )
}
