const steps = [
  {
    number: '1',
    title: 'Install the SDK',
    description:
      'Add @sandchest/sdk to your project. Or connect the MCP server if your agent supports it. Your agent gets sandbox tools automatically.',
    code: '$ bun add @sandchest/sdk',
  },
  {
    number: '2',
    title: 'Create a sandbox',
    description:
      'One API call spins up a Firecracker microVM on bare metal. It boots in seconds and your agent has a full Linux environment with root access.',
    code: 'const sb = await sandchest.create()',
  },
  {
    number: '3',
    title: 'Run code, fork, explore',
    description:
      'Your agent executes commands, forks state in under 100ms to try risky operations, and backtracks instantly if something breaks. The original sandbox stays untouched.',
    code: 'const fork = await sb.fork()  // <100ms',
  },
  {
    number: '4',
    title: 'Replay everything',
    description:
      'Every sandbox produces a permanent URL. The full timeline: every command, every output, every file change. Share it in a PR, paste it in Slack, attach it to a bug report.',
    code: 'sandchest.com/s/sb_7Kj2mNpQ4x',
  },
]

export default function StepsSection() {
  return (
    <section className="section">
      <div className="section-header">
        <h2 className="section-title">Four steps</h2>
        <p className="text-text" style={{ maxWidth: '72ch' }}>
          From zero to a running sandbox in under a minute.
        </p>
      </div>

      <div className="how-steps-grid">
        {steps.map((step) => (
          <div key={step.number} className="how-step-card">
            <div className="how-step-header">
              <span className="step-num">{step.number}</span>
              <h3 className="text-text-strong font-semibold" style={{ fontSize: 14 }}>
                {step.title}
              </h3>
            </div>
            <p className="text-text-weak" style={{ fontSize: 13 }}>
              {step.description}
            </p>
            <div className="how-step-code">
              <code className="text-accent" style={{ fontSize: 13 }}>
                {step.code}
              </code>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
