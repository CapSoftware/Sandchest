import { HttpRouter, HttpServerRequest, HttpServerResponse } from '@effect/platform'
import { Effect } from 'effect'
import {
  generateUUIDv7,
  idToBytes,
  bytesToId,
  EXEC_PREFIX,
  SANDBOX_PREFIX,
  SESSION_PREFIX,
} from '@sandchest/contract'
import type {
  ExecRequest,
  ExecSyncResponse,
  ExecAsyncResponse,
  GetExecResponse,
  ListExecsResponse,
  ExecStatus,
  ExecStreamEvent,
  Exec,
} from '@sandchest/contract'
import { NotFoundError, SandboxNotRunningError, ValidationError, BillingLimitError } from '../errors.js'
import { AuthContext } from '../context.js'
import { requireScope } from '../scopes.js'
import { SandboxRepo } from '../services/sandbox-repo.js'
import { ExecRepo, type ExecRow } from '../services/exec-repo.js'
import { NodeClient } from '../services/node-client.js'
import { RedisService } from '../services/redis.js'
import { QuotaService } from '../services/quota.js'
import { BillingService } from '../services/billing.js'

const VALID_STATUSES: ExecStatus[] = ['queued', 'running', 'done', 'failed', 'timed_out']
const DEFAULT_TIMEOUT = 300
const MAX_SYNC_TIMEOUT = 300
const DEFAULT_CWD = '/root'
const STDOUT_MAX_BYTES = 1_048_576
const EVENT_TTL_SECONDS = 600

function rowToExec(row: ExecRow): Exec {
  const execId = bytesToId(EXEC_PREFIX, row.id)
  const sandboxId = bytesToId(SANDBOX_PREFIX, row.sandboxId)

  let cmd: string | string[]
  if (row.cmdFormat === 'array') {
    try {
      cmd = JSON.parse(row.cmd) as string[]
    } catch {
      cmd = row.cmd
    }
  } else {
    cmd = row.cmd
  }

  return {
    exec_id: execId,
    sandbox_id: sandboxId,
    session_id: row.sessionId ? bytesToId(SESSION_PREFIX, row.sessionId) : null,
    cmd,
    status: row.status,
    exit_code: row.exitCode,
    duration_ms: row.durationMs,
    resource_usage:
      row.cpuMs != null && row.peakMemoryBytes != null
        ? { cpu_ms: row.cpuMs, peak_memory_bytes: row.peakMemoryBytes }
        : null,
    created_at: row.createdAt.toISOString(),
    started_at: row.startedAt?.toISOString() ?? null,
    ended_at: row.endedAt?.toISOString() ?? null,
  }
}

// -- Execute command ----------------------------------------------------------

