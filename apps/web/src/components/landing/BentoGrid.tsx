import BentoCell from './BentoCell'

const features = [
  { title: 'Sub-100ms forking', description: 'Fork a running sandbox — memory, disk, everything — in under 100ms.', animationId: 'fork-anim' },
  { title: 'VM-grade isolation', description: 'Every sandbox is a real Firecracker microVM. Full hardware-level isolation.', animationId: 'shield-anim' },
  { title: 'TypeScript SDK', description: 'Create, exec, fork, and manage sandboxes with a few lines of code.', animationId: 'sdk-anim' },
  { title: 'Session replay', description: 'Every session is fully replayable. Logs, file changes, and terminal output.', animationId: 'replay-anim' },
  { title: 'MCP server', description: 'First-class MCP support for Claude Code and other AI tools.', animationId: 'mcp-anim' },
  { title: 'CLI', description: 'Create, exec, fork, and SSH into sandboxes from your terminal.', animationId: 'cli-anim' },
]

export default function BentoGrid() {
  return (
    <section id="features" className="section">
      <div className="section-header">
        <h3 className="section-title">What is Sandchest?</h3>
        <p className="text-text">
          A sandbox platform for AI agent code execution. Every sandbox is a Firecracker microVM with VM-grade isolation, sub-second fork capability, and a permanent session replay URL.
        </p>
      </div>

      <div className="bento-grid">
        {features.map((feature) => (
          <BentoCell
            key={feature.animationId}
            title={feature.title}
            description={feature.description}
            animationId={feature.animationId}
          />
        ))}
      </div>

    </section>
  )
}
