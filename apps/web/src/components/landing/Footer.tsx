const links = [
  { label: 'GitHub', href: 'https://github.com/sandchest' },
  { label: 'Docs', href: '#' },
  { label: 'Discord', href: '#' },
  { label: 'X', href: '#' },
]

export default function Footer() {
  return (
    <footer
      style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', padding: 'var(--vertical-padding) var(--padding)', gap: '24px 32px' }}
    >
      {links.map((link) => (
        <div key={link.label}>
          <a
            href={link.href}
            className="footer-link text-text-weak block no-underline hover:no-underline"
            target={link.href.startsWith('http') ? '_blank' : undefined}
            rel={link.href.startsWith('http') ? 'noopener' : undefined}
          >
            {link.label}
          </a>
        </div>
      ))}
    </footer>
  )
}
