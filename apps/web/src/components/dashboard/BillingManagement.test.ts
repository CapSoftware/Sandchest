import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const COMPONENT_PATH = join(import.meta.dir, 'BillingManagement.tsx')

describe('BillingManagement component', () => {
  const src = readFileSync(COMPONENT_PATH, 'utf-8')

  test('is a client component', () => {
    expect(src).toMatch(/^['"]use client['"]/)
  })

  test('imports useAutumnCustomer hook', () => {
    expect(src).toMatch(/import.*useAutumnCustomer.*from ['"]@\/hooks\/use-autumn-customer['"]/)
  })

  test('imports useCustomer from autumn-js/react', () => {
    expect(src).toMatch(/import.*useCustomer.*from ['"]autumn-js\/react['"]/)
  })

  test('imports PricingTable from autumn-js/react', () => {
    expect(src).toMatch(/import.*PricingTable.*from ['"]autumn-js\/react['"]/)
  })

  test('renders page title as Billing', () => {
    expect(src).toMatch(/dash-page-title/)
    expect(src).toContain('>Billing<')
  })

  test('shows Manage Billing button that opens billing portal', () => {
    expect(src).toMatch(/openBillingPortal/)
    expect(src).toContain('Manage Billing')
  })

  test('displays current plan name', () => {
    expect(src).toMatch(/billing-plan-name/)
    expect(src).toMatch(/planName/)
  })

  test('shows active plan status badge', () => {
    expect(src).toMatch(/billing-plan-status/)
    expect(src).toContain('>Active<')
  })

  test('renders credit balance card', () => {
    expect(src).toMatch(/billing-credits-card/)
    expect(src).toMatch(/Credit Balance/)
    expect(src).toMatch(/creditBalance/)
  })

  test('shows buy credits section with topup options and error handling', () => {
    expect(src).toContain('Buy Credits')
    expect(src).toMatch(/credits-topup-10/)
    expect(src).toMatch(/credits-topup-50/)
    expect(src).toMatch(/credits-topup-100/)
    expect(src).toMatch(/setError/)
    expect(src).toMatch(/billing-topup-error/)
  })

  test('shows warning style when usage is high', () => {
    expect(src).toMatch(/percent >= 90/)
    expect(src).toContain('warning')
  })

  test('renders PricingTable for plan selection', () => {
    expect(src).toContain('<PricingTable')
    expect(src).toContain('pricing-table-wrapper')
  })

  test('shows loading state via BillingSkeleton', () => {
    expect(src).toMatch(/isLoading/)
    expect(src).toContain('BillingSkeleton')
  })

  test('does not use useEffect', () => {
    expect(src).not.toMatch(/useEffect/)
  })

  test('does not use console.log', () => {
    expect(src).not.toMatch(/console\.log/)
  })
})
