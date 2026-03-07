'use client'

import { useState } from 'react'

interface SmokeCheck {
  name: string
  durationMs: number
}

interface SmokeResult {
  runId: string
  baseUrl: string
  rootSandboxId: string
  forkSandboxId: string
  checks: SmokeCheck[]
}

export default function SmokePage() {
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<SmokeResult | null>(null)

  async function handleRun() {
    setIsRunning(true)
    setError(null)
    setResult(null)

    try {
      const response = await fetch('/api/smoke', { method: 'POST' })
      const body = (await response.json().catch(() => ({ error: 'Request failed' }))) as
        | SmokeResult
        | { error: string }

      if (!response.ok || 'error' in body) {
        throw new Error('error' in body ? body.error : `Request failed (${response.status})`)
      }

      setResult(body)
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : 'Unknown error')
    } finally {
      setIsRunning(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div className="page-header">
        <h1 className="page-title">Sandbox Smoke</h1>
      </div>

      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
          <div className="card-title">Production Lifecycle Test</div>
          <p className="text-weak" style={{ fontSize: '0.8125rem', lineHeight: 1.6 }}>
            Runs the full sandbox lifecycle from the admin server using configured environment
            credentials. The flow creates live sandboxes, exercises exec/session/file/fork paths,
            and attempts cleanup in all cases.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={handleRun} disabled={isRunning}>
            {isRunning ? 'Running smoke test...' : 'Run smoke test'}
          </button>
          <span className="text-weak" style={{ fontSize: '0.75rem' }}>
            Uses `SANDCHEST_SMOKE_API_KEY` or `SANDCHEST_API_KEY` on the admin server.
          </span>
        </div>
      </div>

      {error ? (
        <div className="card feedback-card feedback-danger">
          Smoke test failed: {error}
        </div>
      ) : null}

      {result ? (
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div className="card-header" style={{ marginBottom: 0 }}>
            <div>
              <div className="card-title">Last Run</div>
              <div className="card-subtitle">{result.runId}</div>
            </div>
            <span className="badge badge-online">
              <span className="badge-dot" />
              passed
            </span>
          </div>

          <div className="card-metrics">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', fontSize: '0.8125rem' }}>
              <span className="text-weak">Base URL</span>
              <span>{result.baseUrl}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', fontSize: '0.8125rem' }}>
              <span className="text-weak">Root sandbox</span>
              <span>{result.rootSandboxId}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', fontSize: '0.8125rem' }}>
              <span className="text-weak">Fork sandbox</span>
              <span>{result.forkSandboxId}</span>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div className="card-section-title">Checks</div>
            {result.checks.map((check) => (
              <div
                key={check.name}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: '1rem',
                  fontSize: '0.8125rem',
                  paddingTop: '0.5rem',
                  borderTop: '1px solid var(--color-border-weak)',
                }}
              >
                <span>{check.name}</span>
                <span className="text-weak">{check.durationMs}ms</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
