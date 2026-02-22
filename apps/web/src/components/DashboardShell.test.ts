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

  test('uses useDashboardSession for session and org data', () => {
    expect(src).toMatch(/import.*useDashboardSession.*from ['"]@\/components\/DashboardSessionProvider['"]/)
  })

  test('uses useSetActiveOrg hook for mutations', () => {
    expect(src).toMatch(/import.*useSetActiveOrg.*from ['"]@\/hooks\/use-orgs['"]/)
  })

  test('builds nav items with org slug from URL params', () => {
    expect(src).toMatch(/`\/dashboard\/\$\{orgSlug\}`/)
    expect(src).toMatch(/`\/dashboard\/\$\{orgSlug\}\/keys`/)
    expect(src).toMatch(/`\/dashboard\/\$\{orgSlug\}\/billing`/)
    expect(src).toMatch(/`\/dashboard\/\$\{orgSlug\}\/settings`/)
  })

  test('detects active nav from path segments', () => {
    expect(src).toMatch(/segments\[3\]/)
    expect(src).toMatch(/page === 'keys'/)
    expect(src).toMatch(/page === 'billing'/)
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

  test('does not fetch session or orgs client-side (server handles auth)', () => {
    expect(src).not.toMatch(/useSession\(\)/)
    expect(src).not.toMatch(/useOrgs\(\)/)
    expect(src).not.toMatch(/sessionLoading/)
    expect(src).not.toMatch(/orgsLoading/)
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

  test('always shows trigger (no disabled state)', () => {
    // Trigger should not have a disabled condition — always clickable
    expect(src).not.toMatch(/disabled={!hasMultipleOrgs}/)
  })

  test('always shows chevron icon', () => {
    expect(src).toMatch(/org-switcher-chevron/)
    // Chevron should not be conditionally rendered
    const orgSwitcherBlock = src.slice(
      src.indexOf('function OrgSwitcher'),
      src.indexOf('function UserMenu'),
    )
    expect(orgSwitcherBlock).not.toMatch(/hasMultipleOrgs &&[\s\S]*?org-switcher-chevron/)
  })

  test('preserves current page suffix when switching orgs', () => {
    expect(src).toMatch(/currentPageSuffix/)
    expect(src).toMatch(/router\.push\(`\/dashboard\/\$\{org\.slug\}\$\{currentPageSuffix\(\)\}`\)/)
  })

  test('has create organization option in dropdown', () => {
    expect(src).toMatch(/org-switcher-create-trigger/)
    expect(src).toMatch(/Create organization/)
  })

  test('imports useCreateOrg hook', () => {
    expect(src).toMatch(/import.*useCreateOrg.*from ['"]@\/hooks\/use-create-org['"]/)
  })

  test('has inline create form with name input', () => {
    expect(src).toMatch(/org-switcher-create-form/)
    expect(src).toMatch(/org-switcher-create-input/)
    expect(src).toMatch(/Organization name/)
  })

  test('has create form submit and cancel actions', () => {
    expect(src).toMatch(/org-switcher-create-submit/)
    expect(src).toMatch(/org-switcher-create-cancel/)
  })

  test('shows error state on create failure', () => {
    expect(src).toMatch(/org-switcher-create-error/)
    expect(src).toMatch(/createError/)
  })

  test('slugifies org name for create', () => {
    expect(src).toMatch(/function slugify/)
    expect(src).toMatch(/slugify\(name\)/)
  })

  test('navigates to new org after creation', () => {
    expect(src).toMatch(/router\.push\(`\/dashboard\/\$\{data\.slug\}`\)/)
  })

  test('has divider between org list and create option', () => {
    expect(src).toMatch(/org-switcher-divider/)
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
    expect(getActiveIdBlock).toMatch(/return 'billing'/)
    expect(getActiveIdBlock).toMatch(/return 'settings'/)
  })
})
