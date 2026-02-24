import type { Metadata } from 'next'
import Hero from '@/components/landing/Hero'
import BentoGrid from '@/components/landing/BentoGrid'
import CodeExample from '@/components/landing/CodeExample'
import Cta from '@/components/landing/Cta'
import ScrollReveal from '@/components/landing/ScrollReveal'

export const metadata: Metadata = {
  title: 'Sandchest — Linux Sandboxes for AI Agents',
  description:
    'Firecracker microVM sandboxes with sub-second fork, VM-grade isolation, and permanent session replay for AI agent code execution.',
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
