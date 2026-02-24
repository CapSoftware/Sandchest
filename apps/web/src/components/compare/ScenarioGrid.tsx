'use client'

import { useEffect, useRef, useState } from 'react'
import {
  competitors,
  competitorMonthlyCost,
  sandchestMonthlyCost,
  freePlan,
  paidPlan,
} from '@/data/pricing'
import type { SandchestTierKey } from '@/data/pricing'

const e2bHobby = freePlan(competitors.e2b)
const e2bPro = paidPlan(competitors.e2b)!
const daytonaFree = freePlan(competitors.daytona)

const SCENARIOS = [
  {
    title: 'Free',
    subtitle: '50 hrs/mo · Free tiers',
    hours: 50,
    tier: 'free' as SandchestTierKey,
    e2bPlan: e2bHobby,
    daytonaPlan: daytonaFree,
  },
  {
    title: 'Max',
    subtitle: '500 hrs/mo · Paid tiers',
    hours: 500,
    tier: 'max' as SandchestTierKey,
    e2bPlan: e2bPro,
    daytonaPlan: daytonaFree,
  },
  {
    title: 'Enterprise',
    subtitle: '2,000 hrs/mo · Paid tiers',
    hours: 2000,
    tier: 'max' as SandchestTierKey,
    e2bPlan: e2bPro,
    daytonaPlan: daytonaFree,
  },
] as const

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3)
}

function ScenarioCard({
  title,
  subtitle,
  hours,
  tier,
  e2bPlan,
  daytonaPlan,
}: {
  title: string
  subtitle: string
  hours: number
  tier: SandchestTierKey
  e2bPlan: (typeof SCENARIOS)[number]['e2bPlan']
  daytonaPlan: (typeof SCENARIOS)[number]['daytonaPlan']
}) {
  const [revealed, setRevealed] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const [counts, setCounts] = useState({ e2b: 0, daytona: 0, sandchest: 0 })

  const targets = {
    e2b: competitorMonthlyCost(hours, competitors.e2b, e2bPlan),
    daytona: competitorMonthlyCost(hours, competitors.daytona, daytonaPlan),
    sandchest: sandchestMonthlyCost(hours, tier),
  }

  const savings = Math.round(Math.min(targets.e2b, targets.daytona) - targets.sandchest)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setRevealed(true)
          observer.unobserve(el)
        }
      },
      { threshold: 0.3 },
    )

    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!revealed) return

    const duration = 1500
    const start = performance.now()
    let raf: number

    function tick(now: number) {
      const elapsed = now - start
      const t = Math.min(elapsed / duration, 1)
      const ease = easeOutCubic(t)

      setCounts({
        e2b: ease * targets.e2b,
        daytona: ease * targets.daytona,
        sandchest: ease * targets.sandchest,
      })

      if (t < 1) raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [revealed, targets.e2b, targets.daytona, targets.sandchest])

  function fmt(n: number) {
    return '$' + Math.round(n).toLocaleString()
  }

  const e2bLabel = e2bPlan.monthlyPrice > 0 ? `E2B ${e2bPlan.name}` : 'E2B Hobby'

  return (
    <div className="scenario-cell" ref={ref}>
      <div className="scenario-header">
        <span className="scenario-title">{title}</span>
        <span className="scenario-subtitle">{subtitle}</span>
      </div>
      <div className="scenario-costs">
        <div className="scenario-cost-row">
          <span className="scenario-provider text-text-weak">{e2bLabel}</span>
          <span className="scenario-amount text-text-weak">{fmt(counts.e2b)}/mo</span>
        </div>
        <div className="scenario-cost-row">
          <span className="scenario-provider text-text-weak">Daytona</span>
          <span className="scenario-amount text-text-weak">{fmt(counts.daytona)}/mo</span>
        </div>
        <div className="scenario-cost-row">
          <span className="scenario-provider text-accent">Sandchest</span>
          <span className="scenario-amount text-accent">{fmt(counts.sandchest)}/mo</span>
        </div>
      </div>
      {savings > 0 && (
        <div className="scenario-savings">
          You save {fmt(savings)}/mo
        </div>
      )}
    </div>
  )
}

export default function ScenarioGrid() {
  return (
    <div className="section">
      <div className="section-header">
        <h3 className="section-title">Monthly cost by scenario</h3>
        <p className="text-text-weak" style={{ fontSize: 13 }}>
          Standard small sandbox (2 vCPU, 4 GiB). Free uses free tiers, Max/Enterprise use paid tiers where applicable.
        </p>
      </div>
      <div className="scenario-grid">
        {SCENARIOS.map((s) => (
          <ScenarioCard
            key={s.title}
            title={s.title}
            subtitle={s.subtitle}
            hours={s.hours}
            tier={s.tier}
            e2bPlan={s.e2bPlan}
            daytonaPlan={s.daytonaPlan}
          />
        ))}
      </div>
    </div>
  )
}
