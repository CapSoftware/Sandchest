import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const COMPONENT_PATH = join(import.meta.dir, 'page.tsx')

describe('DashboardRedirect page', () => {
  const src = readFileSync(COMPONENT_PATH, 'utf-8')

  test('is a client component', () => {
    expect(src).toMatch(/^['"]use client['"]/)
  })

  test('uses useSession and useOrgs hooks', () => {
    expect(src).toMatch(/useSession\(\)/)
    expect(src).toMatch(/useOrgs\(\)/)
  })

  test('redirects to onboarding when no orgs exist', () => {
    expect(src).toMatch(/router\.replace\(['"]\/onboarding['"]\)/)
  })

  test('redirects to org-slug dashboard for active org', () => {
    expect(src).toMatch(/router\.replace\(`\/dashboard\/\$\{activeOrg\.slug\}`\)/)
  })

  test('falls back to first org when no active org matches', () => {
    expect(src).toMatch(/orgs\.find\(.+\) \?\? orgs\[0\]/)
  })

  test('returns null while loading', () => {
    expect(src).toMatch(/if \(sessionLoading \|\| orgsLoading\) return null/)
  })

  test('does not use console.log', () => {
    expect(src).not.toMatch(/console\.log/)
  })
})
