import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const COMPONENT_PATH = join(import.meta.dir, 'ApiKeyManager.tsx')

describe('ApiKeyManager component', () => {
  const src = readFileSync(COMPONENT_PATH, 'utf-8')

  test('is a client component', () => {
    expect(src).toMatch(/^['"]use client['"]/)
  })

  test('uses useApiKeys hook for data fetching', () => {
    expect(src).toContain('useApiKeys')
    expect(src).toContain("from '@/hooks/use-api-keys'")
    expect(src).toMatch(/useApiKeys\(\)/)
  })

  test('uses useCreateApiKey hook for creating keys', () => {
    expect(src).toContain('useCreateApiKey')
    expect(src).toMatch(/useCreateApiKey\(\)/)
  })

  test('uses useRevokeApiKey hook for revoking keys', () => {
    expect(src).toContain('useRevokeApiKey')
    expect(src).toMatch(/useRevokeApiKey\(\)/)
  })

  test('does not use useEffect for data fetching', () => {
    expect(src).not.toMatch(/useEffect/)
  })

  test('does not import authClient directly', () => {
    expect(src).not.toMatch(/import.*authClient/)
  })

  test('uses createKey.mutate for key creation', () => {
    expect(src).toMatch(/createKey\.mutate\(/)
  })

  test('uses revokeKey.mutate for key revocation', () => {
    expect(src).toMatch(/revokeKey\.mutate\(/)
  })

  test('uses isPending for loading states', () => {
    expect(src).toMatch(/createKey\.isPending/)
    expect(src).toMatch(/revokeKey\.isPending/)
  })

  test('shows new key value after creation', () => {
    expect(src).toMatch(/newKeyValue/)
    expect(src).toMatch(/dash-key-reveal/)
  })

  test('renders key table with expected columns', () => {
    expect(src).toMatch(/dash-table/)
    expect(src).toMatch(/>Name</)
    expect(src).toMatch(/>Key</)
    expect(src).toMatch(/>Created</)
  })

  test('renders CopyButton for new key', () => {
    expect(src).toMatch(/CopyButton/)
  })

  test('resets mutation state on toggle', () => {
    expect(src).toMatch(/createKey\.reset\(\)/)
  })

  test('shows errors from query and mutations', () => {
    expect(src).toMatch(/\{error &&/)
    expect(src).toMatch(/mutationError/)
  })

  test('does not use console.log', () => {
    expect(src).not.toMatch(/console\.log/)
  })
})
