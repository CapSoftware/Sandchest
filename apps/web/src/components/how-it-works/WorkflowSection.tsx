const workflows = [
  {
    title: 'SDK',
    description:
      'The TypeScript SDK gives your agent full programmatic control. Create, exec, fork, and destroy sandboxes with typed methods and streaming output.',
    code: 'import Sandchest from "@sandchest/sdk"',
  },
  {
    title: 'MCP server',
    description:
      'Connect the MCP server and your agent gets sandbox tools automatically. Works with Claude Code, Cursor, and any MCP-compatible client.',
    code: 'npx @sandchest/mcp',
  },
  {
    title: 'CLI',
    description:
      'Create, exec, fork, and SSH into sandboxes from your terminal. Great for debugging and interactive development.',
    code: 'sandchest create && sandchest exec "ls -la"',
  },
]

export default function WorkflowSection() {
  return (
    <section className="section">
      <div className="section-header">
        <h2 className="section-title">Three ways to connect</h2>
        <p className="text-text" style={{ maxWidth: '72ch' }}>
          Use the SDK for full control, the MCP server for AI-native integration, or the CLI for interactive work.
        </p>
      </div>

      <div className="how-workflow-grid">
        {workflows.map((workflow) => (
          <div key={workflow.title} className="how-workflow-card">
            <h3 className="text-text-strong font-semibold" style={{ fontSize: 14, marginBottom: 8 }}>
              {workflow.title}
            </h3>
            <p className="text-text-weak" style={{ fontSize: 13, marginBottom: 16 }}>
              {workflow.description}
            </p>
            <div className="how-step-code">
              <code className="text-accent" style={{ fontSize: 13 }}>
                {workflow.code}
              </code>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
