import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const HOOK_PATH = join(import.meta.dir, 'use-current-org.ts')

describe('useCurrentOrg hook', () => {
  const src = readFileSync(HOOK_PATH, 'utf-8')

  test('is a client module', () => {
    expect(src).toMatch(/^['"]use client['"]/)
  })

  test('imports useParams from next/navigation', () => {
    expect(src).toMatch(/import.*useParams.*from ['"]next\/navigation['"]/)
  })

  test('imports useOrgs from use-orgs', () => {
    expect(src).toMatch(/import.*useOrgs.*from ['"]\.\/use-orgs['"]/)
  })

  test('exports useCurrentOrg function', () => {
    expect(src).toMatch(/export function useCurrentOrg/)
  })

  test('exports CurrentOrgResult interface', () => {
    expect(src).toMatch(/export interface CurrentOrgResult/)
  })

  test('reads orgSlug from URL params', () => {
    expect(src).toMatch(/useParams<\{ orgSlug: string \}>/)
  })

  test('finds org by matching slug', () => {
    expect(src).toMatch(/orgs\?\.find\(/)
    expect(src).toMatch(/\.slug === params\.orgSlug/)
  })

  test('returns org, isLoading, and error', () => {
    expect(src).toMatch(/org/)
    expect(src).toMatch(/isLoading/)
    expect(src).toMatch(/error/)
  })

  test('maps isPending to isLoading', () => {
    expect(src).toMatch(/isPending/)
    expect(src).toMatch(/isLoading: isPending/)
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
