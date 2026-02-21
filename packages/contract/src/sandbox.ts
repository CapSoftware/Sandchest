import type { ResourceUsage } from './common.js'

// ---------------------------------------------------------------------------
// Enums / Literal unions
// ---------------------------------------------------------------------------

export type SandboxStatus =
  | 'queued'
  | 'provisioning'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'deleted'

export type ExecStatus = 'queued' | 'running' | 'done' | 'failed' | 'timed_out'

export type SessionStatus = 'running' | 'destroyed'

export type ProfileName = 'small' | 'medium' | 'large'

export type FailureReason =
  | 'capacity_timeout'
  | 'node_lost'
  | 'provision_failed'
  | 'sandbox_stopped'
  | 'sandbox_deleted'
  | 'ttl_exceeded'
  | 'idle_timeout'
  | 'queue_timeout'

// ---------------------------------------------------------------------------
// Resource types
// ---------------------------------------------------------------------------

/** Full sandbox resource as returned by GET /v1/sandboxes/{id}. */
export interface Sandbox {
  sandbox_id: string
  image: string
  profile: ProfileName
  status: SandboxStatus
  env: Record<string, string>
  forked_from: string | null
  fork_count: number
  created_at: string
  started_at: string | null
  ended_at: string | null
  failure_reason: FailureReason | null
  replay_url: string
}

/** Abbreviated sandbox for list endpoints. */
export interface SandboxSummary {
  sandbox_id: string
  status: SandboxStatus
  image: string
  profile: ProfileName
  forked_from: string | null
  created_at: string
  replay_url: string
}

/** Fork tree node. */
export interface ForkTreeNode {
  sandbox_id: string
  status: SandboxStatus
  forked_from: string | null
  forked_at: string | null
  children: string[]
}

/** Full exec resource as returned by GET /v1/sandboxes/{id}/exec/{exec_id}. */
export interface Exec {
  exec_id: string
  sandbox_id: string
  session_id: string | null
  cmd: string | string[]
  status: ExecStatus
  exit_code: number | null
  duration_ms: number | null
  resource_usage: ResourceUsage | null
  created_at: string
  started_at: string | null
  ended_at: string | null
}

/** Session resource. */
export interface Session {
  session_id: string
  status: SessionStatus
  shell: string
  created_at: string
  destroyed_at: string | null
}

/** Artifact resource. */
export interface Artifact {
  id: string
  name: string
  mime: string
  bytes: number
  sha256: string
  download_url: string
  exec_id: string | null
  created_at: string
}