const execCommand = Effect.gen(function* () {
  yield* requireScope('exec:create')
  const auth = yield* AuthContext
  const sandboxRepo = yield* SandboxRepo
  const execRepo = yield* ExecRepo
  const nodeClient = yield* NodeClient
  const redis = yield* RedisService
  const quotaService = yield* QuotaService
  const billing = yield* BillingService
  const request = yield* HttpServerRequest.HttpServerRequest
  const params = yield* HttpRouter.params

  // Billing: check exec access
  const billingCheck = yield* billing.check(auth.userId, 'execs')
  if (!billingCheck.allowed) {
    return yield* Effect.fail(
      new BillingLimitError({ message: 'Exec limit reached on your current plan' }),
    )
  }

  const sandboxIdStr = params.id
  if (!sandboxIdStr) {
    return yield* Effect.fail(new ValidationError({ message: 'Missing sandbox ID' }))
  }

  let sandboxIdBytes: Uint8Array
  try {
    sandboxIdBytes = idToBytes(sandboxIdStr)
  } catch {
    return yield* Effect.fail(
      new ValidationError({ message: `Invalid sandbox ID: ${sandboxIdStr}` }),
    )
  }

  const raw = yield* request.json.pipe(Effect.orElseSucceed(() => ({})))
  const body: ExecRequest =
    raw && typeof raw === 'object' ? (raw as ExecRequest) : ({ cmd: [] } as ExecRequest)

  // Validate cmd
  if (body.cmd === undefined || body.cmd === null) {
    return yield* Effect.fail(new ValidationError({ message: 'cmd is required' }))
  }
  if (Array.isArray(body.cmd) && body.cmd.length === 0) {
    return yield* Effect.fail(
      new ValidationError({ message: 'cmd must not be empty' }),
    )
  }
  if (typeof body.cmd === 'string' && body.cmd.trim().length === 0) {
    return yield* Effect.fail(
      new ValidationError({ message: 'cmd must not be empty' }),
    )
  }

  const wait = body.wait !== false
  const timeoutSeconds = body.timeout_seconds ?? DEFAULT_TIMEOUT
  const quota = yield* quotaService.getOrgQuota(auth.orgId)

  if (timeoutSeconds < 1 || timeoutSeconds > quota.maxExecTimeoutSeconds) {
    return yield* Effect.fail(
      new ValidationError({
        message: `timeout_seconds must be between 1 and ${quota.maxExecTimeoutSeconds}`,
      }),
    )
  }

  if (wait && timeoutSeconds > MAX_SYNC_TIMEOUT) {
    return yield* Effect.fail(
      new ValidationError({
        message: `Sync exec timeout must not exceed ${MAX_SYNC_TIMEOUT} seconds`,
      }),
    )
  }

  // Verify sandbox exists and is running
  const sandbox = yield* sandboxRepo.findById(sandboxIdBytes, auth.orgId)
  if (!sandbox) {
    return yield* Effect.fail(
      new NotFoundError({ message: `Sandbox ${sandboxIdStr} not found` }),
    )
  }
  if (sandbox.status !== 'running') {
    return yield* Effect.fail(
      new SandboxNotRunningError({
        message: `Sandbox ${sandboxIdStr} is not in running state (current: ${sandbox.status})`,
      }),
    )
  }

  // Touch last activity
  yield* sandboxRepo.touchLastActivity(sandboxIdBytes, auth.orgId)

  // Determine cmd format and serialization
  const isArray = Array.isArray(body.cmd)
  const cmdFormat = isArray ? ('array' as const) : ('shell' as const)
  const cmdStr = isArray ? JSON.stringify(body.cmd) : (body.cmd as string)
  const cmdArray = isArray
    ? (body.cmd as string[])
    : ['/bin/sh', '-c', body.cmd as string]

  // Create exec row
  const seq = yield* execRepo.nextSeq(sandboxIdBytes)
  const execId = generateUUIDv7()
  yield* execRepo.create({
    id: execId,
    sandboxId: sandboxIdBytes,
    orgId: auth.orgId,
    seq,
    cmd: cmdStr,
    cmdFormat,
    cwd: body.cwd,
    env: body.env,
  })

  const execIdStr = bytesToId(EXEC_PREFIX, execId)

  // Async mode: return immediately
  if (!wait) {
    // Billing: track exec (fire-and-forget)
    yield* billing.track(auth.userId, 'execs')

    const response: ExecAsyncResponse = {
      exec_id: execIdStr,
      status: 'queued',
    }
    return HttpServerResponse.unsafeJson(response, { status: 202 })
  }

  // Sync mode: execute and wait for result
  yield* execRepo.updateStatus(execId, 'running', { startedAt: new Date() })

  const result = yield* nodeClient.exec({
    sandboxId: sandboxIdBytes,
    execId: execIdStr,
    cmd: cmdArray,
    cwd: body.cwd ?? DEFAULT_CWD,
    env: body.env ?? {},
    timeoutSeconds,
  })

  // Push events to Redis for SSE consumption
  let eventSeq = 0
  const now = new Date().toISOString()

  if (result.stdout) {
    eventSeq++
    yield* redis.pushExecEvent(
      execIdStr,
      { seq: eventSeq, ts: now, data: { seq: eventSeq, t: 'stdout', data: result.stdout } },
      EVENT_TTL_SECONDS,
    )
  }
  if (result.stderr) {
    eventSeq++
    yield* redis.pushExecEvent(
      execIdStr,
      { seq: eventSeq, ts: now, data: { seq: eventSeq, t: 'stderr', data: result.stderr } },
      EVENT_TTL_SECONDS,
    )
  }
  eventSeq++
  yield* redis.pushExecEvent(
    execIdStr,
    {
      seq: eventSeq,
      ts: now,
      data: {
        seq: eventSeq,
        t: 'exit',
        code: result.exitCode,
        duration_ms: result.durationMs,
        resource_usage: {
          cpu_ms: result.cpuMs,
          peak_memory_bytes: result.peakMemoryBytes,
        },
      },
    },
    EVENT_TTL_SECONDS,
  )

  // Update exec row to done
  yield* execRepo.updateStatus(execId, 'done', {
    exitCode: result.exitCode,
    cpuMs: result.cpuMs,
    peakMemoryBytes: result.peakMemoryBytes,
    durationMs: result.durationMs,
    endedAt: new Date(),
  })

  const stdout =
    result.stdout.length > STDOUT_MAX_BYTES
      ? result.stdout.slice(0, STDOUT_MAX_BYTES)
      : result.stdout
  const stderr =
    result.stderr.length > STDOUT_MAX_BYTES
      ? result.stderr.slice(0, STDOUT_MAX_BYTES)
      : result.stderr

  // Billing: track exec (fire-and-forget)
  yield* billing.track(auth.userId, 'execs')

  const response: ExecSyncResponse = {
    exec_id: execIdStr,
    status: 'done',
    exit_code: result.exitCode,
    stdout,
    stderr,
    duration_ms: result.durationMs,
    resource_usage: {
      cpu_ms: result.cpuMs,
      peak_memory_bytes: result.peakMemoryBytes,
    },
  }

  return HttpServerResponse.unsafeJson(response)
})

