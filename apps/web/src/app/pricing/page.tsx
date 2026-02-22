import type { Metadata } from 'next'
import Nav from '@/components/landing/Nav'
import PricingSection from '@/components/pricing/PricingSection'

export const metadata: Metadata = {
  title: 'Pricing — Sandchest',
  description:
    'Simple, transparent pricing for AI agent sandboxes. Start free, scale as you grow.',
  openGraph: {
    title: 'Pricing — Sandchest',
    description:
      'Simple, transparent pricing for AI agent sandboxes. Start free, scale as you grow.',
    images: ['/og.png'],
    type: 'website',
  },
}

export default function PricingPage() {
  return (
    <main className="flex flex-col pb-20" style={{ gap: 'var(--vertical-padding)' }}>
      <div className="page-container">
        <Nav />
        <div className="section">
          <div className="section-header" style={{ textAlign: 'center', marginBottom: 48 }}>
            <h1
              className="text-text-strong"
              style={{ fontSize: 28, fontWeight: 700, marginBottom: 12 }}
            >
              Pricing
            </h1>
            <p className="text-text-weak" style={{ fontSize: 14, maxWidth: 480, margin: '0 auto' }}>
              Start free. Pay only for what you use. Scale without limits.
            </p>
          </div>
          <PricingSection />
        </div>
      </div>
      <div className="text-center text-text-weak text-[13px]">
        <span>&copy; 2026 Sandchest.com</span>
      </div>
    </main>
  )
}
