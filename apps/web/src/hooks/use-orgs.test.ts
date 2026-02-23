import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const HOOK_PATH = join(import.meta.dir, 'use-orgs.ts')

describe('useOrgs hook', () => {
  const src = readFileSync(HOOK_PATH, 'utf-8')

  test('is a client module', () => {
    expect(src).toMatch(/^['"]use client['"]/)
  })

  test('imports useQuery from @tanstack/react-query', () => {
    expect(src).toMatch(/import.*useQuery.*from ['"]@tanstack\/react-query['"]/)
  })

  test('imports authClient', () => {
    expect(src).toMatch(/import.*authClient.*from/)
  })

  test('exports useOrgs function', () => {
    expect(src).toMatch(/export function useOrgs/)
  })

  test('calls authClient.organization.list', () => {
    expect(src).toMatch(/authClient\.organization\.list\(\)/)
  })

  test('returns a useQuery result', () => {
    expect(src).toMatch(/return useQuery/)
  })

  test('uses orgs query key', () => {
    expect(src).toMatch(/queryKey:\s*\['orgs'\]/)
  })

  test('throws on error response', () => {
    expect(src).toMatch(/if \(error\) throw new Error/)
  })

  test('does not use console.log', () => {
    expect(src).not.toMatch(/console\.log/)
  })

  test('defines Org interface', () => {
    expect(src).toMatch(/interface Org/)
  })
})

describe('useSetActiveOrg hook', () => {
  const src = readFileSync(HOOK_PATH, 'utf-8')

  test('imports useMutation from @tanstack/react-query', () => {
    expect(src).toMatch(/import.*useMutation.*from ['"]@tanstack\/react-query['"]/)
  })

  test('exports useSetActiveOrg function', () => {
    expect(src).toMatch(/export function useSetActiveOrg/)
  })

  test('calls authClient.organization.setActive', () => {
    expect(src).toMatch(/authClient\.organization\.setActive/)
  })

  test('returns a useMutation result', () => {
    expect(src).toMatch(/return useMutation/)
  })

  test('invalidates queries on success', () => {
    expect(src).toMatch(/invalidateQueries/)
  })

  test('throws on error response', () => {
    expect(src).toMatch(/if \(error\) throw new Error/)
  })

  test('uses useQueryClient for cache invalidation', () => {
    expect(src).toMatch(/useQueryClient/)
  })
})
