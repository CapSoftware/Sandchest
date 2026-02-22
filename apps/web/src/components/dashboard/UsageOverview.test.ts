import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const COMPONENT_PATH = join(import.meta.dir, 'UsageOverview.tsx')

describe('UsageOverview component', () => {
  const src = readFileSync(COMPONENT_PATH, 'utf-8')

  test('is a client component', () => {
    expect(src).toMatch(/^['"]use client['"]/)
  })

  test('imports useAutumnCustomer hook for billing data', () => {
    expect(src).toMatch(/import.*useAutumnCustomer.*from ['"]@\/hooks\/use-autumn-customer['"]/)
  })

  test('imports useSandboxes hook for active sandbox count', () => {
    expect(src).toMatch(/import.*useSandboxes.*from ['"]@\/hooks\/use-sandboxes['"]/)
  })

  test('renders plan name from billing data', () => {
    expect(src).toMatch(/planName/)
    expect(src).toMatch(/usage-overview-stat-value/)
  })

  test('computes active sandbox count from fetched sandboxes', () => {
    expect(src).toMatch(/activeSandboxes/)
    expect(src).toMatch(/status === 'running'/)
    expect(src).toMatch(/status === 'queued'/)
    expect(src).toMatch(/status === 'provisioning'/)
  })

  test('renders feature usage bars', () => {
    expect(src).toMatch(/usage-overview-bar-track/)
    expect(src).toMatch(/usage-overview-bar-fill/)
    expect(src).toMatch(/featureUsage\.map/)
  })

  test('handles unlimited features', () => {
    expect(src).toContain('Unlimited')
    expect(src).toMatch(/feature\.unlimited/)
  })

  test('shows warning style when usage is high', () => {
    expect(src).toMatch(/percent >= 90/)
    expect(src).toContain('warning')
  })

  test('shows loading state with skeleton', () => {
    expect(src).toMatch(/isLoading/)
    expect(src).toContain('UsageOverviewSkeleton')
  })

  test('flattens sandbox pages to get list', () => {
    expect(src).toMatch(/pages\.flatMap/)
  })

  test('does not use useEffect', () => {
    expect(src).not.toMatch(/useEffect/)
  })

  test('does not use console.log', () => {
    expect(src).not.toMatch(/console\.log/)
  })

  test('does not import apiFetch directly', () => {
    expect(src).not.toMatch(/import.*apiFetch/)
  })
})
