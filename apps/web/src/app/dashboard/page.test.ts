import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const COMPONENT_PATH = join(import.meta.dir, 'page.tsx')

describe('DashboardRedirect page', () => {
  const src = readFileSync(COMPONENT_PATH, 'utf-8')

  test('is a server component (no use client directive)', () => {
    expect(src).not.toMatch(/^['"]use client['"]/)
  })

  test('uses server auth utilities', () => {
    expect(src).toMatch(/import.*getSession.*from ['"]@\/lib\/server-auth['"]/)
    expect(src).toMatch(/import.*getOrgs.*from ['"]@\/lib\/server-auth['"]/)
  })

  test('redirects to login when no session', () => {
    expect(src).toMatch(/redirect\(['"]\/login['"]\)/)
  })

  test('redirects to onboarding when no orgs exist', () => {
    expect(src).toMatch(/redirect\(['"]\/onboarding['"]\)/)
  })

  test('redirects to org-slug dashboard for active org', () => {
    expect(src).toMatch(/redirect\(`\/dashboard\/\$\{activeOrg\.slug\}`\)/)
  })

  test('falls back to first org when no active org matches', () => {
    expect(src).toMatch(/orgs\.find\(.+\) \?\? orgs\[0\]/)
  })

  test('does not use console.log', () => {
    expect(src).not.toMatch(/console\.log/)
  })
})
