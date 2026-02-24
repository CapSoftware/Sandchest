export default function CompareHero() {
  return (
    <section className="flex flex-col" style={{ padding: 'var(--vertical-padding) var(--padding)' }}>
      <h1
        className="hero-reveal hero-reveal-delay-1 text-text-strong font-bold"
        style={{ fontSize: 38, lineHeight: 1.1, marginBottom: 8 }}
      >
        You&apos;re paying too much for sandboxes.
      </h1>

      <p
        className="hero-reveal hero-reveal-delay-2 text-text"
        style={{ marginBottom: 0, maxWidth: '82%' }}
      >
        Sandchest gives you VM-grade isolation with included hours, flat pricing, and features others charge extra for &mdash; or don&apos;t offer at all.
      </p>
    </section>
  )
}
