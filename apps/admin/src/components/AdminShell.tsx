'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'

const NAV_ITEMS = [
  { href: '/servers', label: 'Servers' },
]

export default function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/login')
  }

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <div className="admin-sidebar-logo">sandchest admin</div>
        <nav className="admin-sidebar-nav">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="admin-sidebar-link"
              data-active={pathname.startsWith(item.href)}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div style={{ marginTop: 'auto' }}>
          <button onClick={handleLogout} className="btn btn-sm" style={{ width: '100%' }}>
            Logout
          </button>
        </div>
      </aside>
      <main className="admin-content">{children}</main>
    </div>
  )
}
