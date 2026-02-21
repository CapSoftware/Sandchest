import type { ResourceUsage } from './common.js'
import type {
  Artifact,
  Exec,
  ExecStatus,
  FailureReason,
  ForkTreeNode,
  ProfileName,
  SandboxStatus,
  SandboxSummary,
  Session,
  SessionStatus,
} from './sandbox.js'

// ---------------------------------------------------------------------------
// Sandbox endpoints
// ---------------------------------------------------------------------------

/** POST /v1/sandboxes — request body. */
export interface CreateSandboxRequest {
  image?: string | undefined
  profile?: ProfileName | undefined
  env?: Record<string, string> | undefined
  ttl_seconds?: number | undefined
  queue_timeout_seconds?: number | undefined
}

/** POST /v1/sandboxes — 201 response. */
export interface CreateSandboxResponse {
  sandbox_id: string
  status: SandboxStatus
  queue_position: number
  estimated_ready_seconds: number
  replay_url: string
  created_at: string
}

/** GET /v1/sandboxes/{id} — 200 response. */
export interface GetSandboxResponse {
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
  replay_public: boolean
}

/** PATCH /v1/sandboxes/{id}/replay — request body. */
export interface SetReplayVisibilityRequest {
  public: boolean
}

/** PATCH /v1/sandboxes/{id}/replay — 200 response. */
export interface SetReplayVisibilityResponse {
  sandbox_id: string
  replay_public: boolean
}

/** GET /v1/sandboxes — query parameters. */
export interface ListSandboxesParams {
  status?: SandboxStatus | undefined
  image?: string | undefined
  forked_from?: string | undefined
  cursor?: string | undefined
  limit?: number | undefined
}

/** GET /v1/sandboxes — 200 response. */
export interface ListSandboxesResponse {
  sandboxes: SandboxSummary[]
  next_cursor: string | null
}

// ---------------------------------------------------------------------------
// Fork endpoints
// ---------------------------------------------------------------------------

/** POST /v1/sandboxes/{id}/fork — request body. */
export interface ForkSandboxRequest {
  env?: Record<string, string> | undefined
  ttl_seconds?: number | undefined
}

/** POST /v1/sandboxes/{id}/fork — 201 response. */
export interface ForkSandboxResponse {
  sandbox_id: string
  forked_from: string
  status: SandboxStatus
  replay_url: string
  created_at: string
}

/** GET /v1/sandboxes/{id}/forks — 200 response. */
export interface GetForkTreeResponse {
  root: string
  tree: ForkTreeNode[]
}

// ---------------------------------------------------------------------------
// Exec endpoints
// ---------------------------------------------------------------------------

/** POST /v1/sandboxes/{id}/exec — request body. */
export interface ExecRequest {
  cmd: string | string[]
  cwd?: string | undefined
  env?: Record<string, string> | undefined
  timeout_seconds?: number | undefined
  wait?: boolean | undefined
}

/** POST /v1/sandboxes/{id}/exec — sync response (wait: true). */
export interface ExecSyncResponse {
  exec_id: string
  status: ExecStatus
  exit_code: number
  stdout: string
  stderr: string
  duration_ms: number
  resource_usage: ResourceUsage
}

/** POST /v1/sandboxes/{id}/exec — async response (wait: false). */
export interface ExecAsyncResponse {
  exec_id: string
  status: ExecStatus
}

/** GET /v1/sandboxes/{id}/exec/{exec_id} — 200 response. Re-exports Exec. */
export type GetExecResponse = Exec

/** GET /v1/sandboxes/{id}/execs — query parameters. */
export interface ListExecsParams {
  status?: ExecStatus | undefined
  session_id?: string | undefined
  cursor?: string | undefined
  limit?: number | undefined
}

/** GET /v1/sandboxes/{id}/execs — 200 response. */
export interface ListExecsResponse {
  execs: Exec[]
  next_cursor: string | null
}

// ---------------------------------------------------------------------------
// Exec stream events (SSE)
// ---------------------------------------------------------------------------

export interface ExecStreamStdout {
  seq: number
  t: 'stdout'
  data: string
}

export interface ExecStreamStderr {
  seq: number
  t: 'stderr'
  data: string
}

export interface ExecStreamExit {
  seq: number
  t: 'exit'
  code: number
  duration_ms: number
  resource_usage: ResourceUsage
}

export type ExecStreamEvent = ExecStreamStdout | ExecStreamStderr | ExecStreamExit

// ---------------------------------------------------------------------------
// Session endpoints
// ---------------------------------------------------------------------------

/** POST /v1/sandboxes/{id}/sessions — request body. */
export interface CreateSessionRequest {
  shell?: string | undefined
  env?: Record<string, string> | undefined
}

/** POST /v1/sandboxes/{id}/sessions — 201 response. */
export interface CreateSessionResponse {
  session_id: string
  status: SessionStatus
}

/** POST /v1/sandboxes/{id}/sessions/{session_id}/exec — request body. */
export interface SessionExecRequest {
  cmd: string
  timeout_seconds?: number | undefined
  wait?: boolean | undefined
}

/** POST /v1/sandboxes/{id}/sessions/{session_id}/exec — sync response. */
export interface SessionExecResponse {
  exec_id: string
  status: ExecStatus
  exit_code: number
  stdout: string
  stderr: string
  duration_ms: number
  resource_usage: ResourceUsage
}

/** POST /v1/sandboxes/{id}/sessions/{session_id}/input — request body. */
export interface SessionInputRequest {
  data: string
}

/** GET /v1/sandboxes/{id}/sessions — 200 response. */
export interface ListSessionsResponse {
  sessions: Session[]
  next_cursor: string | null
}

// ---------------------------------------------------------------------------
// File endpoints
// ---------------------------------------------------------------------------

/** GET /v1/sandboxes/{id}/files?list=true — directory entry. */
export interface FileEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size_bytes: number | null
}

/** GET /v1/sandboxes/{id}/files?list=true — 200 response. */
export interface ListFilesResponse {
  files: FileEntry[]
  next_cursor: string | null
}

// ---------------------------------------------------------------------------
// Artifact endpoints
// ---------------------------------------------------------------------------

/** POST /v1/sandboxes/{id}/artifacts — request body. */
export interface RegisterArtifactsRequest {
  paths: string[]
}

/** POST /v1/sandboxes/{id}/artifacts — 200 response. */
export interface RegisterArtifactsResponse {
  registered: number
  total: number
}

/** GET /v1/sandboxes/{id}/artifacts — 200 response. */
export interface ListArtifactsResponse {
  artifacts: Artifact[]
  next_cursor: string | null
}

// ---------------------------------------------------------------------------
// Stop / Delete endpoints
// ---------------------------------------------------------------------------

/** POST /v1/sandboxes/{id}/stop — 202 response. */
export interface StopSandboxResponse {
  sandbox_id: string
  status: SandboxStatus
}
