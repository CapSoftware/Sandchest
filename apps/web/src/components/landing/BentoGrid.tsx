import BentoCell from './BentoCell'

const features = [
  { title: 'Sub-second forking', description: 'Fork a running sandbox — memory, disk, everything — in under a second. Your agent explores in parallel.', animationId: 'fork-anim' },
  { title: 'VM-grade isolation', description: 'Every sandbox is a real Firecracker microVM. Full hardware-level isolation, not containers.', animationId: 'shield-anim' },
  { title: 'Stateful sessions', description: 'Shell sessions where cwd, env vars, and state persist between commands. No re-setup between exec calls.', animationId: 'session-anim' },
  { title: 'Session replay', description: 'Every sandbox is a permanent URL. Logs, file changes, and terminal output — fully replayable.', animationId: 'replay-anim' },
  { title: 'MCP server', description: '18 tools for Claude Code and AI agents. One-command project runs, diff/patch workflows, file ops, and git.', animationId: 'mcp-anim' },
  { title: 'Pre-built runtimes', description: 'Node, Bun, Python, and Go images ready to go. Your agent skips setup and starts building.', animationId: 'runtimes-anim' },
  { title: 'TypeScript SDK', description: 'Create, exec, fork, and manage sandboxes with a few lines of code.', animationId: 'sdk-anim' },
  { title: 'CLI', description: 'Create, exec, fork, and SSH into sandboxes from your terminal.', animationId: 'cli-anim' },
  { title: 'Artifacts', description: 'Mark build outputs and test reports for collection. Download them via URL when the sandbox stops.', animationId: 'artifacts-anim' },
]

export default function BentoGrid() {
  return (
    <section id="features" className="section">
      <div className="section-header">
        <h3 className="section-title">What is Sandchest?</h3>
        <p className="text-text">
          Every sandbox is a Firecracker microVM on bare metal. VM-grade isolation, sub-second forking, and a permanent session replay URL.
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
