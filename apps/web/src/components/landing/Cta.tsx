import CtaAnimation from './CtaAnimation'

export default function Cta() {
  return (
    <section id="cta" className="section">
      <div className="cta-layout">
        <div className="cta-content">
          <h3 className="section-title">Follow along</h3>
          <p className="text-text" style={{ marginBottom: 24 }}>
            Sandchest is being built in the open. Star the repo to follow development and get notified when we ship.
          </p>
          <div className="cta-buttons">
            <a href="https://github.com/sandchest" className="star-btn no-underline hover:no-underline" target="_blank" rel="noopener">
              <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
              Star on GitHub
            </a>
            <a href="https://github.com/sandchest" className="follow-btn no-underline hover:no-underline" target="_blank" rel="noopener">
              View Repository
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 17L17 7M17 7H7M17 7v10" />
              </svg>
            </a>
          </div>
        </div>
        <CtaAnimation />
      </div>

    </section>
  )
}
