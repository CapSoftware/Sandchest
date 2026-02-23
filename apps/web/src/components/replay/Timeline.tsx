'use client'

import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import Link from 'next/link'
import type { ReplayEvent } from '@sandchest/contract'
import { formatDuration, formatBytes, formatCmd } from '@/lib/format'
import { formatElapsed } from './ansi-parser'
import AnsiText from './AnsiText'

interface TimelineProps {
  events: ReplayEvent[]
  startedAt: string
  isLive: boolean
}

/** Map event types to display icons */
function eventIcon(type: string): string {
  if (type.startsWith('exec.')) return '\u25b6'       // ▶
  if (type.startsWith('session.')) return '\u25cb'      // ○
  if (type.startsWith('file.')) return '\u25a1'         // □
  if (type.startsWith('artifact.')) return '\u25a0'     // ■
  if (type === 'sandbox.forked') return '\u2387'        // ⎇
  if (type === 'sandbox.failed') return '\u2717'        // ✗
  return '\u25c6'                                        // ◆
}

/** Color class for event icon */
function eventIconClass(type: string): string {
  if (type === 'sandbox.failed' || type === 'exec.failed') return 'tl-icon-error'
  if (type === 'sandbox.ready') return 'tl-icon-success'
  if (type === 'exec.completed') {
    return 'tl-icon-default' // colored by exit code in the row
  }
  if (type.startsWith('exec.')) return 'tl-icon-accent'
  if (type.startsWith('artifact.')) return 'tl-icon-accent'
  if (type === 'sandbox.ttl_warning') return 'tl-icon-warn'
  return 'tl-icon-default'
}

/** Render a single-line event summary */
function eventSummary(event: ReplayEvent): React.ReactNode {
  const d = event.data

  switch (event.type) {
    case 'sandbox.created': {
      const image = (d.image as string) ?? ''
      const profile = (d.profile as string) ?? ''
      return <span>Sandbox created <span className="tl-weak">({image}, {profile})</span></span>
    }
    case 'sandbox.ready': {
      const boot = d.boot_duration_ms as number | undefined
      return <span>Ready {boot !== undefined ? <span className="tl-weak">({formatDuration(boot)} boot)</span> : null}</span>
    }
    case 'sandbox.forked': {
      const forkId = d.fork_sandbox_id as string
      return (
        <span>
          Forked{' '}
          <Link href={`/s/${forkId}`} className="tl-link">
            {forkId}
          </Link>
        </span>
      )
    }
    case 'sandbox.stopping':
      return <span>Stopping... <span className="tl-weak">{(d.reason as string) ?? ''}</span></span>
    case 'sandbox.stopped': {
      const dur = d.total_duration_ms as number | undefined
      return <span>Stopped {dur !== undefined ? <span className="tl-weak">({formatDuration(dur)})</span> : null}</span>
    }
    case 'sandbox.failed':
      return <span className="tl-error">Failed: {(d.failure_reason as string) ?? 'unknown'}</span>
    case 'sandbox.ttl_warning': {
      const sec = d.seconds_remaining as number | undefined
      return <span className="tl-warn">TTL warning: {sec !== undefined ? `${sec}s remaining` : ''}</span>
    }
    case 'exec.started': {
      const cmd = (d.cmd as string | string[]) ?? ''
      return <code className="tl-cmd">{formatCmd(cmd)}</code>
    }
    case 'exec.output':
      return null // Grouped under exec.started
    case 'exec.completed': {
      const exitCode = d.exit_code as number | undefined
      const dur = d.duration_ms as number | undefined
      const color = exitCode === 0 ? 'hsl(140, 60%, 50%)' : exitCode !== undefined ? 'hsl(0, 70%, 60%)' : undefined
      return (
        <span>
          {exitCode !== undefined && (
            <span style={{ color }}>exit {exitCode}</span>
          )}{' '}
          {dur !== undefined && <span className="tl-weak">{formatDuration(dur)}</span>}
          <ExecResourceBadge data={d} />
        </span>
      )
    }
    case 'exec.failed':
      return <span className="tl-error">Exec failed: {(d.reason as string) ?? 'unknown'}</span>
    case 'session.created':
      return <span>Shell opened <span className="tl-weak">{(d.shell as string) ?? ''}</span></span>
    case 'session.destroyed':
      return <span>Shell closed</span>
    case 'file.written': {
      const path = (d.path as string) ?? ''
      const size = d.size_bytes as number | undefined
      return <span>{path} <span className="tl-weak">{size !== undefined ? `(${formatBytes(size)})` : ''}</span></span>
    }
    case 'file.deleted':
      return <span>{(d.path as string) ?? ''} <span className="tl-weak">deleted</span></span>
    case 'artifact.registered': {
      const paths = (d.paths as string[]) ?? []
      return <span>Artifact registered: {paths.join(', ')}</span>
    }
    case 'artifact.collected': {
      const name = (d.name as string) ?? ''
      const bytes = d.bytes as number | undefined
      return <span>{name} {bytes !== undefined ? <span className="tl-weak">({formatBytes(bytes)})</span> : null}</span>
    }
    default:
      return <span className="tl-weak">{event.type}</span>
  }
}

