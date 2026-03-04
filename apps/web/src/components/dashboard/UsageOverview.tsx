'use client'

import { useAutumnCustomer } from '@/hooks/use-autumn-customer'
import { useSandboxes } from '@/hooks/use-sandboxes'
import { UsageOverviewSkeleton } from './skeletons'

export default function UsageOverview() {
  const { planName, creditBalance, isLoading: billingLoading } = useAutumnCustomer()
  const { data, isLoading: sandboxesLoading } = useSandboxes('')

  const sandboxes = data?.pages.flatMap((page) => page.sandboxes) ?? []
  const activeSandboxes = sandboxes.filter(
    (sb) => sb.status === 'running' || sb.status === 'queued' || sb.status === 'provisioning',
  )

  const isLoading = billingLoading || sandboxesLoading

  if (isLoading) {
    return <UsageOverviewSkeleton />
  }

  const creditPercent = creditBalance && creditBalance.total > 0
    ? Math.min((creditBalance.used / creditBalance.total) * 100, 100)
    : 0

  return (
    <section className="usage-overview">
      <div className="usage-overview-stats">
        <div className="usage-overview-stat">
          <span className="usage-overview-stat-label">Plan</span>
          <span className="usage-overview-stat-value">{planName}</span>
        </div>
        <div className="usage-overview-stat">
          <span className="usage-overview-stat-label">Active Sandboxes</span>
          <span className="usage-overview-stat-value">{activeSandboxes.length}</span>
        </div>
        {creditBalance && (
          <div className="usage-overview-stat">
            <span className="usage-overview-stat-label">Credits Remaining</span>
            <span className="usage-overview-stat-value">
              ${creditBalance.remaining.toFixed(2)}
            </span>
          </div>
        )}
      </div>

      {creditBalance && (
        <div className="usage-overview-bars">
          <div className="usage-overview-bar-row">
            <div className="usage-overview-bar-label">
              <span className="usage-overview-bar-name">Compute Credits</span>
              <span className="usage-overview-bar-value">
                ${creditBalance.used.toFixed(2)} / ${creditBalance.total.toFixed(2)}
              </span>
            </div>
            <div className="usage-overview-bar-track">
              <div
                className={`usage-overview-bar-fill${creditPercent >= 90 ? ' warning' : ''}`}
                style={{ width: `${creditPercent}%` }}
              />
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
