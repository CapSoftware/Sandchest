import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const HOOK_PATH = join(import.meta.dir, 'use-org-settings.ts')

describe('useOrgSettings hook', () => {
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

  test('exports useOrgSettings function', () => {
    expect(src).toMatch(/export function useOrgSettings/)
  })

  test('returns a useQuery result', () => {
    expect(src).toMatch(/return useQuery/)
  })

  test('calls authClient.organization.getFullOrganization', () => {
    expect(src).toMatch(/authClient\.organization\.getFullOrganization\(\)/)
  })

  test('uses orgSettings query key', () => {
    expect(src).toMatch(/orgSettingsKeys\.full\(\)/)
  })

  test('defines FullOrg interface with org and members', () => {
    expect(src).toMatch(/interface FullOrg/)
    expect(src).toMatch(/org:\s*OrgData/)
    expect(src).toMatch(/members:\s*OrgMember\[\]/)
  })

  test('defines orgSettingsKeys for cache management', () => {
    expect(src).toMatch(/const orgSettingsKeys/)
  })

  test('does not use console.log', () => {
    expect(src).not.toMatch(/console\.log/)
  })
})

describe('useUpdateOrgName hook', () => {
  const src = readFileSync(HOOK_PATH, 'utf-8')

  test('exports useUpdateOrgName function', () => {
    expect(src).toMatch(/export function useUpdateOrgName/)
  })

  test('calls authClient.organization.update', () => {
    expect(src).toMatch(/authClient\.organization\.update/)
  })

  test('implements optimistic update with onMutate', () => {
    expect(src).toMatch(/onMutate/)
  })

  test('cancels queries before optimistic update', () => {
    expect(src).toMatch(/cancelQueries/)
  })

  test('rolls back on error', () => {
    expect(src).toMatch(/onError/)
  })

  test('invalidates queries on settled', () => {
    expect(src).toMatch(/onSettled/)
    expect(src).toMatch(/invalidateQueries/)
  })
})

describe('useInviteMember hook', () => {
  const src = readFileSync(HOOK_PATH, 'utf-8')

  test('exports useInviteMember function', () => {
    expect(src).toMatch(/export function useInviteMember/)
  })

  test('calls authClient.organization.inviteMember', () => {
    expect(src).toMatch(/authClient\.organization\.inviteMember/)
  })

  test('invalidates queries on settled', () => {
    expect(src).toMatch(/invalidateQueries/)
  })
})

describe('useRemoveMember hook', () => {
  const src = readFileSync(HOOK_PATH, 'utf-8')

  test('exports useRemoveMember function', () => {
    expect(src).toMatch(/export function useRemoveMember/)
  })

  test('calls authClient.organization.removeMember', () => {
    expect(src).toMatch(/authClient\.organization\.removeMember/)
  })

  test('implements optimistic update with onMutate', () => {
    expect(src).toMatch(/onMutate/)
  })

  test('filters out member from cache optimistically', () => {
    expect(src).toMatch(/members\.filter/)
  })

  test('rolls back on error with previous data', () => {
    expect(src).toMatch(/onError/)
    expect(src).toMatch(/previous/)
  })

  test('invalidates queries on settled', () => {
    expect(src).toMatch(/onSettled/)
    expect(src).toMatch(/invalidateQueries/)
  })
})
