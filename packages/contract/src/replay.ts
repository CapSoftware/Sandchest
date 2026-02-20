import type { ResourceUsage } from './common.js'
import type { ProfileName } from './sandbox.js'

// ---------------------------------------------------------------------------
// Replay bundle (GET /v1/sandboxes/{id}/replay)
// ---------------------------------------------------------------------------

export type ReplayStatus = 'in_progress' | 'complete'

export interface ReplayForkTreeNode {
  sandbox_id: string
  forked_at?: string | undefined
  children: ReplayForkTreeNode[]
}

export interface ReplaySession {
  session_id: string
  shell: string
  created_at: string
  destroyed_at: string | null
}

export interface ReplayExec {
  exec_id: string
  session_id: string | null
  cmd: string | string[]
  cwd: string
  exit_code: number | null
  duration_ms: number | null
  started_at: string
  ended_at: string | null
  resource_usage: ResourceUsage | null
  output_ref: string
}

export interface ReplayArtifact {
  artifact_id: string
  name: string
  mime: string
  bytes: number
  sha256: string
  download_url: string
  collected_at: string
}

export interface ReplayBundle {
  version: number
  sandbox_id: string
  status: ReplayStatus
  image: string
  profile: ProfileName
  forked_from: string | null
  fork_tree: ReplayForkTreeNode
  started_at: string
  ended_at: string | null
  total_duration_ms: number | null
  sessions: ReplaySession[]
  execs: ReplayExec[]
  artifacts: ReplayArtifact[]
  events_url: string
}

// ---------------------------------------------------------------------------
// Event log types
// ---------------------------------------------------------------------------

export type ReplayEventType =
  | 'sandbox.created'
  | 'sandbox.ready'
  | 'sandbox.forked'
  | 'sandbox.stopping'
  | 'sandbox.stopped'
  | 'sandbox.failed'
  | 'exec.started'
  | 'exec.output'
  | 'exec.completed'
  | 'exec.failed'
  | 'session.created'
  | 'session.destroyed'
  | 'file.written'
  | 'file.deleted'
  | 'artifact.registered'
  | 'artifact.collected'

/** A single event in the sandbox event log (JSONL format). */
export interface ReplayEvent {
  ts: string
  seq: number
  type: ReplayEventType
  data: Record<string, unknown>
}

/** Exec output log entry (per-exec JSONL files). */
export interface ExecOutputEntry {
  ts: string
  seq: number
  stream: 'stdout' | 'stderr'
  data: string
}
