import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const HOOK_PATH = join(import.meta.dir, 'use-api-keys.ts')

describe('useApiKeys hook', () => {
  const src = readFileSync(HOOK_PATH, 'utf-8')

  test('is a client module', () => {
    expect(src).toMatch(/^['"]use client['"]/)
  })

  test('imports useQuery from @tanstack/react-query', () => {
    expect(src).toContain('useQuery')
    expect(src).toContain("from '@tanstack/react-query'")
  })

  test('imports authClient', () => {
    expect(src).toContain('authClient')
    expect(src).toContain("from '@/lib/auth-client'")
  })

  test('exports useApiKeys function', () => {
    expect(src).toMatch(/export function useApiKeys/)
  })

  test('returns a useQuery result', () => {
    expect(src).toMatch(/return useQuery/)
  })

  test('calls authClient.apiKey.list', () => {
    expect(src).toMatch(/authClient\.apiKey\.list\(\)/)
  })

  test('uses apiKeys query key', () => {
    expect(src).toMatch(/apiKeyKeys\.list\(\)/)
  })

  test('throws on error response', () => {
    expect(src).toMatch(/if \(error\) throw new Error/)
  })

  test('defines ApiKey interface', () => {
    expect(src).toMatch(/interface ApiKey/)
  })

  test('defines apiKeyKeys for cache management', () => {
    expect(src).toMatch(/const apiKeyKeys/)
  })

  test('does not use console.log', () => {
    expect(src).not.toMatch(/console\.log/)
  })
})

describe('useCreateApiKey hook', () => {
  const src = readFileSync(HOOK_PATH, 'utf-8')

  test('exports useCreateApiKey function', () => {
    expect(src).toMatch(/export function useCreateApiKey/)
  })

  test('calls authClient.apiKey.create', () => {
    expect(src).toMatch(/authClient\.apiKey\.create/)
  })

  test('invalidates api key queries on settled', () => {
    expect(src).toMatch(/invalidateQueries/)
    expect(src).toMatch(/apiKeyKeys\.list\(\)/)
  })
})

describe('useRevokeApiKey hook', () => {
  const src = readFileSync(HOOK_PATH, 'utf-8')

  test('exports useRevokeApiKey function', () => {
    expect(src).toMatch(/export function useRevokeApiKey/)
  })

  test('calls authClient.apiKey.delete', () => {
    expect(src).toMatch(/authClient\.apiKey\.delete/)
  })

  test('implements optimistic update with onMutate', () => {
    expect(src).toMatch(/onMutate/)
  })

  test('removes key from cache optimistically', () => {
    expect(src).toMatch(/filter/)
  })

  test('cancels queries before optimistic update', () => {
    expect(src).toMatch(/cancelQueries/)
  })

  test('rolls back on error with previous data', () => {
    expect(src).toMatch(/onError/)
    expect(src).toMatch(/previousKeys/)
  })

  test('invalidates queries on settled', () => {
    expect(src).toMatch(/onSettled/)
    expect(src).toMatch(/invalidateQueries/)
  })
})
