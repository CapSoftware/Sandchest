import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const COMPONENT_PATH = join(import.meta.dir, 'PricingSection.tsx')

describe('PricingSection component', () => {
  const src = readFileSync(COMPONENT_PATH, 'utf-8')

  test('is a client component', () => {
    expect(src).toMatch(/^['"]use client['"]/)
  })

  test('imports PricingTable from autumn-js/react', () => {
    expect(src).toMatch(/import.*PricingTable.*from ['"]autumn-js\/react['"]/)
  })

  test('renders PricingTable component', () => {
    expect(src).toContain('<PricingTable')
  })

  test('wraps table in dark-themed container', () => {
    expect(src).toContain('pricing-table-wrapper')
    expect(src).toContain('dark')
  })

  test('does not use useEffect', () => {
    expect(src).not.toMatch(/useEffect/)
  })

  test('does not use useState', () => {
    expect(src).not.toMatch(/useState/)
  })

  test('does not use console.log', () => {
    expect(src).not.toMatch(/console\.log/)
  })
})
