'use client'

import { useState, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { formatRelativeTime, formatDuration, formatCmd, formatBytes } from '@/lib/format'
import StatusBadge from '@/components/ui/StatusBadge'
import CopyButton from '@/components/ui/CopyButton'
import EmptyState from '@/components/ui/EmptyState'
import Timeline from './Timeline'
import ForkTree from './ForkTree'
import AnsiText from './AnsiText'
import { useReplayBundle, useReplayEvents } from '@/hooks/use-replay'
import type {
  ReplayExec,
  ReplayArtifact,
  ExecOutputEntry,
} from '@sandchest/contract'

// ---------------------------------------------------------------------------
// Exec card with expandable ANSI output
// ---------------------------------------------------------------------------

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

  const combinedOutput = useMemo(() => {
    if (!output) return ''
    return output.map((e) => e.data).join('')
  }, [output])

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
        <span className="replay-exec-chevron">{expanded ? '\u25be' : '\u25b8'}</span>
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
          ) : combinedOutput ? (
            <AnsiText text={combinedOutput} />
          ) : (
            <div className="replay-output-empty">No output</div>
          )}
          {exec.resource_usage && (
            <div className="replay-exec-resources">
              CPU: {exec.resource_usage.cpu_ms}ms | Memory:{' '}
              {formatBytes(exec.resource_usage.peak_memory_bytes)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Artifact row
// ---------------------------------------------------------------------------

function ArtifactRow({ artifact }: { artifact: ReplayArtifact }) {
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
      <td className="replay-text-weak">{formatBytes(artifact.bytes)}</td>
    </tr>
  )
}

// ---------------------------------------------------------------------------
// Tab types
// ---------------------------------------------------------------------------

type Tab = 'timeline' | 'execs' | 'sessions' | 'artifacts'

// ---------------------------------------------------------------------------
// Main viewer
// ---------------------------------------------------------------------------

interface ReplayViewerProps {
  sandboxId: string
}

export default function ReplayViewer({ sandboxId }: ReplayViewerProps) {
  const [activeTab, setActiveTab] = useState<Tab>('timeline')

  const { data: bundle, error, isLoading } = useReplayBundle(sandboxId)
  const isLive = bundle?.status === 'in_progress'
  const { data: events = [] } = useReplayEvents(
    bundle?.events_url,
    isLive,
  )

  const replayUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/s/${sandboxId}`
    : `/s/${sandboxId}`

  if (isLoading) {
    return (
      <div className="replay-container">
        <EmptyState message="Loading replay..." className="replay-loading" />
      </div>
    )
  }

  if (error) {
    const message = error instanceof Error ? error.message : 'Failed to load replay'
    const isPrivateOrNotFound = message.includes('not found') || message.includes('private') || message.includes('403') || message.includes('404')
    return (
      <div className="replay-container">
        <div className="replay-error-state">
          <div className="replay-error-icon">&#128274;</div>
          <h2 className="replay-error-title">
            {isPrivateOrNotFound ? 'This replay is private or does not exist.' : message}
          </h2>
          <p className="replay-error-desc">
            If you own this sandbox, sign in to view it or make it public.
          </p>
          <Link href="/login" className="replay-signin-link">
            Sign in
          </Link>
        </div>
      </div>
    )
  }

  if (!bundle) return null

  return (
    <div className="replay-container">
      <header className="replay-header">
        <div className="replay-header-left">
          <Link href="/" className="replay-logo">sandchest</Link>
          <span className="replay-header-sep">/</span>
          <span className="replay-sandbox-id">{bundle.sandbox_id}</span>
        </div>
        <div className="replay-header-right">
          {isLive && (
            <span className="replay-live-badge">
              <span className="replay-live-dot" />
              Live
            </span>
          )}
          <StatusBadge
            status={bundle.status}
            label={isLive ? 'in progress' : 'complete'}
            className="replay-status"
          />
          <CopyButton
            text={replayUrl}
            label="Copy URL"
            copiedLabel="Copied!"
            className="replay-copy-btn"
          />
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
          <span className="replay-meta-value" title={bundle.started_at}>
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
            <Link
              href={`/s/${bundle.forked_from}`}
              className="replay-fork-link"
            >
              {bundle.forked_from}
            </Link>
          </div>
        )}
      </div>

      <nav className="replay-tabs">
        {([
          ['timeline', `Timeline (${events.length})`],
          ['execs', `Execs (${bundle.execs.length})`],
          ['sessions', `Sessions (${bundle.sessions.length})`],
          ['artifacts', `Artifacts (${bundle.artifacts.length})`],
        ] as const).map(([tab, label]) => (
          <button
            key={tab}
            type="button"
            className={`replay-tab${activeTab === tab ? ' active' : ''}`}
            onClick={() => setActiveTab(tab as Tab)}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="replay-content">
        {activeTab === 'timeline' && (
          <Timeline
            events={events}
            startedAt={bundle.started_at}
            isLive={isLive}
          />
        )}

        {activeTab === 'execs' && (
          <div className="replay-exec-list">
            {bundle.execs.length === 0 ? (
              <EmptyState message="No executions recorded." className="replay-empty" />
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
              <EmptyState message="No sessions recorded." className="replay-empty" />
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
                        <StatusBadge
                          status={session.destroyed_at ? 'destroyed' : 'active'}
                        />
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
              <EmptyState message="No artifacts collected." className="replay-empty" />
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

      <ForkTree tree={bundle.fork_tree} currentId={bundle.sandbox_id} />
    </div>
  )
}
