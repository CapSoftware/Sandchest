'use client'

import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import { useParams, usePathname, useRouter } from 'next/navigation'
import { authClient } from '@/lib/auth-client'
import { useSession } from '@/hooks/use-session'
import { useOrgs, useSetActiveOrg } from '@/hooks/use-orgs'
import { useCreateOrg } from '@/hooks/use-create-org'
import type { Org } from '@/hooks/use-orgs'

function getActiveId(pathname: string): string {
  const segments = pathname.split('/')
  // /dashboard/[orgSlug]/keys → segments[3] = 'keys'
  const page = segments[3]
  if (page === 'keys') return 'keys'
  if (page === 'billing') return 'billing'
  if (page === 'settings') return 'settings'
  return 'sandboxes'
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

function OrgSwitcher() {
  const { data: session } = useSession()
  const { data: orgs } = useOrgs()
  const setActiveOrg = useSetActiveOrg()
  const createOrg = useCreateOrg()
  const router = useRouter()
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newOrgName, setNewOrgName] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const activeOrgId = session?.session.activeOrganizationId
  const activeOrg = orgs?.find((o: Org) => o.id === activeOrgId)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setCreating(false)
        setNewOrgName('')
        setCreateError(null)
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [open])

  useEffect(() => {
    if (creating && inputRef.current) {
      inputRef.current.focus()
    }
  }, [creating])

  function currentPageSuffix(): string {
    const segments = pathname.split('/')
    // /dashboard/[orgSlug]/keys → segments[3] = 'keys'
    const page = segments[3]
    return page ? `/${page}` : ''
  }

  function handleSwitch(org: Org) {
    setOpen(false)
    setCreating(false)
    setNewOrgName('')
    setCreateError(null)
    if (org.id !== activeOrgId) {
      setActiveOrg.mutate(org.id)
      router.push(`/dashboard/${org.slug}${currentPageSuffix()}`)
    }
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    const name = newOrgName.trim()
    if (!name) return
    const slug = slugify(name)
    if (!slug) {
      setCreateError('Invalid organization name')
      return
    }
    setCreateError(null)
    createOrg.mutate(
      { name, slug },
      {
        onSuccess: (data) => {
          setOpen(false)
          setCreating(false)
          setNewOrgName('')
          router.push(`/dashboard/${data.slug}`)
        },
        onError: (err) => {
          setCreateError(err instanceof Error ? err.message : 'Failed to create organization')
        },
      },
    )
  }

  const displayName = activeOrg?.name ?? 'Select org'

  return (
    <div className="org-switcher" ref={ref}>
      <button
        className="org-switcher-trigger"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span className="org-switcher-avatar" aria-hidden="true">
          {displayName.charAt(0).toUpperCase()}
        </span>
        <span className="org-switcher-name">{displayName}</span>
        <svg className="org-switcher-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 4.5L6 7.5L9 4.5" />
        </svg>
      </button>

      {open && orgs && (
        <div className="org-switcher-dropdown" role="listbox" aria-label="Switch organization">
          {orgs.map((org: Org) => (
            <button
              key={org.id}
              className={`org-switcher-option${org.id === activeOrgId ? ' active' : ''}`}
              role="option"
              aria-selected={org.id === activeOrgId}
              onClick={() => handleSwitch(org)}
            >
              <span className="org-switcher-avatar" aria-hidden="true">
                {org.name.charAt(0).toUpperCase()}
              </span>
              <span className="org-switcher-option-name">{org.name}</span>
              {org.id === activeOrgId && (
                <svg className="org-switcher-check" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 7L6 10L11 4" />
                </svg>
              )}
            </button>
          ))}

          <div className="org-switcher-divider" />

          {creating ? (
            <form className="org-switcher-create-form" onSubmit={handleCreate}>
              <input
                ref={inputRef}
                className="org-switcher-create-input"
                type="text"
                placeholder="Organization name"
                aria-label="Organization name"
                value={newOrgName}
                onChange={(e) => setNewOrgName(e.target.value)}
                disabled={createOrg.isPending}
              />
              {createError && (
                <span className="org-switcher-create-error">{createError}</span>
              )}
              <div className="org-switcher-create-actions">
                <button
                  type="button"
                  className="org-switcher-create-cancel"
                  onClick={() => {
                    setCreating(false)
                    setNewOrgName('')
                    setCreateError(null)
                  }}
                  disabled={createOrg.isPending}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="org-switcher-create-submit"
                  disabled={createOrg.isPending || !newOrgName.trim()}
                >
                  {createOrg.isPending ? 'Creating...' : 'Create'}
                </button>
              </div>
            </form>
          ) : (
            <button
              className="org-switcher-option org-switcher-create-trigger"
              onClick={() => setCreating(true)}
            >
              <span className="org-switcher-create-icon" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M7 3v8M3 7h8" />
                </svg>
              </span>
              <span className="org-switcher-option-name">Create organization</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function UserMenu() {
  const { data: session } = useSession()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const user = session?.user
  const displayName = user?.name || user?.email || ''
  const displayEmail = user?.email || ''

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [open])

  async function handleSignOut() {
    await authClient.signOut()
    router.push('/login')
  }

  return (
    <div className="user-menu" ref={ref}>
      <button
        className="user-menu-trigger"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span className="user-menu-avatar" aria-hidden="true">
          {displayName.charAt(0).toUpperCase()}
        </span>
        <span className="user-menu-info">
          <span className="user-menu-name">{displayName}</span>
          {user?.name && <span className="user-menu-email">{displayEmail}</span>}
        </span>
      </button>

      {open && (
        <div className="user-menu-dropdown" role="menu">
          <div className="user-menu-header">
            <span className="user-menu-header-name">{displayName}</span>
            <span className="user-menu-header-email">{displayEmail}</span>
          </div>
          <div className="user-menu-divider" />
          <button
            className="user-menu-item"
            role="menuitem"
            onClick={handleSignOut}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}

export default function DashboardShell({ children }: { children: React.ReactNode }) {
  const params = useParams<{ orgSlug: string }>()
  const pathname = usePathname()
  const router = useRouter()
  const active = getActiveId(pathname)
  const [mobileOpen, setMobileOpen] = useState(false)
  const { data: session, isPending: sessionLoading } = useSession()
  const { data: orgs, isPending: orgsLoading, error: orgsError } = useOrgs()
  const setActiveOrg = useSetActiveOrg()

  const orgSlug = params.orgSlug
  const activeOrgId = session?.session.activeOrganizationId
  const urlOrg = orgs?.find((o: Org) => o.slug === orgSlug)

  // Sync active org with URL slug (external system sync — valid useEffect)
  // Must be called before any conditional returns to satisfy React hooks rules
  useEffect(() => {
    if (urlOrg && urlOrg.id !== activeOrgId && !setActiveOrg.isPending) {
      setActiveOrg.mutate(urlOrg.id)
    }
  }, [urlOrg, activeOrgId, setActiveOrg])

  // Show loading state while session or orgs are being fetched
  if (sessionLoading || orgsLoading) {
    return (
      <div className="dash">
        <div className="dash-main">
          <div className="dash-empty">Loading...</div>
        </div>
      </div>
    )
  }

  // Show error state if orgs failed to load
  if (orgsError) {
    return (
      <div className="dash">
        <div className="dash-main">
          <div className="dash-empty">
            <p>Failed to load organizations.</p>
            <p className="dash-text-weak">
              {orgsError instanceof Error ? orgsError.message : 'An unexpected error occurred.'}
            </p>
          </div>
        </div>
      </div>
    )
  }

  // Redirect to onboarding if user has no organizations
  if (!orgs || orgs.length === 0) {
    router.replace('/onboarding')
    return null
  }

  // Redirect to /dashboard if slug doesn't match any user org
  if (!urlOrg) {
    router.replace('/dashboard')
    return null
  }

  const navItems = [
    { href: `/dashboard/${orgSlug}`, label: 'Sandboxes', id: 'sandboxes' },
    { href: `/dashboard/${orgSlug}/keys`, label: 'API Keys', id: 'keys' },
    { href: `/dashboard/${orgSlug}/billing`, label: 'Billing', id: 'billing' },
    { href: `/dashboard/${orgSlug}/settings`, label: 'Settings', id: 'settings' },
  ] as const

  return (
    <div className="dash">
      <aside className="dash-sidebar">
        <Link href="/" className="dash-logo" aria-label="Back to home">
          <img src="/sandchest-icon.svg" alt="Sandchest" height="28" />
        </Link>

        <OrgSwitcher />

        <nav className="dash-nav">
          {navItems.map((item) => (
            <Link
              key={item.id}
              href={item.href}
              className={`dash-nav-item${active === item.id ? ' active' : ''}`}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="dash-sidebar-footer">
          <UserMenu />
        </div>
      </aside>

      {/* Mobile header */}
      <header className="dash-mobile-header">
        <Link href="/" className="dash-logo" aria-label="Back to home">
          <img src="/sandchest-icon.svg" alt="Sandchest" height="24" />
        </Link>
        <button
          className="dash-mobile-toggle"
          aria-label="Toggle menu"
          onClick={() => setMobileOpen((prev) => !prev)}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <line x1="4" y1="7" x2="20" y2="7" />
            <line x1="4" y1="12" x2="20" y2="12" />
            <line x1="4" y1="17" x2="20" y2="17" />
          </svg>
        </button>
      </header>

      {/* Mobile dropdown */}
      <nav className={`dash-mobile-menu${mobileOpen ? ' open' : ''}`}>
        <div className="dash-mobile-org">
          <OrgSwitcher />
        </div>
        {navItems.map((item) => (
          <Link
            key={item.id}
            href={item.href}
            className={`dash-nav-item${active === item.id ? ' active' : ''}`}
            onClick={() => setMobileOpen(false)}
          >
            {item.label}
          </Link>
        ))}
        <div className="dash-mobile-user">
          <UserMenu />
        </div>
      </nav>

      <main className="dash-main">{children}</main>
    </div>
  )
}
