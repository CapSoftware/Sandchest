'use client'

import { useState } from 'react'
import { useAutumnCustomer } from '@/hooks/use-autumn-customer'
import type { CreditBalance } from '@/hooks/use-autumn-customer'
import { useCustomer } from 'autumn-js/react'
import { PricingTable } from 'autumn-js/react'
import { BillingSkeleton } from './skeletons'

const TOPUP_OPTIONS = [
  { label: '$10', productId: 'credits-topup-10' },
  { label: '$50', productId: 'credits-topup-50' },
  { label: '$100', productId: 'credits-topup-100' },
] as const

function CreditBalanceCard({ credits }: { credits: CreditBalance }) {
  const percent = credits.total > 0
    ? Math.min((credits.used / credits.total) * 100, 100)
    : 0

  return (
    <div className="billing-credits-card">
      <div className="billing-credits-header">
        <span className="billing-credits-label">Credit Balance</span>
        <span className="billing-credits-amount">
          ${credits.remaining.toFixed(2)}
          {credits.total > 0 && (
            <span className="billing-credits-total"> / ${credits.total.toFixed(2)}</span>
          )}
        </span>
      </div>
      <div className="billing-usage-bar">
        <div
          className={`billing-usage-fill${percent >= 90 ? ' warning' : ''}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="billing-credits-used">
        ${credits.used.toFixed(2)} used this month
      </span>
    </div>
  )
}

function BuyCreditsSection() {
  const { attach } = useCustomer()
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleBuy(productId: string) {
    setLoading(productId)
    setError(null)
    try {
      await attach({ productId })
    } catch (e) {
      // Autumn redirects on success — errors here are real failures
      const message = e instanceof Error ? e.message : 'Failed to purchase credits'
      setError(message)
    }
    setLoading(null)
  }

  return (
    <div className="billing-topup">
      <span className="billing-topup-label">Buy Credits</span>
      <div className="billing-topup-buttons">
        {TOPUP_OPTIONS.map((option) => (
          <button
            key={option.productId}
            className="billing-topup-btn"
            onClick={() => handleBuy(option.productId)}
            disabled={loading !== null}
          >
            {loading === option.productId ? '...' : option.label}
          </button>
        ))}
      </div>
      {error && <p className="billing-topup-error" role="alert">{error}</p>}
    </div>
  )
}

export default function BillingManagement() {
  const { activePlan, planName, creditBalance, isLoading } = useAutumnCustomer()
  const { openBillingPortal } = useCustomer()

  if (isLoading) {
    return <BillingSkeleton />
  }

  return (
    <div>
      <div className="dash-page-header">
        <h1 className="dash-page-title">Billing</h1>
        {activePlan && (
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

      {/* Credit balance */}
      {creditBalance && (
        <section className="dash-section">
          <h2 className="dash-section-title">Credits</h2>
          <CreditBalanceCard credits={creditBalance} />
          <BuyCreditsSection />
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
