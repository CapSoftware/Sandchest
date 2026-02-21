import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../../lib/api'
import { formatRelativeTime, formatDuration, formatCmd } from '../../lib/format'
import type {
  ReplayBundle,
  ReplayExec,
  ReplayArtifact,
  ExecOutputEntry,
} from '@sandchest/contract'

const STATUS_COLORS: Record<string, string> = {
  queued: 'var(--color-text-weak)',
  provisioning: 'hsl(40, 80%, 60%)',
  running: 'hsl(140, 60%, 50%)',
  stopping: 'hsl(40, 80%, 60%)',
  stopped: 'var(--color-text-weak)',
  failed: 'hsl(0, 70%, 60%)',
  deleted: 'var(--color-text-weak)',
  in_progress: 'hsl(140, 60%, 50%)',
  complete: 'var(--color-text-weak)',
}

function ExecCard({ exec }: { exec: ReplayExec }) {
  const [expanded, setExpanded] = useState(false)
  const [output, setOutput] = useState<ExecOutputEntry[] | null>(null)
  const [loadingOutput, setLoadingOutput] = useState(false)

  const handleExpand = useCallback(async () => {
    const next = !expanded
    setExpanded(next)
    if (next && !output && exec.output_ref) {
      setLoadingOutput(true)
      try {
        const res = await fetch(exec.output_ref)
        if (res.ok) {
          const text = await res.text()
          const entries = text
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as ExecOutputEntry)
          setOutput(entries)
        }
      } catch {
        // Output not available
      } finally {
        setLoadingOutput(false)
      }
    }
  }, [expanded, output, exec.output_ref])

  const exitCodeColor =
    exec.exit_code === null
      ? 'var(--color-text-weak)'
      : exec.exit_code === 0
        ? 'hsl(140, 60%, 50%)'
        : 'hsl(0, 70%, 60%)'

  return (
    <div className="replay-exec-card">
      <button
        type="button"
        className="replay-exec-header"
        onClick={handleExpand}
      >
        <span className="replay-exec-chevron">{expanded ? '▾' : '▸'}</span>
        <code className="replay-exec-cmd">{formatCmd(exec.cmd)}</code>
        <span className="replay-exec-meta">
          {exec.exit_code !== null && (
            <span style={{ color: exitCodeColor }}>
              exit {exec.exit_code}
            </span>
          )}
          {exec.duration_ms !== null && (
            <span className="replay-exec-duration">
              {formatDuration(exec.duration_ms)}
            </span>
          )}
        </span>
      </button>
      {expanded && (
        <div className="replay-exec-output">
          {loadingOutput ? (
            <div className="replay-output-loading">Loading output...</div>
          ) : output && output.length > 0 ? (
            <pre className="replay-terminal">
              {output.map((entry, i) => (
                <span
                  key={i}
                  className={
                    entry.stream === 'stderr'
                      ? 'replay-stderr'
                      : 'replay-stdout'
                  }
                >
                  {entry.data}
                </span>
              ))}
            </pre>
          ) : (
            <div className="replay-output-empty">No output</div>
          )}
          {exec.resource_usage && (
            <div className="replay-exec-resources">
              CPU: {exec.resource_usage.cpu_ms}ms | Memory:{' '}
              {(exec.resource_usage.peak_memory_bytes / 1024 / 1024).toFixed(1)}
              MB
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ArtifactRow({ artifact }: { artifact: ReplayArtifact }) {
  const sizeStr =
    artifact.bytes < 1024
      ? `${artifact.bytes}B`
      : artifact.bytes < 1048576
        ? `${(artifact.bytes / 1024).toFixed(1)}KB`
        : `${(artifact.bytes / 1048576).toFixed(1)}MB`

  return (
    <tr>
      <td>
        <a
          href={artifact.download_url}
          className="replay-artifact-link"
          download
        >
          {artifact.name}
        </a>
      </td>
      <td className="replay-text-weak">{artifact.mime}</td>
      <td className="replay-text-weak">{sizeStr}</td>
    </tr>
  )
}

interface ReplayViewerProps {
  sandboxId: string
}

export default function ReplayViewer({ sandboxId }: ReplayViewerProps) {
  const [bundle, setBundle] = useState<ReplayBundle | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'execs' | 'sessions' | 'artifacts'>('execs')

  // Data fetching is external system sync — useEffect is correct here
  useEffect(() => {
    let cancelled = false
    apiFetch<ReplayBundle>(`/v1/public/replay/${sandboxId}`)
      .then((data) => {
        if (!cancelled) {
          setBundle(data)
          setLoading(false)
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const message = err instanceof Error ? err.message : 'Failed to load replay'
        if (message.includes('not found') || message.includes('private')) {
          setError('This replay is private or does not exist.')
        } else {
          setError(message)
        }
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [sandboxId])

  if (loading) {
    return (
      <div className="replay-container">
        <div className="replay-loading">Loading replay...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="replay-container">
        <div className="replay-error-state">
          <div className="replay-error-icon">&#128274;</div>
          <h2 className="replay-error-title">{error}</h2>
          <p className="replay-error-desc">
            If you own this sandbox, sign in to view it or make it public.
          </p>
          <a href="/login" className="replay-signin-link">
            Sign in
          </a>
        </div>
      </div>
    )
  }

  if (!bundle) return null

  return (
    <div className="replay-container">
      <header className="replay-header">
        <div className="replay-header-left">
          <a href="/" className="replay-logo">sandchest</a>
          <span className="replay-header-sep">/</span>
          <span className="replay-sandbox-id">{bundle.sandbox_id}</span>
        </div>
        <div className="replay-header-right">
          <span
            className="replay-status"
            style={{ color: STATUS_COLORS[bundle.status] ?? 'var(--color-text)' }}
          >
            {bundle.status === 'in_progress' ? 'live' : 'complete'}
          </span>
        </div>
      </header>

      <div className="replay-meta">
        <div className="replay-meta-row">
          <span className="replay-meta-label">Image</span>
          <span className="replay-meta-value">{bundle.image}</span>
        </div>
        <div className="replay-meta-row">
          <span className="replay-meta-label">Profile</span>
          <span className="replay-meta-value">{bundle.profile}</span>
        </div>
        <div className="replay-meta-row">
          <span className="replay-meta-label">Started</span>
          <span className="replay-meta-value">
            {formatRelativeTime(bundle.started_at)}
          </span>
        </div>
        {bundle.total_duration_ms !== null && (
          <div className="replay-meta-row">
            <span className="replay-meta-label">Duration</span>
            <span className="replay-meta-value">
              {formatDuration(bundle.total_duration_ms)}
            </span>
          </div>
        )}
        {bundle.forked_from && (
          <div className="replay-meta-row">
            <span className="replay-meta-label">Forked from</span>
            <a
              href={`/s/${bundle.forked_from}`}
              className="replay-fork-link"
            >
              {bundle.forked_from}
            </a>
          </div>
        )}
      </div>

      <nav className="replay-tabs">
        <button
          type="button"
          className={`replay-tab${activeTab === 'execs' ? ' active' : ''}`}
          onClick={() => setActiveTab('execs')}
        >
          Executions ({bundle.execs.length})
        </button>
        <button
          type="button"
          className={`replay-tab${activeTab === 'sessions' ? ' active' : ''}`}
          onClick={() => setActiveTab('sessions')}
        >
          Sessions ({bundle.sessions.length})
        </button>
        <button
          type="button"
          className={`replay-tab${activeTab === 'artifacts' ? ' active' : ''}`}
          onClick={() => setActiveTab('artifacts')}
        >
          Artifacts ({bundle.artifacts.length})
        </button>
      </nav>

      <div className="replay-content">
        {activeTab === 'execs' && (
          <div className="replay-exec-list">
            {bundle.execs.length === 0 ? (
              <div className="replay-empty">No executions recorded.</div>
            ) : (
              bundle.execs.map((exec) => (
                <ExecCard key={exec.exec_id} exec={exec} />
              ))
            )}
          </div>
        )}

        {activeTab === 'sessions' && (
          <div className="replay-session-list">
            {bundle.sessions.length === 0 ? (
              <div className="replay-empty">No sessions recorded.</div>
            ) : (
              <table className="replay-table">
                <thead>
                  <tr>
                    <th>Session ID</th>
                    <th>Shell</th>
                    <th>Created</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {bundle.sessions.map((session) => (
                    <tr key={session.session_id}>
                      <td>
                        <code className="replay-text-accent">
                          {session.session_id}
                        </code>
                      </td>
                      <td className="replay-text-weak">{session.shell}</td>
                      <td className="replay-text-weak">
                        {formatRelativeTime(session.created_at)}
                      </td>
                      <td>
                        <span
                          style={{
                            color: session.destroyed_at
                              ? 'var(--color-text-weak)'
                              : 'hsl(140, 60%, 50%)',
                          }}
                        >
                          {session.destroyed_at ? 'destroyed' : 'active'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {activeTab === 'artifacts' && (
          <div className="replay-artifact-list">
            {bundle.artifacts.length === 0 ? (
              <div className="replay-empty">No artifacts collected.</div>
            ) : (
              <table className="replay-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Size</th>
                  </tr>
                </thead>
                <tbody>
                  {bundle.artifacts.map((artifact) => (
                    <ArtifactRow
                      key={artifact.artifact_id}
                      artifact={artifact}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {bundle.fork_tree.children.length > 0 && (
        <div className="replay-fork-tree-section">
          <h3 className="replay-section-title">Fork Tree</h3>
          <ForkTreeNode node={bundle.fork_tree} currentId={bundle.sandbox_id} />
        </div>
      )}
    </div>
  )
}

function ForkTreeNode({
  node,
  currentId,
  depth = 0,
}: {
  node: ReplayBundle['fork_tree']
  currentId: string
  depth?: number
}) {
  const isCurrent = node.sandbox_id === currentId
  return (
    <div className="replay-fork-node" style={{ marginLeft: depth * 20 }}>
      <span className="replay-fork-branch">{depth > 0 ? '├─ ' : ''}</span>
      {isCurrent ? (
        <span className="replay-fork-current">{node.sandbox_id}</span>
      ) : (
        <a href={`/s/${node.sandbox_id}`} className="replay-fork-link">
          {node.sandbox_id}
        </a>
      )}
      {node.forked_at && (
        <span className="replay-text-weak replay-fork-time">
          {' '}
          forked {formatRelativeTime(node.forked_at)}
        </span>
      )}
      {node.children.map((child) => (
        <ForkTreeNode
          key={child.sandbox_id}
          node={child}
          currentId={currentId}
          depth={depth + 1}
        />
      ))}
    </div>
  )
}
