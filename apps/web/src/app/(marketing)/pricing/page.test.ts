import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const PAGE_PATH = join(import.meta.dir, 'page.tsx')

describe('pricing page', () => {
  const src = readFileSync(PAGE_PATH, 'utf-8')

  test('is a server component (no use client directive)', () => {
    expect(src).not.toMatch(/^['"]use client['"]/)
  })

  test('exports page metadata with title and description', () => {
    expect(src).toContain('export const metadata')
    expect(src).toContain('Pricing')
    expect(src).toContain('description')
  })

  test('imports and renders Nav component', () => {
    expect(src).toContain("import Nav from '@/components/landing/Nav'")
    expect(src).toContain('<Nav')
  })

  test('imports and renders pricing components', () => {
    expect(src).toContain("import PricingHero from '@/components/pricing/PricingHero'")
    expect(src).toContain("import PricingCards from '@/components/pricing/PricingCards'")
    expect(src).toContain("import UsageCalculator from '@/components/pricing/UsageCalculator'")
    expect(src).toContain("import PricingCompare from '@/components/pricing/PricingCompare'")
    expect(src).toContain("import PricingFaq from '@/components/pricing/PricingFaq'")
    expect(src).toContain('<PricingHero')
    expect(src).toContain('<PricingCards')
    expect(src).toContain('<UsageCalculator')
    expect(src).toContain('<PricingCompare')
    expect(src).toContain('<PricingFaq')
  })

  test('uses ScrollReveal for entrance animations', () => {
    expect(src).toContain("import ScrollReveal from '@/components/landing/ScrollReveal'")
    expect(src).toContain('<ScrollReveal')
  })

  test('includes OpenGraph metadata', () => {
    expect(src).toContain('openGraph')
  })

  test('does not use React hooks (server component)', () => {
    expect(src).not.toMatch(/\buseState\b/)
    expect(src).not.toMatch(/\buseEffect\b/)
    expect(src).not.toMatch(/\buseRef\b/)
  })
})
