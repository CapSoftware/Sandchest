'use client'

import { useState } from 'react'
import { useSandboxes, useStopSandbox } from '@/hooks/use-sandboxes'
import { formatRelativeTime } from '@/lib/format'
import StatusBadge from '@/components/ui/StatusBadge'
import EmptyState from '@/components/ui/EmptyState'
import ErrorMessage from '@/components/ui/ErrorMessage'
import type { SandboxStatus } from '@sandchest/contract'

const FILTER_OPTIONS: Array<{ label: string; value: SandboxStatus | '' }> = [
  { label: 'All', value: '' },
  { label: 'Running', value: 'running' },
  { label: 'Stopped', value: 'stopped' },
  { label: 'Failed', value: 'failed' },
  { label: 'Queued', value: 'queued' },
]

export default function SandboxList() {
  const [statusFilter, setStatusFilter] = useState<SandboxStatus | ''>('')
  const {
    data,
    isLoading,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useSandboxes(statusFilter)
  const stopSandbox = useStopSandbox()

  const sandboxes = data?.pages.flatMap((page) => page.sandboxes) ?? []

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

      {error && (
        <ErrorMessage
          message={error instanceof Error ? error.message : 'Failed to load sandboxes'}
        />
      )}
      {stopSandbox.error && (
        <ErrorMessage
          message={
            stopSandbox.error instanceof Error
              ? stopSandbox.error.message
              : 'Failed to stop sandbox'
          }
        />
      )}

      {isLoading ? (
        <EmptyState message="Loading sandboxes..." />
      ) : sandboxes.length === 0 ? (
        <EmptyState
          message={
            statusFilter
              ? `No ${statusFilter} sandboxes found.`
              : 'No sandboxes yet. Create one using the SDK or CLI.'
          }
        />
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
                      <StatusBadge status={sb.status} className="dash-status" />
                    </td>
                    <td className="dash-text-weak">{sb.image}</td>
                    <td className="dash-text-weak">{sb.profile}</td>
                    <td className="dash-text-weak">
                      {formatRelativeTime(sb.created_at)}
                    </td>
                    <td>
                      {(sb.status === 'running' || sb.status === 'queued') && (
                        <button
                          className="dash-action-btn danger"
                          onClick={() => stopSandbox.mutate(sb.sandbox_id)}
                          disabled={
                            stopSandbox.isPending &&
                            stopSandbox.variables === sb.sandbox_id
                          }
                        >
                          {stopSandbox.isPending &&
                          stopSandbox.variables === sb.sandbox_id
                            ? 'Stopping...'
                            : 'Stop'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {hasNextPage && (
            <button
              className="dash-load-more"
              onClick={() => fetchNextPage()}
              disabled={isFetchingNextPage}
            >
              {isFetchingNextPage ? 'Loading...' : 'Load more'}
            </button>
          )}
        </>
      )}
    </div>
  )
}
