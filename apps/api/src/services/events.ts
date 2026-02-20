import type { ReplayEventType, ResourceUsage } from '@sandchest/contract'

/** Event payload before sequence and timestamp are assigned. */
export interface EventPayload {
  readonly type: ReplayEventType
  readonly data: Record<string, unknown>
}

// -- Sandbox lifecycle -------------------------------------------------------

export function sandboxCreated(params: {
  image: string
  profile: string
  env: Record<string, string> | null
  forked_from: string | null
}): EventPayload {
  const redactedEnv: Record<string, string> = {}
  if (params.env) {
    for (const key of Object.keys(params.env)) {
      redactedEnv[key] = '[REDACTED]'
    }
  }
  return {
    type: 'sandbox.created',
    data: {
      image: params.image,
      profile: params.profile,
      env: redactedEnv,
      forked_from: params.forked_from,
    },
  }
}

export function sandboxReady(params: { boot_duration_ms: number }): EventPayload {
  return { type: 'sandbox.ready', data: { boot_duration_ms: params.boot_duration_ms } }
}

export function sandboxForked(params: { fork_sandbox_id: string }): EventPayload {
  return { type: 'sandbox.forked', data: { fork_sandbox_id: params.fork_sandbox_id } }
}

export function sandboxStopping(params: { reason: string }): EventPayload {
  return { type: 'sandbox.stopping', data: { reason: params.reason } }
}

export function sandboxStopped(params: { total_duration_ms: number }): EventPayload {
  return { type: 'sandbox.stopped', data: { total_duration_ms: params.total_duration_ms } }
}

export function sandboxFailed(params: { failure_reason: string }): EventPayload {
  return { type: 'sandbox.failed', data: { failure_reason: params.failure_reason } }
}

// -- Exec operations ---------------------------------------------------------

export function execStarted(params: {
  exec_id: string
  cmd: string | string[]
  cwd: string
  session_id: string | null
}): EventPayload {
  return {
    type: 'exec.started',
    data: {
      exec_id: params.exec_id,
      cmd: params.cmd,
      cwd: params.cwd,
      session_id: params.session_id,
    },
  }
}

export function execOutput(params: {
  exec_id: string
  stream: 'stdout' | 'stderr'
  data: string
}): EventPayload {
  return {
    type: 'exec.output',
    data: {
      exec_id: params.exec_id,
      stream: params.stream,
      data: params.data,
    },
  }
}

export function execCompleted(params: {
  exec_id: string
  exit_code: number
  duration_ms: number
  resource_usage: ResourceUsage | null
}): EventPayload {
  return {
    type: 'exec.completed',
    data: {
      exec_id: params.exec_id,
      exit_code: params.exit_code,
      duration_ms: params.duration_ms,
      resource_usage: params.resource_usage,
    },
  }
}

export function execFailed(params: {
  exec_id: string
  reason: string
}): EventPayload {
  return {
    type: 'exec.failed',
    data: { exec_id: params.exec_id, reason: params.reason },
  }
}

// -- Session management ------------------------------------------------------

export function sessionCreated(params: {
  session_id: string
  shell: string
}): EventPayload {
  return {
    type: 'session.created',
    data: { session_id: params.session_id, shell: params.shell },
  }
}

export function sessionDestroyed(params: { session_id: string }): EventPayload {
  return { type: 'session.destroyed', data: { session_id: params.session_id } }
}

// -- File operations ---------------------------------------------------------

export function fileWritten(params: {
  path: string
  size_bytes: number
}): EventPayload {
  return {
    type: 'file.written',
    data: { path: params.path, size_bytes: params.size_bytes },
  }
}

export function fileDeleted(params: { path: string }): EventPayload {
  return { type: 'file.deleted', data: { path: params.path } }
}

// -- Artifacts ---------------------------------------------------------------

export function artifactRegistered(params: { paths: string[] }): EventPayload {
  return { type: 'artifact.registered', data: { paths: params.paths } }
}

export function artifactCollected(params: {
  artifact_id: string
  name: string
  mime: string
  bytes: number
  sha256: string
}): EventPayload {
  return {
    type: 'artifact.collected',
    data: {
      artifact_id: params.artifact_id,
      name: params.name,
      mime: params.mime,
      bytes: params.bytes,
      sha256: params.sha256,
    },
  }
}
