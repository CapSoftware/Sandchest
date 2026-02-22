import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const HOOK_PATH = join(import.meta.dir, 'use-autumn-customer.ts')

describe('useAutumnCustomer hook', () => {
  const src = readFileSync(HOOK_PATH, 'utf-8')

  test('is a client module', () => {
    expect(src).toMatch(/^['"]use client['"]/)
  })

  test('imports useCustomer from autumn-js/react', () => {
    expect(src).toMatch(/import.*useCustomer.*from ['"]autumn-js\/react['"]/)
  })

  test('exports useAutumnCustomer function', () => {
    expect(src).toMatch(/export function useAutumnCustomer/)
  })

  test('derives activePlan from customer products', () => {
    expect(src).toMatch(/activePlan/)
    expect(src).toMatch(/status === ['"]active['"]/)
  })

  test('derives planName from activePlan', () => {
    expect(src).toMatch(/planName/)
  })

  test('derives featureUsage from customer features', () => {
    expect(src).toMatch(/featureUsage/)
    expect(src).toMatch(/customer\.features/)
  })

  test('exports FeatureUsage type', () => {
    expect(src).toMatch(/export type FeatureUsage/)
  })

  test('spreads useCustomer result for pass-through access', () => {
    expect(src).toMatch(/\.\.\.result/)
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
