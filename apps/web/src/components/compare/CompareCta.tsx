import Link from 'next/link'

export default function CompareCta() {
  return (
    <section className="section">
      <div className="cta-content" style={{ textAlign: 'center', maxWidth: 480, margin: '0 auto' }}>
        <h3 className="section-title" style={{ marginBottom: 8 }}>
          Start building for free
        </h3>
        <p className="text-text" style={{ marginBottom: 24, fontSize: 13, lineHeight: '170%' }}>
          $100/mo in recurring credits, no credit card required. Upgrade to Max when you grow.
        </p>
        <div className="cta-buttons" style={{ justifyContent: 'center' }}>
          <Link href="/auth/sign-in" className="star-btn no-underline hover:no-underline">
            Get started
          </Link>
          <Link href="/pricing" className="follow-btn no-underline hover:no-underline">
            View plans
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 17L17 7M17 7H7M17 7v10" />
            </svg>
          </Link>
        </div>
      </div>
    </section>
  )
}
