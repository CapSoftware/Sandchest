import InstallCommand from './InstallCommand'

export default function Hero() {
  return (
    <section className="flex flex-col" style={{ padding: 'var(--vertical-padding) var(--padding)' }}>
      <h1 className="hero-reveal hero-reveal-delay-1 text-text-strong font-bold" style={{ fontSize: 38, marginBottom: 8 }}>
        The sandbox platform for AI agents.
      </h1>

      <p className="hero-reveal hero-reveal-delay-2 text-text" style={{ marginBottom: 32, maxWidth: '82%' }}>
        Sandchest gives your agent isolated Linux VMs that fork in under 100ms. It tries ideas in parallel, backtracks bad paths instantly, and iterates faster than any human could.
      </p>

      <InstallCommand />

      <div className="hero-reveal hero-reveal-delay-3 how-it-works" style={{ marginTop: 40 }}>
        <p className="text-text-weak" style={{ fontSize: 13, marginBottom: 16, letterSpacing: 0.5, textTransform: 'uppercase', fontWeight: 600 }}>
          How it works
        </p>
        <ol className="steps">
          <li>
            <span className="step-num">1</span>
            <div>
              <span className="text-text-strong font-medium">Add Sandchest to your agent</span>
              <span className="text-text-weak"> — install the SDK or connect the MCP server. Your agent gets sandbox tools automatically.</span>
            </div>
          </li>
          <li>
            <span className="step-num">2</span>
            <div>
              <span className="text-text-strong font-medium">Your agent iterates faster</span>
              <span className="text-text-weak"> — it spins up VMs, runs code, and forks state in milliseconds. No waiting, no setup. Faster feedback loops mean more iterations per task.</span>
            </div>
          </li>
          <li>
            <span className="step-num">3</span>
            <div>
              <span className="text-text-strong font-medium">Your agent gets smarter</span>
              <span className="text-text-weak"> — it explores multiple approaches in parallel, discards bad paths instantly, and keeps the best result. More attempts, better outcomes.</span>
            </div>
          </li>
        </ol>
      </div>

    </section>
  )
}