// -- Get exec ----------------------------------------------------------------

const getExec = Effect.gen(function* () {
  yield* requireScope('exec:read')
  const auth = yield* AuthContext
  const execRepo = yield* ExecRepo
  const params = yield* HttpRouter.params

  const sandboxIdStr = params.id
  const execIdStr = params.execId

  if (!sandboxIdStr) {
    return yield* Effect.fail(new ValidationError({ message: 'Missing sandbox ID' }))
  }
  if (!execIdStr) {
    return yield* Effect.fail(new ValidationError({ message: 'Missing exec ID' }))
  }

  let sandboxIdBytes: Uint8Array
  let execIdBytes: Uint8Array
  try {
    sandboxIdBytes = idToBytes(sandboxIdStr)
  } catch {
    return yield* Effect.fail(
      new ValidationError({ message: `Invalid sandbox ID: ${sandboxIdStr}` }),
    )
  }
  try {
    execIdBytes = idToBytes(execIdStr)
  } catch {
    return yield* Effect.fail(
      new ValidationError({ message: `Invalid exec ID: ${execIdStr}` }),
    )
  }

  const row = yield* execRepo.findById(execIdBytes, sandboxIdBytes, auth.orgId)
  if (!row) {
    return yield* Effect.fail(
      new NotFoundError({ message: `Exec ${execIdStr} not found` }),
    )
  }

  const response: GetExecResponse = rowToExec(row)
  return HttpServerResponse.unsafeJson(response)
})

// -- List execs --------------------------------------------------------------

