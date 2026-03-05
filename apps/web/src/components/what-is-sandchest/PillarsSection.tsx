const pillars = [
  {
    number: '01',
    title: 'Sub-second forking',
    subtitle: 'Agents explore freely',
    description:
      'Fork a running sandbox \u2014 memory, disk, network state, everything \u2014 in under 100ms. The original stays untouched. Your agent tries risky operations in a fork, keeps what works, discards what doesn\u2019t. Real undo at the infrastructure level.',
    example: [
      { text: 'const ', cls: 'text-text-weak' },
      { text: 'sb', cls: 'text-text-strong' },
      { text: ' = ', cls: 'text-text-weak' },
      { text: 'await ', cls: 'text-text-weak' },
      { text: 'sandchest', cls: 'text-text-strong' },
      { text: '.create()', cls: 'text-text' },
    ],
    exampleLine2: [
      { text: 'const ', cls: 'text-text-weak' },
      { text: 'fork', cls: 'text-text-strong' },
      { text: ' = ', cls: 'text-text-weak' },
      { text: 'await ', cls: 'text-text-weak' },
      { text: 'sb', cls: 'text-text-strong' },
      { text: '.fork()', cls: 'text-text' },
      { text: '  // <100ms', cls: 'text-border' },
    ],
  },
  {
    number: '02',
    title: 'Session replay',
    subtitle: 'Every sandbox is a URL',
    description:
      'Every sandbox produces a permanent, shareable URL. The full timeline: every command, every output, every file change, with timestamps. Share it in a PR comment, paste it in Slack, attach it to a bug report. Debugging AI agents becomes a spectator sport.',
    example: [
      { text: '// permanent replay URL', cls: 'text-border' },
    ],
    exampleLine2: [
      { text: 'sandchest.com', cls: 'text-text-weak' },
      { text: '/s/', cls: 'text-text-weak' },
      { text: 'sb_7Kj2mNpQ4x', cls: 'text-accent' },
    ],
  },
  {
    number: '03',
    title: 'VM-grade isolation',
    subtitle: 'Firecracker microVMs on bare metal',
    description:
      'Every sandbox is a real virtual machine, not a container. Firecracker microVMs provide hardware-level isolation with a minimal attack surface. Your agent runs untrusted code with the confidence that nothing escapes the sandbox. No shared kernels, no container breakouts.',
    example: [
      { text: '// each sandbox = 1 Firecracker VM', cls: 'text-border' },
    ],
    exampleLine2: [
      { text: 'isolation', cls: 'text-text-strong' },
      { text: ': ', cls: 'text-text-weak' },
      { text: '"hardware"', cls: 'text-accent' },
    ],
  },
]

export default function PillarsSection() {
  return (
    <section className="section">
      <div className="section-header">
        <h2 className="section-title">Three things that matter</h2>
        <p className="text-text" style={{ maxWidth: '72ch' }}>
          Sandchest is built around three capabilities that change how agents execute code.
        </p>
      </div>

      <div className="what-pillar-grid">
        {pillars.map((pillar) => (
          <div key={pillar.number} className="what-pillar">
            <div className="what-pillar-header">
              <span className="text-text-weak" style={{ fontSize: 12 }}>
                {pillar.number}
              </span>
              <h3 className="text-text-strong font-bold" style={{ fontSize: 16 }}>
                {pillar.title}
              </h3>
              <p className="text-accent" style={{ fontSize: 13, marginBottom: 0 }}>
                {pillar.subtitle}
              </p>
            </div>

            <p className="text-text" style={{ fontSize: 14 }}>
              {pillar.description}
            </p>

            <div className="what-pillar-code">
              <code style={{ fontSize: 13 }}>
                {pillar.example.map((span, i) => (
                  <span key={i} className={span.cls}>{span.text}</span>
                ))}
              </code>
              <code style={{ fontSize: 13 }}>
                {pillar.exampleLine2.map((span, i) => (
                  <span key={i} className={span.cls}>{span.text}</span>
                ))}
              </code>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
