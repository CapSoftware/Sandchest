const problems = [
  {
    label: 'No visibility',
    description:
      'Your agent runs 40 commands inside a container. Something breaks. You get an exit code and a truncated log. Good luck debugging that.',
  },
  {
    label: 'No exploration',
    description:
      'Agents need to try things, fail, and backtrack. Containers don\u2019t fork. So your agent either commits to a path or starts from scratch.',
  },
  {
    label: 'Weak isolation',
    description:
      'Docker containers share a kernel. One bad syscall and your host is exposed. For untrusted AI-generated code, that\u2019s not a sandbox \u2014 it\u2019s a suggestion.',
  },
]

export default function ProblemSection() {
  return (
    <section className="section">
      <div className="section-header">
        <h2 className="section-title">The problem</h2>
        <p className="text-text" style={{ maxWidth: '72ch' }}>
          AI agents need to execute code. But the infrastructure they run on wasn&apos;t built for how agents actually work.
        </p>
      </div>

      <div className="what-problem-grid">
        {problems.map((problem) => (
          <div key={problem.label} className="what-problem-card">
            <p className="text-text-strong font-semibold" style={{ fontSize: 14, marginBottom: 8 }}>
              {problem.label}
            </p>
            <p className="text-text-weak" style={{ fontSize: 13 }}>
              {problem.description}
            </p>
          </div>
        ))}
      </div>
    </section>
  )
}
