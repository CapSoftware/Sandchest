'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { authClient } from '@/lib/auth-client'

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

export default function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const active = getActiveId(pathname)
  const [mobileOpen, setMobileOpen] = useState(false)

  async function handleSignOut() {
    await authClient.signOut()
    window.location.href = '/login'
  }

  return (
    <div className="dash">
      <aside className="dash-sidebar">
        <Link href="/" className="dash-logo" aria-label="Back to home">
          <img src="/sandchest-icon.svg" alt="Sandchest" height="28" />
        </Link>
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
          <button onClick={handleSignOut} className="dash-nav-item sign-out">
            Sign out
          </button>
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
        <button onClick={handleSignOut} className="dash-nav-item sign-out">
          Sign out
        </button>
      </nav>

      <main className="dash-main">{children}</main>
    </div>
  )
}
