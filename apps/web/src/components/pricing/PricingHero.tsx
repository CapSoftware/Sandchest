export default function PricingHero() {
  return (
    <section className="flex flex-col" style={{ padding: 'var(--vertical-padding) var(--padding)' }}>
      <h1
        className="hero-reveal hero-reveal-delay-1 text-text-strong font-bold"
        style={{ fontSize: 38, lineHeight: 1.1, marginBottom: 8 }}
      >
        Simple pricing. No surprises.
      </h1>

      <p
        className="hero-reveal hero-reveal-delay-2 text-text"
        style={{ marginBottom: 0, maxWidth: '82%' }}
      >
        Per-second billing. Recurring free credits every month. Up to 60% cheaper than alternatives.
      </p>
    </section>
  )
}
