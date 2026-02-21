import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const COMPONENT_PATH = join(import.meta.dir, 'EmailForm.tsx')

describe('EmailForm component', () => {
  const src = readFileSync(COMPONENT_PATH, 'utf-8')

  test('is a client component', () => {
    expect(src).toMatch(/^['"]use client['"]/)
  })

  test('uses useSendOtp mutation hook', () => {
    expect(src).toMatch(/import.*useSendOtp.*from/)
    expect(src).toMatch(/useSendOtp\(\)/)
  })

  test('does not call authClient directly', () => {
    expect(src).not.toMatch(/authClient\.emailOtp/)
    expect(src).not.toMatch(/import.*authClient/)
  })

  test('uses mutation.mutate for form submission', () => {
    expect(src).toMatch(/sendOtp\.mutate\(/)
  })

  test('uses mutation isPending for loading state', () => {
    expect(src).toMatch(/sendOtp\.isPending/)
  })

  test('uses mutation error for error display', () => {
    expect(src).toMatch(/sendOtp\.error/)
  })

  test('uses mutation reset to clear errors on input change', () => {
    expect(src).toMatch(/sendOtp\.reset\(\)/)
  })

  test('does not use manual loading state', () => {
    expect(src).not.toMatch(/useState\(false\)/)
    expect(src).not.toMatch(/setLoading/)
  })

  test('validates email before calling mutation', () => {
    expect(src).toMatch(/isValidEmail/)
  })

  test('redirects to verify page on success', () => {
    expect(src).toMatch(/\/verify\?email=/)
  })

  test('renders alt link for alternate auth flow', () => {
    expect(src).toMatch(/altHref/)
    expect(src).toMatch(/Link/)
  })

  test('does not use console.log', () => {
    expect(src).not.toMatch(/console\.log/)
  })

  test('does not use any type', () => {
    const lines = src.split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('//')) continue
      expect(trimmed).not.toMatch(/:\s*any\b/)
      expect(trimmed).not.toMatch(/as\s+any\b/)
    }
  })
})
