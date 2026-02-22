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

  test('imports and renders PricingSection', () => {
    expect(src).toContain("import PricingSection from '@/components/pricing/PricingSection'")
    expect(src).toContain('<PricingSection')
  })

  test('has page heading', () => {
    expect(src).toMatch(/<h1[\s\S]*?>[\s\S]*?Pricing[\s\S]*?<\/h1>/)
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
