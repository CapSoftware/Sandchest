import Link from 'next/link'
import MobileMenu from './MobileMenu'

export default function Nav() {
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

        <MobileMenu />
      </nav>
    </>
  )
}
