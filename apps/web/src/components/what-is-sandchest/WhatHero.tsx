export default function WhatHero() {
  return (
    <section className="flex flex-col" style={{ padding: 'var(--vertical-padding) var(--padding)' }}>
      <p
        className="hero-reveal hero-reveal-delay-1 text-text-weak font-semibold uppercase"
        style={{ fontSize: 13, letterSpacing: 0.5, marginBottom: 16 }}
      >
        What is Sandchest?
      </p>

      <h1
        className="hero-reveal hero-reveal-delay-1 text-text-strong font-bold"
        style={{ fontSize: 38, lineHeight: 1.1, marginBottom: 8 }}
      >
        The sandbox platform built for AI agents.
      </h1>

      <p
        className="hero-reveal hero-reveal-delay-2 text-text"
        style={{ marginBottom: 0, maxWidth: '82%' }}
      >
        Sandchest gives AI agents their own Linux environments that boot in seconds,
        fork in milliseconds, and record everything. Every sandbox is a Firecracker
        microVM on bare metal &mdash; real isolation, real speed, real visibility.
      </p>
    </section>
  )
}
