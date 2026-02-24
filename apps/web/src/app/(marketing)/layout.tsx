import Nav from '@/components/landing/Nav'

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <main className="flex flex-col pb-20" style={{ gap: 'var(--vertical-padding)' }}>
      <div className="page-container">
        <Nav />
        <div>{children}</div>
      </div>
      <div className="text-center text-text-weak text-[13px]">
        <span>&copy; 2026 Sandchest.com</span>
      </div>
    </main>
  )
}
