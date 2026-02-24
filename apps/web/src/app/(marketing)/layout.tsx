import Nav from '@/components/landing/Nav'
import Footer from '@/components/landing/Footer'

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <main className="flex flex-col" style={{ gap: 'var(--vertical-padding)' }}>
      <div className="page-container">
        <Nav />
        <div>{children}</div>
      </div>
      <Footer />
    </main>
  )
}
