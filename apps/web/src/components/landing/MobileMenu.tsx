'use client'

import { useState } from 'react'

export default function MobileMenu() {
  const [isOpen, setIsOpen] = useState(false)

  function toggleMenu() {
    setIsOpen((prev) => !prev)
  }

  function closeMenu() {
    setIsOpen(false)
  }

  return (
    <>
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
