import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const COMPONENT_PATH = join(import.meta.dir, 'OrgSettings.tsx')

describe('OrgSettings component', () => {
  const src = readFileSync(COMPONENT_PATH, 'utf-8')

  test('is a client component', () => {
    expect(src).toMatch(/^['"]use client['"]/)
  })

  test('uses useOrgSettings hook for data fetching', () => {
    expect(src).toContain('useOrgSettings')
    expect(src).toContain("from '@/hooks/use-org-settings'")
    expect(src).toMatch(/useOrgSettings\(\)/)
  })

  test('uses useUpdateOrgName hook', () => {
    expect(src).toContain('useUpdateOrgName')
    expect(src).toMatch(/useUpdateOrgName\(\)/)
  })

  test('uses useInviteMember hook', () => {
    expect(src).toContain('useInviteMember')
  })

  test('uses useRemoveMember hook', () => {
    expect(src).toContain('useRemoveMember')
  })

  test('useEffect is only used for cleanup, not data fetching', () => {
    // Effects should only be for cleanup (timers, subscriptions), not data fetching
    const effectBlocks = src.match(/useEffect\(\s*\(\)\s*=>\s*\{[^}]*\}/g) ?? []
    for (const block of effectBlocks) {
      expect(block).not.toMatch(/fetch\(/)
      expect(block).not.toMatch(/authClient/)
    }
  })

  test('does not import authClient directly', () => {
    expect(src).not.toMatch(/import.*authClient/)
  })

  test('uses mutation.mutate for all operations', () => {
    expect(src).toMatch(/updateName\.mutate\(/)
    expect(src).toMatch(/invite\.mutate\(/)
    expect(src).toMatch(/removeMember\.mutate\(/)
  })

  test('uses isPending for loading states', () => {
    expect(src).toMatch(/updateName\.isPending/)
    expect(src).toMatch(/invite\.isPending/)
    expect(src).toMatch(/removeMember\.isPending/)
  })

  test('renders org name form', () => {
    expect(src).toMatch(/dash-inline-form/)
    expect(src).toMatch(/org-name/)
  })

  test('renders members table', () => {
    expect(src).toMatch(/dash-table/)
    expect(src).toMatch(/>Email</)
    expect(src).toMatch(/>Name</)
    expect(src).toMatch(/>Role</)
  })

  test('renders invite form', () => {
    expect(src).toMatch(/dash-invite-form/)
    expect(src).toMatch(/inviteEmail/)
    expect(src).toMatch(/inviteRole/)
  })

  test('shows saved confirmation after update', () => {
    expect(src).toMatch(/updateSuccess/)
    expect(src).toMatch(/Saved/)
  })

  test('shows errors from query and mutations', () => {
    expect(src).toMatch(/\{error &&/)
    expect(src).toMatch(/mutationError/)
  })

  test('does not use console.log', () => {
    expect(src).not.toMatch(/console\.log/)
  })
})
