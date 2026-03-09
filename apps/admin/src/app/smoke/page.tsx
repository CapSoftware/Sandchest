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

interface SmokeErrorPayload {
  error: string
  details?: string[] | undefined
}

export default function SmokePage() {
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorDetails, setErrorDetails] = useState<string[]>([])
  const [result, setResult] = useState<SmokeResult | null>(null)

  async function handleRun() {
    setIsRunning(true)
    setError(null)
    setErrorDetails([])
    setResult(null)

    try {
      const response = await fetch('/api/smoke', { method: 'POST' })
      const body = (await response.json().catch(() => ({ error: 'Request failed' }))) as
        | SmokeResult
        | SmokeErrorPayload

      if (!response.ok || 'error' in body) {
        if ('error' in body) {
          setErrorDetails(body.details ?? [])
          throw new Error(body.error)
        }
        throw new Error(`Request failed (${response.status})`)
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
          <div className="card-title">Sandbox Lifecycle Test</div>
          <p className="text-weak" style={{ fontSize: '0.8125rem', lineHeight: 1.6 }}>
            Runs the full sandbox lifecycle against the API configured on the admin server.
            The flow creates live sandboxes, exercises exec/session/file/fork paths, and
            attempts cleanup in all cases.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={handleRun} disabled={isRunning}>
            {isRunning ? 'Running smoke test...' : 'Run smoke test'}
          </button>
          <span className="text-weak" style={{ fontSize: '0.75rem' }}>
            Uses `SANDCHEST_SMOKE_BASE_URL` or `API_URL`, plus `SANDCHEST_SMOKE_API_KEY` or
            `SANDCHEST_API_KEY`, and optional `SANDCHEST_SMOKE_TIMEOUT_MS`, on the admin server.
          </span>
        </div>
      </div>

      {error ? (
        <div className="card feedback-card feedback-danger">
          Smoke test failed: {error}
          {errorDetails.length > 0 ? (
            <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
              {errorDetails.map((detail) => (
                <div key={detail} style={{ fontSize: '0.75rem', lineHeight: 1.5 }}>
                  {detail}
                </div>
              ))}
            </div>
          ) : null}
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
