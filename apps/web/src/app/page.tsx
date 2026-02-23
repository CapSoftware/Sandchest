import type { Metadata } from 'next'
import Nav from '@/components/landing/Nav'
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
    <main className="flex flex-col pb-20" style={{ gap: 'var(--vertical-padding)' }}>
      <div className="page-container">
        <Nav />
        <div>
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
        </div>
      </div>
      <div className="text-center text-text-weak text-[13px]">
        <span>&copy; 2026 Sandchest.com</span>
      </div>
    </main>
  )
}