const listExecs = Effect.gen(function* () {
  yield* requireScope('exec:read')
  const auth = yield* AuthContext
  const sandboxRepo = yield* SandboxRepo
  const execRepo = yield* ExecRepo
  const request = yield* HttpServerRequest.HttpServerRequest
  const params = yield* HttpRouter.params

  const sandboxIdStr = params.id
  if (!sandboxIdStr) {
    return yield* Effect.fail(new ValidationError({ message: 'Missing sandbox ID' }))
  }

  let sandboxIdBytes: Uint8Array
  try {
    sandboxIdBytes = idToBytes(sandboxIdStr)
  } catch {
    return yield* Effect.fail(
      new ValidationError({ message: `Invalid sandbox ID: ${sandboxIdStr}` }),
    )
  }

  // Verify sandbox exists and belongs to org
  const sandbox = yield* sandboxRepo.findById(sandboxIdBytes, auth.orgId)
  if (!sandbox) {
    return yield* Effect.fail(
      new NotFoundError({ message: `Sandbox ${sandboxIdStr} not found` }),
    )
  }

  const url = new URL(request.url, 'http://localhost')
  const status = url.searchParams.get('status') as ExecStatus | null
  const sessionId = url.searchParams.get('session_id')
  const cursor = url.searchParams.get('cursor')
  const limitStr = url.searchParams.get('limit')
  const limit = limitStr ? parseInt(limitStr, 10) : undefined

  if (status && !VALID_STATUSES.includes(status)) {
    return yield* Effect.fail(
      new ValidationError({
        message: `Invalid status filter: ${status}. Must be one of: ${VALID_STATUSES.join(', ')}`,
      }),
    )
  }

  if (limit !== undefined && (isNaN(limit) || limit < 1 || limit > 200)) {
    return yield* Effect.fail(
      new ValidationError({ message: 'limit must be between 1 and 200' }),
    )
  }

  let sessionIdBytes: Uint8Array | undefined
  if (sessionId) {
    try {
      sessionIdBytes = idToBytes(sessionId)
    } catch {
      return yield* Effect.fail(
        new ValidationError({ message: `Invalid session ID: ${sessionId}` }),
      )
    }
  }

  const result = yield* execRepo.list(sandboxIdBytes, auth.orgId, {
    status: status ?? undefined,
    sessionId: sessionIdBytes,
    cursor: cursor ?? undefined,
    limit,
  })

  const response: ListExecsResponse = {
    execs: result.rows.map(rowToExec),
    next_cursor: result.nextCursor,
  }

  return HttpServerResponse.unsafeJson(response)
})

// -- Stream exec output (SSE) ------------------------------------------------

const streamExec = Effect.gen(function* () {
  yield* requireScope('exec:read')
  const auth = yield* AuthContext
  const execRepo = yield* ExecRepo
  const redis = yield* RedisService
  const request = yield* HttpServerRequest.HttpServerRequest
  const params = yield* HttpRouter.params

  const sandboxIdStr = params.id
  const execIdStr = params.execId

  if (!sandboxIdStr) {
    return yield* Effect.fail(new ValidationError({ message: 'Missing sandbox ID' }))
  }
  if (!execIdStr) {
    return yield* Effect.fail(new ValidationError({ message: 'Missing exec ID' }))
  }

  let sandboxIdBytes: Uint8Array
  let execIdBytes: Uint8Array
  try {
    sandboxIdBytes = idToBytes(sandboxIdStr)
  } catch {
    return yield* Effect.fail(
      new ValidationError({ message: `Invalid sandbox ID: ${sandboxIdStr}` }),
    )
  }
  try {
    execIdBytes = idToBytes(execIdStr)
  } catch {
    return yield* Effect.fail(
      new ValidationError({ message: `Invalid exec ID: ${execIdStr}` }),
    )
  }

  const row = yield* execRepo.findById(execIdBytes, sandboxIdBytes, auth.orgId)
  if (!row) {
    return yield* Effect.fail(
      new NotFoundError({ message: `Exec ${execIdStr} not found` }),
    )
  }

  // Parse Last-Event-ID header for reconnection
  const lastEventIdHeader = request.headers['last-event-id']
  const afterSeq = lastEventIdHeader ? parseInt(lastEventIdHeader, 10) : 0

  // Get buffered events from Redis
  const events = yield* redis.getExecEvents(execIdStr, isNaN(afterSeq) ? 0 : afterSeq)

  // Format as SSE
  let sseBody = ''
  for (const event of events) {
    const data = event.data as ExecStreamEvent
    sseBody += `id: ${data.seq}\ndata: ${JSON.stringify(data)}\n\n`
  }

  return HttpServerResponse.text(sseBody, {
    contentType: 'text/event-stream',
    headers: { 'cache-control': 'no-cache' },
  })
})

// -- Router ------------------------------------------------------------------

export const ExecRouter = HttpRouter.empty.pipe(
  HttpRouter.post('/v1/sandboxes/:id/exec', execCommand),
  HttpRouter.get('/v1/sandboxes/:id/exec/:execId', getExec),
  HttpRouter.get('/v1/sandboxes/:id/execs', listExecs),
  HttpRouter.get('/v1/sandboxes/:id/exec/:execId/stream', streamExec),
)
