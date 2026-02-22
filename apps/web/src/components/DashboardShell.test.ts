import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const COMPONENT_PATH = join(import.meta.dir, 'DashboardShell.tsx')

describe('DashboardShell component', () => {
  const src = readFileSync(COMPONENT_PATH, 'utf-8')

  test('is a client component', () => {
    expect(src).toMatch(/^['"]use client['"]/)
  })

  test('uses useParams for org slug extraction', () => {
    expect(src).toMatch(/import.*useParams.*from ['"]next\/navigation['"]/)
    expect(src).toMatch(/useParams<\{ orgSlug: string \}>/)
  })

  test('uses usePathname for active nav detection', () => {
    expect(src).toMatch(/import.*usePathname.*from ['"]next\/navigation['"]/)
    expect(src).toMatch(/usePathname\(\)/)
  })

  test('uses useSession hook for session data', () => {
    expect(src).toMatch(/import.*useSession.*from ['"]@\/hooks\/use-session['"]/)
  })

  test('uses useOrgs and useSetActiveOrg hooks', () => {
    expect(src).toMatch(/import.*useOrgs.*from ['"]@\/hooks\/use-orgs['"]/)
    expect(src).toMatch(/import.*useSetActiveOrg.*from ['"]@\/hooks\/use-orgs['"]/)
  })

  test('builds nav items with org slug from URL params', () => {
    expect(src).toMatch(/`\/dashboard\/\$\{orgSlug\}`/)
    expect(src).toMatch(/`\/dashboard\/\$\{orgSlug\}\/keys`/)
    expect(src).toMatch(/`\/dashboard\/\$\{orgSlug\}\/settings`/)
  })

  test('detects active nav from path segments', () => {
    expect(src).toMatch(/segments\[3\]/)
    expect(src).toMatch(/page === 'keys'/)
    expect(src).toMatch(/page === 'settings'/)
  })

  test('renders nav links with active state', () => {
    expect(src).toMatch(/dash-nav-item/)
    expect(src).toMatch(/active/)
  })

  test('has sidebar and mobile layout', () => {
    expect(src).toMatch(/dash-sidebar/)
    expect(src).toMatch(/dash-mobile-header/)
    expect(src).toMatch(/dash-mobile-menu/)
  })

  test('redirects to onboarding when user has no orgs', () => {
    expect(src).toMatch(/needsOnboarding/)
    expect(src).toMatch(/router\.replace\(['"]\/onboarding['"]\)/)
  })

  test('redirects to /dashboard when slug does not match any user org', () => {
    expect(src).toMatch(/!urlOrg/)
    expect(src).toMatch(/router\.replace\(['"]\/dashboard['"]\)/)
  })

  test('syncs active org with URL slug via useEffect', () => {
    expect(src).toMatch(/urlOrg && urlOrg\.id !== activeOrgId/)
    expect(src).toMatch(/setActiveOrg\.mutate\(urlOrg\.id\)/)
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

describe('OrgSwitcher', () => {
  const src = readFileSync(COMPONENT_PATH, 'utf-8')

  test('renders org switcher with trigger button', () => {
    expect(src).toMatch(/org-switcher-trigger/)
  })

  test('displays org avatar initial', () => {
    expect(src).toMatch(/org-switcher-avatar/)
    expect(src).toMatch(/charAt\(0\)\.toUpperCase\(\)/)
  })

  test('renders org name in trigger', () => {
    expect(src).toMatch(/org-switcher-name/)
  })

  test('has dropdown with org options', () => {
    expect(src).toMatch(/org-switcher-dropdown/)
    expect(src).toMatch(/org-switcher-option/)
  })

  test('shows check mark for active org', () => {
    expect(src).toMatch(/org-switcher-check/)
  })

  test('uses aria attributes for accessibility', () => {
    expect(src).toMatch(/aria-expanded/)
    expect(src).toMatch(/aria-haspopup/)
    expect(src).toMatch(/role="listbox"/)
    expect(src).toMatch(/role="option"/)
    expect(src).toMatch(/aria-selected/)
  })

  test('closes dropdown on outside click', () => {
    expect(src).toMatch(/handleClickOutside/)
    expect(src).toMatch(/mousedown/)
  })

  test('calls setActiveOrg.mutate on org switch', () => {
    expect(src).toMatch(/setActiveOrg\.mutate\(/)
  })

  test('navigates to new org slug on switch', () => {
    expect(src).toMatch(/router\.push\(`\/dashboard\/\$\{org\.slug\}`\)/)
  })

  test('disables trigger when only one org', () => {
    expect(src).toMatch(/hasMultipleOrgs/)
    expect(src).toMatch(/disabled={!hasMultipleOrgs}/)
  })
})

describe('UserMenu', () => {
  const src = readFileSync(COMPONENT_PATH, 'utf-8')

  test('renders user avatar with initial', () => {
    expect(src).toMatch(/user-menu-avatar/)
  })

  test('displays user name and email', () => {
    expect(src).toMatch(/user-menu-name/)
    expect(src).toMatch(/user-menu-email/)
  })

  test('has dropdown with sign out option', () => {
    expect(src).toMatch(/user-menu-dropdown/)
    expect(src).toMatch(/Sign out/)
  })

  test('uses aria attributes for accessibility', () => {
    expect(src).toMatch(/aria-expanded/)
    expect(src).toMatch(/aria-haspopup="menu"/)
    expect(src).toMatch(/role="menu"/)
    expect(src).toMatch(/role="menuitem"/)
  })

  test('closes menu on outside click', () => {
    expect(src).toMatch(/handleClickOutside/)
  })

  test('calls authClient.signOut on sign out', () => {
    expect(src).toMatch(/authClient\.signOut\(\)/)
  })

  test('redirects to login after sign out', () => {
    expect(src).toMatch(/\/login/)
  })

  test('imports useRouter from next/navigation', () => {
    expect(src).toMatch(/import.*useRouter.*from ['"]next\/navigation['"]/)
  })
})

describe('getActiveId', () => {
  const src = readFileSync(COMPONENT_PATH, 'utf-8')

  test('extracts page from path segments', () => {
    const getActiveIdBlock = src.slice(
      src.indexOf('function getActiveId'),
      src.indexOf('function OrgSwitcher'),
    )
    expect(getActiveIdBlock).toMatch(/segments\[3\]/)
    expect(getActiveIdBlock).toMatch(/return 'sandboxes'/)
    expect(getActiveIdBlock).toMatch(/return 'keys'/)
    expect(getActiveIdBlock).toMatch(/return 'settings'/)
  })
})
