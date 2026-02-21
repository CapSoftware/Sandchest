'use client'

import { useState } from 'react'
import Link from 'next/link'

export default function Nav() {
  const [isOpen, setIsOpen] = useState(false)

  function toggleMenu() {
    setIsOpen((prev) => !prev)
  }

  function closeMenu() {
    setIsOpen(false)
  }

  return (
    <>
      <nav
        className="nav-bar sticky top-0 z-10 flex items-center justify-between bg-background"
      >
        <Link href="/" className="flex items-center no-underline hover:no-underline">
          <img src="/sandchest-logo-dark.svg" alt="Sandchest" style={{ height: 48 }} />
        </Link>

        <ul className="hidden items-center sm:flex" style={{ gap: 48 }}>
          <li>
            <a href="#features" className="text-text-weak transition-colors hover:text-text-strong">
              What is Sandchest?
            </a>
          </li>
          <li>
            <a href="#code" className="text-text-weak transition-colors hover:text-text-strong">
              See it in action
            </a>
          </li>
          <li>
            <Link href="/login" className="text-text-weak transition-colors hover:text-text-strong">
              Log in
            </Link>
          </li>
          <li className="star-item">
            <a
              href="https://github.com/sandchest"
              target="_blank"
              rel="noopener"
              className="inline-flex items-center gap-2 bg-text-strong font-medium no-underline transition-all duration-200 hover:bg-white hover:no-underline whitespace-nowrap"
              style={{ padding: '8px 16px 8px 10px', borderRadius: 4, color: 'var(--color-background)' }}
            >
              <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
              Star on GitHub
            </a>
          </li>
        </ul>

        {/* Mobile menu button */}
        <button
          className="nav-mobile-toggle flex items-center justify-center sm:hidden"
          aria-label="Toggle menu"
          aria-expanded={isOpen}
          onClick={toggleMenu}
        >
          {isOpen ? (
            <svg className="h-6 w-6 text-text-strong" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="6" y1="18" x2="18" y2="6" />
            </svg>
          ) : (
            <svg className="h-6 w-6 text-text-strong" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="4" y1="7" x2="20" y2="7" />
              <line x1="4" y1="12" x2="20" y2="12" />
              <line x1="4" y1="17" x2="20" y2="17" />
            </svg>
          )}
        </button>
      </nav>

      {/* Mobile dropdown menu */}
      {isOpen && (
        <div
          className="fixed left-0 right-0 z-[9] bg-background sm:hidden"
          style={{ top: 80, borderBottom: '1px solid var(--color-border-weak)', padding: '16px var(--padding) 24px' }}
        >
          <div className="flex flex-col" style={{ gap: 20 }}>
            <a href="#features" onClick={closeMenu} className="nav-mobile-link text-text-weak transition-colors hover:text-text-strong">
              What is Sandchest?
            </a>
            <a href="#code" onClick={closeMenu} className="nav-mobile-link text-text-weak transition-colors hover:text-text-strong">
              See it in action
            </a>
            <Link href="/login" onClick={closeMenu} className="nav-mobile-link text-text-weak transition-colors hover:text-text-strong">
              Log in
            </Link>
            <a
              href="https://github.com/sandchest"
              target="_blank"
              rel="noopener"
              className="inline-flex items-center justify-center gap-2 bg-text-strong font-medium no-underline transition-all duration-200 hover:bg-white hover:no-underline"
              style={{ padding: '12px 18px', borderRadius: 4, color: 'var(--color-background)', marginTop: 4 }}
            >
              <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
              Star on GitHub
            </a>
          </div>
        </div>
      )}

    </>
  )
}
