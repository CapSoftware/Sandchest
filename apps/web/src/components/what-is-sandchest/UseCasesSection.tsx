const useCases = [
  {
    title: 'AI coding agents',
    description:
      'Agents like Claude Code, Cursor, and Devin need safe environments to write, test, and iterate on code. Sandchest gives them VMs that fork instantly so they can explore multiple approaches in parallel.',
  },
  {
    title: 'Automated testing',
    description:
      'Run test suites in isolated VMs with full replay. When a test fails, share the replay URL and see exactly what happened \u2014 every command, every output, every file change.',
  },
  {
    title: 'Agent frameworks',
    description:
      'Building with LangChain, CrewAI, or the Vercel AI SDK? Connect Sandchest via the MCP server or TypeScript SDK. Your agents get sandbox tools without any infrastructure work.',
  },
  {
    title: 'Security research',
    description:
      'Analyze suspicious code in a Firecracker microVM with hardware-level isolation. Nothing escapes. Fork before risky operations and inspect the results safely.',
  },
]

export default function UseCasesSection() {
  return (
    <section className="section">
      <div className="section-header">
        <h2 className="section-title">Who uses Sandchest?</h2>
        <p className="text-text" style={{ maxWidth: '72ch' }}>
          Anyone who needs fast, isolated Linux environments with visibility into what happened inside.
        </p>
      </div>

      <div className="what-usecase-grid">
        {useCases.map((useCase) => (
          <div key={useCase.title} className="what-usecase-card">
            <p className="text-text-strong font-semibold" style={{ fontSize: 14, marginBottom: 8 }}>
              {useCase.title}
            </p>
            <p className="text-text-weak" style={{ fontSize: 13 }}>
              {useCase.description}
            </p>
          </div>
        ))}
      </div>
    </section>
  )
}
