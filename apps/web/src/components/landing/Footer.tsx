import Link from 'next/link'

const productLinks = [
  { label: 'What is Sandchest?', href: '/what-is-sandchest' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Compare', href: '/compare' },
  { label: 'Dashboard', href: '/dashboard' },
  { label: 'Changelog', href: '/changelog' },
]

const developerLinks = [
  { label: 'Documentation', href: 'https://docs.sandchest.com' },
  { label: 'SDK Reference', href: 'https://docs.sandchest.com/sdk' },
  { label: 'MCP Server', href: 'https://docs.sandchest.com/mcp' },
  { label: 'CLI', href: 'https://docs.sandchest.com/cli' },
  { label: 'API Reference', href: 'https://docs.sandchest.com/api' },
]

const resourceLinks = [
  { label: 'Blog', href: '/blog' },
  { label: 'Guides', href: '/guides' },
  { label: 'Status', href: '/status' },
  { label: 'Security', href: '/security' },
]

const companyLinks = [
  { label: 'About', href: '/about' },
  { label: 'GitHub', href: 'https://github.com/CapSoftware/Sandchest' },
  { label: 'Twitter / X', href: 'https://x.com/sandchest' },
  { label: 'Discord', href: 'https://discord.gg/sandchest' },
  { label: 'Contact', href: '/contact' },
]

function FooterColumn({
  title,
  links,
}: {
  title: string
  links: { label: string; href: string }[]
}) {
  const isExternal = (href: string) => href.startsWith('http')

  return (
    <div className="footer-column">
      <p className="footer-column-title">{title}</p>
      <ul className="footer-column-list">
        {links.map((link) => (
          <li key={link.href}>
            {isExternal(link.href) ? (
              <a
                href={link.href}
                target="_blank"
                rel="noopener"
                className="footer-link"
              >
                {link.label}
              </a>
            ) : (
              <Link href={link.href} className="footer-link">
                {link.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

export default function Footer() {
  return (
    <footer className="footer">
      {/* CTA banner + brand watermark */}
      <div className="footer-cta">
        <div className="footer-cta-inner">
          <h2 className="footer-cta-headline">
            Ship faster without<br />
            compromising isolation.
          </h2>
          <div className="footer-cta-right">
            <p className="footer-cta-desc">
              See how teams use Sandchest to run untrusted code
              in sub-second Firecracker sandboxes.
            </p>
            <a href="/dashboard" className="follow-btn no-underline hover:no-underline">
              Get Started
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 17L17 7M17 7H7M17 7v10" />
              </svg>
            </a>
          </div>
        </div>
        <div className="footer-brand-watermark">
          <div className="footer-brand-fade" />
          <img
            src="/skyline.jpg"
            alt=""
            className="footer-brand-image"
          />
          <img
            src="/sandchest-logo-dark.svg"
            alt=""
            className="footer-brand-text"
            aria-hidden="true"
          />
        </div>
      </div>

      <div className="footer-inner">
        {/* Link columns */}
        <div className="footer-columns">
          <FooterColumn title="Product" links={productLinks} />
          <FooterColumn title="Developers" links={developerLinks} />
          <FooterColumn title="Resources" links={resourceLinks} />
          <FooterColumn title="Company" links={companyLinks} />
        </div>

        {/* Bottom — copyright left, legal + socials right */}
        <div className="footer-bottom">
          <span className="footer-copyright">
            &copy; {new Date().getFullYear()} Sandchest, Inc. All rights reserved.
          </span>
          <div className="footer-bottom-right">
            <Link href="/privacy" className="footer-bottom-link">
              Privacy Policy
            </Link>
            <Link href="/terms" className="footer-bottom-link">
              Terms of Service
            </Link>
            <div className="footer-bottom-socials">
              <a
                href="https://github.com/CapSoftware/Sandchest"
                target="_blank"
                rel="noopener"
                className="footer-social-icon"
                aria-label="GitHub"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                </svg>
              </a>
              <a
                href="https://x.com/sandchest"
                target="_blank"
                rel="noopener"
                className="footer-social-icon"
                aria-label="X (Twitter)"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
              </a>
              <a
                href="https://discord.gg/sandchest"
                target="_blank"
                rel="noopener"
                className="footer-social-icon"
                aria-label="Discord"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
                </svg>
              </a>
            </div>
          </div>
        </div>
      </div>
    </footer>
  )
}
