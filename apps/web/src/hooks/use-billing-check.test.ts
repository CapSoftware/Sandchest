import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const HOOK_PATH = join(import.meta.dir, 'use-billing-check.ts')

describe('useBillingCheck hook', () => {
  const src = readFileSync(HOOK_PATH, 'utf-8')

  test('is a client module', () => {
    expect(src).toMatch(/^['"]use client['"]/)
  })

  test('imports useCustomer from autumn-js/react', () => {
    expect(src).toMatch(/import.*useCustomer.*from ['"]autumn-js\/react['"]/)
  })

  test('exports useBillingCheck function', () => {
    expect(src).toMatch(/export function useBillingCheck/)
  })

  test('accepts featureId parameter', () => {
    expect(src).toMatch(/useBillingCheck\(featureId: string\)/)
  })

  test('defines BillingCheckResult type', () => {
    expect(src).toMatch(/type BillingCheckResult/)
  })

  test('returns allowed, balance, usage, and unlimited fields', () => {
    expect(src).toMatch(/allowed/)
    expect(src).toMatch(/balance/)
    expect(src).toMatch(/usage/)
    expect(src).toMatch(/unlimited/)
  })

  test('handles null customer gracefully', () => {
    expect(src).toMatch(/!customer/)
  })

  test('handles missing feature gracefully', () => {
    expect(src).toMatch(/!feature/)
  })

  test('uses check from useCustomer for access verification', () => {
    expect(src).toMatch(/check\(/)
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
