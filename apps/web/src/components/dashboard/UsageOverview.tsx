'use client'

import { useAutumnCustomer } from '@/hooks/use-autumn-customer'
import type { FeatureUsage } from '@/hooks/use-autumn-customer'
import { useSandboxes } from '@/hooks/use-sandboxes'

function UsageBar({ feature }: { feature: FeatureUsage }) {
  if (feature.unlimited) {
    return (
      <div className="usage-overview-bar-row">
        <div className="usage-overview-bar-label">
          <span className="usage-overview-bar-name">{feature.name}</span>
          <span className="usage-overview-bar-value">Unlimited</span>
        </div>
        <div className="usage-overview-bar-track">
          <div className="usage-overview-bar-fill unlimited" />
        </div>
      </div>
    )
  }

  const used = feature.usage ?? 0
  const included = feature.includedUsage ?? 0
  const percent = included > 0 ? Math.min((used / included) * 100, 100) : 0

  return (
    <div className="usage-overview-bar-row">
      <div className="usage-overview-bar-label">
        <span className="usage-overview-bar-name">{feature.name}</span>
        <span className="usage-overview-bar-value">
          {used.toLocaleString()} / {included > 0 ? included.toLocaleString() : '—'}
        </span>
      </div>
      <div className="usage-overview-bar-track">
        <div
          className={`usage-overview-bar-fill${percent >= 90 ? ' warning' : ''}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}

export default function UsageOverview() {
  const { planName, featureUsage, isLoading: billingLoading } = useAutumnCustomer()
  const { data, isLoading: sandboxesLoading } = useSandboxes('')

  const sandboxes = data?.pages.flatMap((page) => page.sandboxes) ?? []
  const activeSandboxes = sandboxes.filter(
    (sb) => sb.status === 'running' || sb.status === 'queued' || sb.status === 'provisioning',
  )

  const isLoading = billingLoading || sandboxesLoading

  if (isLoading) {
    return (
      <section className="usage-overview">
        <div className="usage-overview-stats">
          <div className="usage-overview-stat">
            <span className="usage-overview-stat-label">Plan</span>
            <span className="usage-overview-stat-value loading">—</span>
          </div>
          <div className="usage-overview-stat">
            <span className="usage-overview-stat-label">Active Sandboxes</span>
            <span className="usage-overview-stat-value loading">—</span>
          </div>
        </div>
      </section>
    )
  }

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
        {featureUsage.map((feature) => (
          <div key={feature.featureId} className="usage-overview-stat">
            <span className="usage-overview-stat-label">{feature.name}</span>
            <span className="usage-overview-stat-value">
              {feature.unlimited
                ? '∞'
                : `${(feature.usage ?? 0).toLocaleString()} / ${feature.includedUsage ? feature.includedUsage.toLocaleString() : '—'}`}
            </span>
          </div>
        ))}
      </div>

      {featureUsage.length > 0 && (
        <div className="usage-overview-bars">
          {featureUsage.map((feature) => (
            <UsageBar key={feature.featureId} feature={feature} />
          ))}
        </div>
      )}
    </section>
  )
}