function ExecResourceBadge({ data }: { data: Record<string, unknown> }) {
  const usage = data.resource_usage as { cpu_ms?: number; peak_memory_bytes?: number } | undefined
  if (!usage) return null
  return (
    <span className="tl-resources">
      {usage.cpu_ms !== undefined && <span>CPU {usage.cpu_ms}ms</span>}
      {usage.peak_memory_bytes !== undefined && <span>{formatBytes(usage.peak_memory_bytes)}</span>}
    </span>
  )
}

/** Group exec.output events by exec_id and attach them to exec.started events */
interface GroupedEvent {
  event: ReplayEvent
  outputs: ReplayEvent[]
}

function groupEvents(events: ReplayEvent[]): GroupedEvent[] {
  const groups: GroupedEvent[] = []
  const outputBuffer = new Map<string, ReplayEvent[]>()

  for (const event of events) {
    if (event.type === 'exec.output') {
      const execId = event.data.exec_id as string
      const existing = outputBuffer.get(execId)
      if (existing) {
        existing.push(event)
      } else {
        outputBuffer.set(execId, [event])
      }
      continue
    }

    if (event.type === 'exec.started') {
      const execId = event.data.exec_id as string
      groups.push({ event, outputs: outputBuffer.get(execId) ?? [] })
      outputBuffer.delete(execId)
      continue
    }

    if (event.type === 'exec.completed' || event.type === 'exec.failed') {
      const execId = event.data.exec_id as string
      // Attach buffered outputs to the started event if it exists
      const startGroup = groups.find(
        (g) => g.event.type === 'exec.started' && g.event.data.exec_id === execId,
      )
      if (startGroup) {
        const pending = outputBuffer.get(execId)
        if (pending) {
          startGroup.outputs.push(...pending)
          outputBuffer.delete(execId)
        }
      }
      groups.push({ event, outputs: [] })
      continue
    }

    groups.push({ event, outputs: [] })
  }

  return groups
}

function ExecOutputBlock({ outputs }: { outputs: ReplayEvent[] }) {
  const text = useMemo(
    () => outputs.map((o) => (o.data.data as string) ?? '').join(''),
    [outputs],
  )

  if (!text) return null
  return <AnsiText text={text} className="replay-terminal tl-output-block" />
}

function TimelineRow({
  group,
  startedAt,
  defaultExpanded,
}: {
  group: GroupedEvent
  startedAt: string
  defaultExpanded: boolean
}) {
  const [expanded, setExpanded] = useState(() => defaultExpanded)
  const { event, outputs } = group
  const hasOutput = outputs.length > 0
  const isExecStart = event.type === 'exec.started'

  const summary = eventSummary(event)
  if (summary === null) return null

  return (
    <div className="tl-row">
      <div className="tl-time">
        {formatElapsed(startedAt, event.ts)}
      </div>
      <div className="tl-gutter">
        <span className={`tl-icon ${eventIconClass(event.type)}`}>
          {eventIcon(event.type)}
        </span>
        <div className="tl-line" />
      </div>
      <div className="tl-content">
        {isExecStart && hasOutput ? (
          <button
            type="button"
            className="tl-expandable"
            onClick={() => setExpanded(!expanded)}
          >
            <span className="tl-chevron">{expanded ? '\u25be' : '\u25b8'}</span>
            {summary}
          </button>
        ) : (
          <div className="tl-summary">{summary}</div>
        )}
        {expanded && hasOutput && <ExecOutputBlock outputs={outputs} />}
      </div>
    </div>
  )
}

export default function Timeline({ events, startedAt, isLive }: TimelineProps) {
  const [allExpanded, setAllExpanded] = useState(false)
  const [search, setSearch] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const prevCountRef = useRef(events.length)

  const grouped = useMemo(() => groupEvents(events), [events])

  const filteredGroups = useMemo(() => {
    if (!search) return grouped
    const lower = search.toLowerCase()
    return grouped.filter((g) => {
      const typeMatch = g.event.type.toLowerCase().includes(lower)
      const dataMatch = JSON.stringify(g.event.data).toLowerCase().includes(lower)
      const outputMatch = g.outputs.some((o) =>
        ((o.data.data as string) ?? '').toLowerCase().includes(lower),
      )
      return typeMatch || dataMatch || outputMatch
    })
  }, [grouped, search])

  const matchCount = search ? filteredGroups.length : 0

  // Auto-scroll to bottom for live mode when new events arrive
  useEffect(() => {
    if (isLive && events.length > prevCountRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
    prevCountRef.current = events.length
  }, [isLive, events.length])

  const toggleAll = useCallback(() => {
    setAllExpanded((v) => !v)
  }, [])

  return (
    <div className="tl-container" ref={containerRef}>
      <div className="tl-toolbar">
        <div className="tl-search-wrapper">
          <input
            type="text"
            className="tl-search"
            placeholder="Search events..."
            aria-label="Search events"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <span className="tl-match-count">
              {matchCount} match{matchCount !== 1 ? 'es' : ''}
            </span>
          )}
        </div>
        <button type="button" className="tl-toggle-btn" onClick={toggleAll}>
          {allExpanded ? 'Collapse all' : 'Expand all'}
        </button>
      </div>

      <div className="tl-events">
        {filteredGroups.map((group) => (
          <TimelineRow
            key={`${group.event.type}-${group.event.seq}`}
            group={group}
            startedAt={startedAt}
            defaultExpanded={allExpanded}
          />
        ))}
        {filteredGroups.length === 0 && (
          <div className="tl-empty">
            {search ? 'No matching events.' : 'No events recorded.'}
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
