export default function CodeExample() {
  return (
    <section id="code" className="section">
      <div className="section-header">
        <h3 className="section-title">See it in action</h3>
        <p className="text-[13px] text-text-weak" style={{ lineHeight: 1.5 }}>
          A few lines of TypeScript. That&apos;s it.
        </p>
      </div>

      <div style={{ borderRadius: 6, overflow: 'hidden' }}>
        <div className="bg-surface" style={{ padding: '12px 20px' }}>
          <span className="text-[13px] text-text-weak">agent.ts</span>
        </div>

        <pre className="bg-surface overflow-x-auto code-block" style={{ padding: 20, lineHeight: 1.75 }}>
          <code>
            <span className="text-text-weak">import</span>{' '}
            <span className="text-text-strong">Sandchest</span>{' '}
            <span className="text-text-weak">from</span>{' '}
            <span className="text-accent">&quot;@sandchest/sdk&quot;</span>
            <span className="text-text-weak">;</span>
            {'\n\n'}
            <span className="text-text-weak">const</span>{' '}
            <span className="text-text-strong">sandchest</span>{' '}
            <span className="text-text-weak">=</span>{' '}
            <span className="text-text-weak">new</span>{' '}
            <span className="text-text-strong">Sandchest</span>
            <span className="text-text-weak">();</span>
            {'\n\n'}
            <span className="text-border">{'// Create a sandbox and set up the environment'}</span>
            {'\n'}
            <span className="text-text-weak">const</span>{' '}
            <span className="text-text-strong">sb</span>{' '}
            <span className="text-text-weak">=</span>{' '}
            <span className="text-text-weak">await</span>{' '}
            <span className="text-text-strong">sandchest</span>
            <span className="text-text-weak">.</span>
            <span className="text-text">create</span>
            <span className="text-text-weak">();</span>
            {'\n'}
            <span className="text-text-weak">await</span>{' '}
            <span className="text-text-strong">sb</span>
            <span className="text-text-weak">.</span>
            <span className="text-text">exec</span>
            <span className="text-text-weak">(</span>
            <span className="text-accent">&quot;git clone repo &amp;&amp; npm install&quot;</span>
            <span className="text-text-weak">);</span>
            {'\n\n'}
            <span className="text-border">{'// Try something risky in a fork'}</span>
            {'\n'}
            <span className="text-text-weak">const</span>{' '}
            <span className="text-text-strong">fork</span>{' '}
            <span className="text-text-weak">=</span>{' '}
            <span className="text-text-weak">await</span>{' '}
            <span className="text-text-strong">sb</span>
            <span className="text-text-weak">.</span>
            <span className="text-text">fork</span>
            <span className="text-text-weak">();</span>
            {'\n'}
            <span className="text-text-weak">const</span>{' '}
            <span className="text-text-strong">result</span>{' '}
            <span className="text-text-weak">=</span>{' '}
            <span className="text-text-weak">await</span>{' '}
            <span className="text-text-strong">fork</span>
            <span className="text-text-weak">.</span>
            <span className="text-text">exec</span>
            <span className="text-text-weak">(</span>
            <span className="text-accent">&quot;npm test&quot;</span>
            <span className="text-text-weak">);</span>
            {'\n\n'}
            <span className="text-text-weak">if</span>{' '}
            <span className="text-text-weak">(</span>
            <span className="text-text-strong">result</span>
            <span className="text-text-weak">.</span>
            <span className="text-text">exitCode</span>{' '}
            <span className="text-text-weak">!==</span>{' '}
            <span className="text-accent">0</span>
            <span className="text-text-weak">{')'} {'{'}</span>
            {'\n'}
            {'  '}<span className="text-text-weak">await</span>{' '}
            <span className="text-text-strong">fork</span>
            <span className="text-text-weak">.</span>
            <span className="text-text">destroy</span>
            <span className="text-text-weak">();</span>{' '}
            <span className="text-border">{'// original untouched'}</span>
            {'\n'}
            <span className="text-text-weak">{'}'}</span>
          </code>
        </pre>
      </div>
    </section>
  )
}
