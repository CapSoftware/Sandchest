import type { Metadata } from 'next'
import ScrollReveal from '@/components/landing/ScrollReveal'
import HowHero from '@/components/how-it-works/HowHero'
import StepsSection from '@/components/how-it-works/StepsSection'
import CodeWalkthrough from '@/components/how-it-works/CodeWalkthrough'
import WorkflowSection from '@/components/how-it-works/WorkflowSection'
import HowCta from '@/components/how-it-works/HowCta'

export const metadata: Metadata = {
  title: 'How it Works — Sandchest',
  description:
    'See how Sandchest works: add the SDK, create a sandbox, fork state, and replay everything. A few lines of TypeScript is all it takes.',
}

export default function HowItWorksPage() {
  return (
    <>
      <HowHero />
      <ScrollReveal>
        <StepsSection />
      </ScrollReveal>
      <ScrollReveal>
        <CodeWalkthrough />
      </ScrollReveal>
      <ScrollReveal>
        <WorkflowSection />
      </ScrollReveal>
      <ScrollReveal>
        <HowCta />
      </ScrollReveal>
    </>
  )
}
