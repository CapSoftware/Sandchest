import type { Metadata } from 'next'
import ScrollReveal from '@/components/landing/ScrollReveal'
import WhatHero from '@/components/what-is-sandchest/WhatHero'
import ProblemSection from '@/components/what-is-sandchest/ProblemSection'
import PillarsSection from '@/components/what-is-sandchest/PillarsSection'
import UseCasesSection from '@/components/what-is-sandchest/UseCasesSection'
import ArchitectureSection from '@/components/what-is-sandchest/ArchitectureSection'
import WhatCta from '@/components/what-is-sandchest/WhatCta'

export const metadata: Metadata = {
  title: 'What is Sandchest? — The Sandbox Platform for AI Agents',
  description:
    'Sandchest gives AI agents fast, isolated Linux environments powered by Firecracker microVMs. Sub-second forking, session replay, and VM-grade isolation.',
}

export default function WhatIsSandchestPage() {
  return (
    <>
      <WhatHero />
      <ScrollReveal>
        <ProblemSection />
      </ScrollReveal>
      <ScrollReveal>
        <PillarsSection />
      </ScrollReveal>
      <ScrollReveal>
        <UseCasesSection />
      </ScrollReveal>
      <ScrollReveal>
        <ArchitectureSection />
      </ScrollReveal>
      <ScrollReveal>
        <WhatCta />
      </ScrollReveal>
    </>
  )
}
