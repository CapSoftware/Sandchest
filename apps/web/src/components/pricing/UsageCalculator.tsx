'use client'

import { useState } from 'react'
import { SANDCHEST_TIERS } from '@/data/pricing'
import type { SandchestTierKey } from '@/data/pricing'

function hourlyRate(vcpus: number, ramGiB: number, tier: SandchestTierKey) {
  const t = SANDCHEST_TIERS[tier]
  return vcpus * t.vcpuPerHr + ramGiB * t.ramGiBPerHr
}

function monthlyCost(hr: number, hours: number, base: number, credits: number) {
  const usage = hr * hours
  return base + Math.max(0, usage - credits)
}

function fmtHr(n: number) {
  return '$' + n.toFixed(n < 0.01 ? 4 : 2)
}

function fmtSec(n: number) {
  return '$' + n.toFixed(7)
}

function fmtWhole(n: number) {
  return '$' + Math.round(n).toLocaleString()
}

export default function UsageCalculator() {
  const [vcpus, setVcpus] = useState(2)
  const [ramGiB, setRamGiB] = useState(4)
  const [hours, setHours] = useState(200)

  return (
    <div className="section">
      <div className="section-header" style={{ textAlign: 'center' }}>
        <h3 className="section-title">Estimate your costs</h3>
        <p className="text-text-weak" style={{ fontSize: 13 }}>
          Configure your sandbox and see real-time pricing across all tiers. Billed per-second.
        </p>
      </div>

      <div className="pricing-calculator">
        <div className="pricing-sliders">
          <div className="pricing-slider-group">
            <div className="pricing-slider-label">
              <span className="pricing-slider-name">vCPUs</span>
              <span className="pricing-slider-value">{vcpus}</span>
            </div>
            <input
              type="range"
              className="pricing-slider"
              aria-label="vCPUs"
              min={1}
              max={8}
              step={1}
              value={vcpus}
              onChange={(e) => setVcpus(Number(e.target.value))}
            />
          </div>

          <div className="pricing-slider-group">
            <div className="pricing-slider-label">
              <span className="pricing-slider-name">RAM (GiB)</span>
              <span className="pricing-slider-value">{ramGiB}</span>
            </div>
            <input
              type="range"
              className="pricing-slider"
              aria-label="RAM in GiB"
              min={1}
              max={16}
              step={1}
              value={ramGiB}
              onChange={(e) => setRamGiB(Number(e.target.value))}
            />
          </div>

          <div className="pricing-slider-group">
            <div className="pricing-slider-label">
              <span className="pricing-slider-name">Hours / month</span>
              <span className="pricing-slider-value">{hours.toLocaleString()}</span>
            </div>
            <input
              type="range"
              className="pricing-slider"
              aria-label="Hours per month"
              min={10}
              max={2000}
              step={10}
              value={hours}
              onChange={(e) => setHours(Number(e.target.value))}
            />
          </div>
        </div>

        <div className="pricing-results">
          {(Object.keys(SANDCHEST_TIERS) as SandchestTierKey[]).map((key) => {
            const tier = SANDCHEST_TIERS[key]
            const hr = hourlyRate(vcpus, ramGiB, key)
            const sec = hr / 3600
            const monthly = monthlyCost(hr, hours, tier.monthlyBase, tier.monthlyCredits)

            return (
              <div
                key={key}
                className={`pricing-result-card${key === 'max' ? ' highlighted' : ''}`}
              >
                <span className="pricing-result-tier">{tier.name}</span>
                <div className="pricing-result-rates">
                  <div className="pricing-result-rate-row">
                    <span className="pricing-result-rate-value">{fmtSec(sec)}</span>
                    <span className="pricing-result-rate-unit">/sec</span>
                  </div>
                  <div className="pricing-result-rate-row">
                    <span className="pricing-result-rate-value pricing-result-rate-secondary">{fmtHr(hr)}</span>
                    <span className="pricing-result-rate-unit pricing-result-rate-secondary">/hr</span>
                  </div>
                </div>
                <div className="pricing-result-monthly">
                  <span className="pricing-result-monthly-value">{fmtWhole(monthly)}/mo</span>
                  {tier.monthlyCredits > 0 && (
                    <span className="pricing-result-monthly-detail">
                      {fmtWhole(tier.monthlyCredits)} credits included
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
