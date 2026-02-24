import type { Metadata } from 'next'
import ScrollReveal from '@/components/landing/ScrollReveal'
import CompareHero from '@/components/compare/CompareHero'
import CostRaceAnimation from '@/components/compare/CostRaceAnimation'
import CompareTable from '@/components/compare/CompareTable'
import ScenarioGrid from '@/components/compare/ScenarioGrid'
import FeatureGrid from '@/components/compare/FeatureGrid'
import CompareCta from '@/components/compare/CompareCta'

export const metadata: Metadata = {
  title: 'Sandchest vs E2B vs Daytona — Pricing Comparison',
  description:
    'Compare sandbox pricing across Sandchest, E2B, and Daytona. See per-hour costs, monthly scenarios, and feature differences.',
}

export default function ComparePage() {
  return (
    <>
      <CompareHero />
      <ScrollReveal>
        <CostRaceAnimation />
      </ScrollReveal>
      <ScrollReveal>
        <CompareTable />
      </ScrollReveal>
      <ScrollReveal>
        <ScenarioGrid />
      </ScrollReveal>
      <ScrollReveal>
        <FeatureGrid />
      </ScrollReveal>
      <ScrollReveal>
        <CompareCta />
      </ScrollReveal>
    </>
  )
}
