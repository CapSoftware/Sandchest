'use client'

import { useAutumnCustomer } from '@/hooks/use-autumn-customer'
import type { FeatureUsage } from '@/hooks/use-autumn-customer'
import { useCustomer } from 'autumn-js/react'
import { PricingTable } from 'autumn-js/react'
import { BillingSkeleton } from './skeletons'

function UsageBar({ feature }: { feature: FeatureUsage }) {
  if (feature.unlimited) {
    return (
      <div className="billing-usage-row">
        <div className="billing-usage-label">
          <span className="billing-usage-name">{feature.name}</span>
          <span className="billing-usage-value">Unlimited</span>
        </div>
        <div className="billing-usage-bar">
          <div className="billing-usage-fill unlimited" />
        </div>
      </div>
    )
  }

  const used = feature.usage ?? 0
  const included = feature.includedUsage ?? 0
  const percent = included > 0 ? Math.min((used / included) * 100, 100) : 0

  return (
    <div className="billing-usage-row">
      <div className="billing-usage-label">
        <span className="billing-usage-name">{feature.name}</span>
        <span className="billing-usage-value">
          {used.toLocaleString()} / {included > 0 ? included.toLocaleString() : '—'}
        </span>
      </div>
      <div className="billing-usage-bar">
        <div
          className={`billing-usage-fill${percent >= 90 ? ' warning' : ''}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}

export default function BillingManagement() {
  const { customer, planName, featureUsage, isLoading } = useAutumnCustomer()
  const { openBillingPortal } = useCustomer()

  if (isLoading) {
    return <BillingSkeleton />
  }

  const activePlan =
    customer?.products.find((p) => p.status === 'active' && !p.is_add_on) ?? null

  return (
    <div>
      <div className="dash-page-header">
        <h1 className="dash-page-title">Billing</h1>
        {customer && (
          <button
            className="dash-primary-btn"
            onClick={() => openBillingPortal()}
          >
            Manage Billing
          </button>
        )}
      </div>

      {/* Current plan */}
      <section className="dash-section">
        <h2 className="dash-section-title">Current Plan</h2>
        <div className="billing-plan-card">
          <div className="billing-plan-info">
            <span className="billing-plan-name">{planName}</span>
            {activePlan && (
              <span className="billing-plan-status">Active</span>
            )}
          </div>
          {!activePlan && (
            <p className="billing-plan-empty">
              No active plan. Choose a plan below to get started.
            </p>
          )}
        </div>
      </section>

      {/* Usage */}
      {featureUsage.length > 0 && (
        <section className="dash-section">
          <h2 className="dash-section-title">Usage</h2>
          <div className="billing-usage-list">
            {featureUsage.map((feature) => (
              <UsageBar key={feature.featureId} feature={feature} />
            ))}
          </div>
        </section>
      )}

      {/* Plans */}
      <section className="dash-section">
        <h2 className="dash-section-title">Plans</h2>
        <div className="pricing-table-wrapper dark">
          <PricingTable />
        </div>
      </section>
    </div>
  )
}
