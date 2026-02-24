import type { Metadata } from 'next'
import ScrollReveal from '@/components/landing/ScrollReveal'
import PricingHero from '@/components/pricing/PricingHero'
import PricingCards from '@/components/pricing/PricingCards'
import UsageCalculator from '@/components/pricing/UsageCalculator'
import PricingCompare from '@/components/pricing/PricingCompare'
import PricingFaq from '@/components/pricing/PricingFaq'

export const metadata: Metadata = {
  title: 'Pricing — Sandchest',
  description:
    'Simple, transparent pricing for AI agent sandboxes. Per-second billing, recurring free credits, up to 60% cheaper than alternatives.',
  openGraph: {
    title: 'Pricing — Sandchest',
    description:
      'Simple, transparent pricing for AI agent sandboxes. Per-second billing, recurring free credits, up to 60% cheaper than alternatives.',
    images: ['/og.png'],
    type: 'website',
  },
}

export default function PricingPage() {
  return (
    <>
      <PricingHero />
      <ScrollReveal>
        <PricingCards />
      </ScrollReveal>
      <ScrollReveal>
        <UsageCalculator />
      </ScrollReveal>
      <ScrollReveal>
        <PricingCompare />
      </ScrollReveal>
      <ScrollReveal>
        <PricingFaq />
      </ScrollReveal>
    </>
  )
}
