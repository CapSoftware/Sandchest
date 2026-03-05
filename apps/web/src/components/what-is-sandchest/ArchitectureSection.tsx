const layers = [
  {
    label: 'Your agent',
    detail: 'SDK / CLI / MCP',
    accent: false,
  },
  {
    label: 'Control plane',
    detail: 'Auth, scheduling, event recording',
    accent: false,
  },
  {
    label: 'Node daemon',
    detail: 'Firecracker lifecycle, snapshots, CoW clones',
    accent: true,
  },
  {
    label: 'Guest agent',
    detail: 'Exec, file I/O, health checks via vsock',
    accent: true,
  },
]

const integrations = [
  { label: 'TypeScript SDK', description: 'Create, exec, fork, and manage sandboxes programmatically.' },
  { label: 'CLI', description: 'Interactive sandbox management from your terminal.' },
  { label: 'MCP server', description: 'First-class tool support for Claude Code and other AI agents.' },
]

export default function ArchitectureSection() {
  return (
    <section className="section">
      <div className="section-header">
        <h2 className="section-title">How it&apos;s built</h2>
        <p className="text-text" style={{ maxWidth: '72ch' }}>
          Sandchest runs on bare metal servers. No containers, no shared kernels, no abstraction layers between your agent and the hardware.
        </p>
      </div>

      <div className="what-arch-layout">
        {/* Stack diagram */}
        <div className="what-arch-stack">
          {layers.map((layer, i) => (
            <div
              key={layer.label}
              className="what-arch-layer"
              style={{
                borderColor: layer.accent ? 'var(--color-accent)' : 'var(--color-border)',
              }}
            >
              <span className="text-text-strong font-semibold" style={{ fontSize: 13 }}>
                {layer.label}
              </span>
              <span className="text-text-weak" style={{ fontSize: 12 }}>
                {layer.detail}
              </span>
              {i < layers.length - 1 && (
                <span
                  className="text-text-weak"
                  style={{
                    position: 'absolute',
                    bottom: -14,
                    left: '50%',
                    transform: 'translateX(-50%)',
                    fontSize: 11,
                    lineHeight: 1,
                  }}
                >
                  &darr;
                </span>
              )}
            </div>
          ))}
        </div>

        {/* Integration points */}
        <div className="what-arch-integrations">
          <p
            className="text-text-weak font-semibold uppercase"
            style={{ fontSize: 12, letterSpacing: 0.5, marginBottom: 16 }}
          >
            Integration surfaces
          </p>
          {integrations.map((item) => (
            <div key={item.label} className="what-arch-integration">
              <p className="text-text-strong font-medium" style={{ fontSize: 14, marginBottom: 4 }}>
                {item.label}
              </p>
              <p className="text-text-weak" style={{ fontSize: 13 }}>
                {item.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
