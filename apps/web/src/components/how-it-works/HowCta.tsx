import Link from 'next/link'

export default function HowCta() {
  return (
    <section className="section">
      <div className="what-cta-box">
        <h3 className="text-text-strong font-bold" style={{ fontSize: 18, marginBottom: 8 }}>
          Try it now
        </h3>
        <p className="text-text" style={{ maxWidth: '56ch', marginBottom: 24 }}>
          Install the SDK and create your first sandbox. The whole thing takes about five minutes.
        </p>

        <div className="what-cta-code">
          <code className="text-text" style={{ fontSize: 13 }}>
            <span className="text-text-weak">$</span>{' '}
            <span className="text-text-strong">bun add @sandchest/sdk</span>
          </code>
        </div>

        <div className="flex flex-wrap gap-3" style={{ marginTop: 20 }}>
          <a
            href="https://docs.sandchest.com"
            className="star-btn no-underline hover:no-underline"
            target="_blank"
            rel="noopener"
          >
            Read the docs
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 17L17 7M17 7H7M17 7v10" />
            </svg>
          </a>
          <Link
            href="/pricing"
            className="follow-btn no-underline hover:no-underline"
          >
            View pricing
          </Link>
        </div>
      </div>
    </section>
  )
}
