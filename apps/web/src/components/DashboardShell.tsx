'use client'

import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { authClient } from '@/lib/auth-client'
import { useSession } from '@/hooks/use-session'
import { useOrgs, useSetActiveOrg } from '@/hooks/use-orgs'
import type { Org } from '@/hooks/use-orgs'

const navItems = [
  { href: '/dashboard', label: 'Sandboxes', id: 'sandboxes' },
  { href: '/dashboard/keys', label: 'API Keys', id: 'keys' },
  { href: '/dashboard/settings', label: 'Settings', id: 'settings' },
] as const

function getActiveId(pathname: string): string {
  if (pathname === '/dashboard') return 'sandboxes'
  if (pathname === '/dashboard/keys') return 'keys'
  if (pathname === '/dashboard/settings') return 'settings'
  return 'sandboxes'
}

function OrgSwitcher() {
  const { data: session } = useSession()
  const { data: orgs } = useOrgs()
  const setActiveOrg = useSetActiveOrg()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const activeOrgId = session?.session.activeOrganizationId
  const activeOrg = orgs?.find((o: Org) => o.id === activeOrgId)

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

  function handleSwitch(orgId: string) {
    setOpen(false)
    if (orgId !== activeOrgId) {
      setActiveOrg.mutate(orgId)
    }
  }

  const displayName = activeOrg?.name ?? 'Select org'
  const hasMultipleOrgs = orgs && orgs.length > 1

  return (
    <div className="org-switcher" ref={ref}>
      <button
        className="org-switcher-trigger"
        onClick={() => hasMultipleOrgs && setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={!hasMultipleOrgs}
      >
        <span className="org-switcher-avatar" aria-hidden="true">
          {displayName.charAt(0).toUpperCase()}
        </span>
        <span className="org-switcher-name">{displayName}</span>
        {hasMultipleOrgs && (
          <svg className="org-switcher-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 4.5L6 7.5L9 4.5" />
          </svg>
        )}
      </button>

      {open && orgs && (
        <div className="org-switcher-dropdown" role="listbox" aria-label="Switch organization">
          {orgs.map((org: Org) => (
            <button
              key={org.id}
              className={`org-switcher-option${org.id === activeOrgId ? ' active' : ''}`}
              role="option"
              aria-selected={org.id === activeOrgId}
              onClick={() => handleSwitch(org.id)}
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
  const pathname = usePathname()
  const active = getActiveId(pathname)
  const [mobileOpen, setMobileOpen] = useState(false)

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
