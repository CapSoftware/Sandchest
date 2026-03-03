'use client'

import { useState } from 'react'
import SimulateTerminal from './SimulateTerminal'

interface SessionPanelProps {
  onCreateSession: (shell?: string | undefined) => Promise<{ sessionId: string }>
  onDestroySession: (sessionId: string) => Promise<void>
  onSessionExec: (sessionId: string, command: string) => Promise<{
    exitCode: number
    stdout: string
    stderr: string
    durationMs: number
  }>
  isPending: boolean
}

export default function SessionPanel({
  onCreateSession,
  onDestroySession,
  onSessionExec,
  isPending,
}: SessionPanelProps) {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [destroying, setDestroying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleCreate() {
    setError(null)
    setCreating(true)
    try {
      const result = await onCreateSession()
      setSessionId(result.sessionId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create session')
    } finally {
      setCreating(false)
    }
  }

  async function handleDestroy() {
    if (!sessionId) return
    setDestroying(true)
    try {
      await onDestroySession(sessionId)
      setSessionId(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to destroy session')
    } finally {
      setDestroying(false)
    }
  }

  if (!sessionId) {
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
          <button
            className="btn btn-primary btn-sm"
            onClick={handleCreate}
            disabled={creating}
          >
            {creating ? <><span className="spinner" style={{ width: '0.75rem', height: '0.75rem' }} /> Creating...</> : 'Create Session'}
          </button>
          <span style={{ fontSize: '0.75rem', color: 'var(--color-text-weak)' }}>
            Sessions persist shell state between commands
          </span>
        </div>
        {error && (
          <div className="card feedback-card feedback-danger">{error}</div>
        )}
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
        <div style={{ fontSize: '0.75rem' }}>
          <span style={{ color: 'var(--color-text-weak)' }}>Session:</span>{' '}
          <span style={{ color: 'var(--color-text-strong)' }}>{sessionId}</span>
        </div>
        <button
          className="btn btn-danger btn-sm"
          onClick={handleDestroy}
          disabled={destroying}
        >
          {destroying ? 'Destroying...' : 'Destroy Session'}
        </button>
      </div>

      {error && (
        <div className="card feedback-card feedback-danger" style={{ marginBottom: '0.75rem' }}>{error}</div>
      )}

      <SimulateTerminal
        onExec={(cmd) => onSessionExec(sessionId, cmd)}
        isPending={isPending}
        placeholder="e.g. cd /tmp && pwd"
        emptyMessage="Session ready. Commands share state (cd, env vars, etc.)..."
      />
    </div>
  )
}
