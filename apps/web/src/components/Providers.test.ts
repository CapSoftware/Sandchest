import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const PROVIDERS_PATH = join(import.meta.dir, 'Providers.tsx')

describe('Providers', () => {
  const src = readFileSync(PROVIDERS_PATH, 'utf-8')

  test('is a client component', () => {
    expect(src).toMatch(/^['"]use client['"]/)
  })

  test('creates QueryClient with useState (stable across re-renders)', () => {
    expect(src).toMatch(/useState/)
    expect(src).toMatch(/QueryClient/)
  })

  test('wraps children in QueryClientProvider', () => {
    expect(src).toMatch(/QueryClientProvider/)
    expect(src).toMatch(/\{children\}/)
  })

  test('configures default query options', () => {
    expect(src).toMatch(/defaultOptions/)
    expect(src).toMatch(/staleTime/)
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
