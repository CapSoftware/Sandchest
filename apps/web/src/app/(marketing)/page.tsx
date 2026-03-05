import type { Metadata } from 'next'
import Hero from '@/components/landing/Hero'
import BentoGrid from '@/components/landing/BentoGrid'
import CodeExample from '@/components/landing/CodeExample'
import Cta from '@/components/landing/Cta'
import ScrollReveal from '@/components/landing/ScrollReveal'

export const metadata: Metadata = {
  title: 'Sandchest — The Sandbox Platform for AI Agents',
  description:
    'Bare metal Firecracker microVM sandboxes with sub-second forking, VM-grade isolation, and permanent session replay.',
}

export default function HomePage() {
  return (
    <>
      <Hero />
      <ScrollReveal>
        <BentoGrid />
      </ScrollReveal>
      <ScrollReveal>
        <CodeExample />
      </ScrollReveal>
      <ScrollReveal>
        <Cta />
      </ScrollReveal>
    </>
  )
}
