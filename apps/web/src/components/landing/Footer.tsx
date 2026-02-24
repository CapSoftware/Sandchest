import Image from 'next/image'
import Link from 'next/link'

const productLinks = [
  { label: 'Features', href: '/#features' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Compare', href: '/compare' },
  { label: 'Dashboard', href: '/dashboard' },
]

const developerLinks = [
  { label: 'Documentation', href: 'https://docs.sandchest.com' },
  { label: 'SDK Reference', href: 'https://docs.sandchest.com/sdk' },
  { label: 'MCP Server', href: 'https://docs.sandchest.com/mcp' },
  { label: 'CLI', href: 'https://docs.sandchest.com/cli' },
]

const companyLinks = [
  { label: 'GitHub', href: 'https://github.com/CapSoftware/Sandchest' },
  { label: 'Twitter / X', href: 'https://x.com/sandchest' },
  { label: 'Discord', href: 'https://discord.gg/sandchest' },
]

const legalLinks = [
  { label: 'Privacy Policy', href: '/privacy' },
  { label: 'Terms of Service', href: '/terms' },
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
      <div className="footer-inner">
        {/* Top — tagline */}
        <div className="footer-top">
          <Link href="/" className="no-underline hover:no-underline">
            <Image
              src="/sandchest-logo-dark.svg"
              alt="Sandchest"
              width={148}
              height={48}
              style={{ height: 48, marginLeft: -7 }}
            />
          </Link>
          <p className="footer-tagline">
            Linux sandboxes for AI agents.<br />
            Fork fast. Iterate faster.
          </p>
        </div>

        {/* Middle — link columns */}
        <div className="footer-columns">
          <FooterColumn title="Product" links={productLinks} />
          <FooterColumn title="Developers" links={developerLinks} />
          <FooterColumn title="Community" links={companyLinks} />
          <FooterColumn title="Legal" links={legalLinks} />
        </div>

        {/* Bottom — copyright + GitHub */}
        <div className="footer-bottom">
          <span className="text-text-weak">
            &copy; {new Date().getFullYear()} Sandchest.com
          </span>
          <a
            href="https://github.com/CapSoftware/Sandchest"
            target="_blank"
            rel="noopener"
            className="footer-github no-underline hover:no-underline"
          >
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
            <span>CapSoftware/Sandchest</span>
          </a>
        </div>
      </div>
    </footer>
  )
}
