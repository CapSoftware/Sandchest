import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const HOOK_PATH = join(import.meta.dir, 'use-sandboxes.ts')

describe('useSandboxes hook', () => {
  const src = readFileSync(HOOK_PATH, 'utf-8')

  test('is a client module', () => {
    expect(src).toMatch(/^['"]use client['"]/)
  })

  test('imports useInfiniteQuery from @tanstack/react-query', () => {
    expect(src).toContain('useInfiniteQuery')
    expect(src).toContain("from '@tanstack/react-query'")
  })

  test('imports apiFetch', () => {
    expect(src).toContain('apiFetch')
    expect(src).toContain("from '@/lib/api'")
  })

  test('exports useSandboxes function', () => {
    expect(src).toMatch(/export function useSandboxes/)
  })

  test('accepts status filter parameter', () => {
    expect(src).toMatch(/function useSandboxes\(status/)
  })

  test('returns a useInfiniteQuery result', () => {
    expect(src).toMatch(/return useInfiniteQuery/)
  })

  test('uses sandboxes query key with status filter', () => {
    expect(src).toMatch(/sandboxKeys\.list\(status\)/)
  })

  test('uses getNextPageParam for cursor pagination', () => {
    expect(src).toMatch(/getNextPageParam/)
    expect(src).toMatch(/next_cursor/)
  })

  test('fetches from /v1/sandboxes endpoint', () => {
    expect(src).toMatch(/\/v1\/sandboxes/)
  })

  test('exports sandboxKeys for external cache management', () => {
    expect(src).toMatch(/export const sandboxKeys/)
  })

  test('does not use console.log', () => {
    expect(src).not.toMatch(/console\.log/)
  })
})

describe('useStopSandbox hook', () => {
  const src = readFileSync(HOOK_PATH, 'utf-8')

  test('imports useMutation from @tanstack/react-query', () => {
    expect(src).toContain('useMutation')
    expect(src).toContain("from '@tanstack/react-query'")
  })

  test('exports useStopSandbox function', () => {
    expect(src).toMatch(/export function useStopSandbox/)
  })

  test('returns a useMutation result', () => {
    expect(src).toMatch(/return useMutation/)
  })

  test('POSTs to the stop endpoint', () => {
    expect(src).toMatch(/\/stop/)
    expect(src).toMatch(/method:\s*['"]POST['"]/)
  })

  test('implements optimistic update with onMutate', () => {
    expect(src).toMatch(/onMutate/)
  })

  test('sets status to stopping optimistically', () => {
    expect(src).toContain("'stopping'")
  })

  test('cancels queries before optimistic update', () => {
    expect(src).toMatch(/cancelQueries/)
  })

  test('rolls back on error with previous data', () => {
    expect(src).toMatch(/onError/)
    expect(src).toMatch(/previousData/)
  })

  test('invalidates queries on settled', () => {
    expect(src).toMatch(/onSettled/)
    expect(src).toMatch(/invalidateQueries/)
  })

  test('uses useQueryClient for cache management', () => {
    expect(src).toMatch(/useQueryClient/)
  })
})
