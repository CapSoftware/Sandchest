import { HttpRouter, HttpServerRequest, HttpServerResponse } from '@effect/platform'
import { Effect } from 'effect'
import {
  generateUUIDv7,
  idToBytes,
  bytesToId,
  SESSION_PREFIX,
  EXEC_PREFIX,
} from '@sandchest/contract'
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  SessionExecRequest,
  SessionExecResponse,
  SessionInputRequest,
  ListSessionsResponse,
  Session,
  ExecStreamEvent,
} from '@sandchest/contract'
import {
  NotFoundError,
  SandboxNotRunningError,
  ValidationError,
  ConflictError,
  BillingLimitError,
} from '../errors.js'
import { AuthContext } from '../context.js'
import { requireScope } from '../scopes.js'
import { SandboxRepo } from '../services/sandbox-repo.js'
import { SessionRepo, type SessionRow } from '../services/session-repo.js'
import { ExecRepo } from '../services/exec-repo.js'
import { NodeClient } from '../services/node-client.js'
import { RedisService } from '../services/redis.js'
import { BillingService } from '../services/billing.js'

const MAX_SESSIONS = 5
const DEFAULT_SHELL = '/bin/bash'
const DEFAULT_TIMEOUT = 300
const MAX_SYNC_TIMEOUT = 300
const STDOUT_MAX_BYTES = 1_048_576
const EVENT_TTL_SECONDS = 600

function rowToSession(row: SessionRow): Session {
  const sessionId = bytesToId(SESSION_PREFIX, row.id)
  return {
    session_id: sessionId,
    status: row.status,
    shell: row.shell,
    created_at: row.createdAt.toISOString(),
    destroyed_at: row.destroyedAt?.toISOString() ?? null,
  }
}

function parseSandboxId(idStr: string | undefined) {
  if (!idStr) {
    return Effect.fail(new ValidationError({ message: 'Missing sandbox ID' }))
  }
  try {
    return Effect.succeed(idToBytes(idStr))
  } catch {
    return Effect.fail(new ValidationError({ message: `Invalid sandbox ID: ${idStr}` }))
  }
}

function parseSessionId(idStr: string | undefined) {
  if (!idStr) {
    return Effect.fail(new ValidationError({ message: 'Missing session ID' }))
  }
  try {
    return Effect.succeed(idToBytes(idStr))
  } catch {
    return Effect.fail(new ValidationError({ message: `Invalid session ID: ${idStr}` }))
  }
}

// -- Create session ----------------------------------------------------------

const createSession = Effect.gen(function* () {
  yield* requireScope('session:create')
  const auth = yield* AuthContext
  const sandboxRepo = yield* SandboxRepo
  const sessionRepo = yield* SessionRepo
  const nodeClient = yield* NodeClient
  const request = yield* HttpServerRequest.HttpServerRequest
  const params = yield* HttpRouter.params

  const sandboxIdBytes = yield* parseSandboxId(params.id)
  const sandboxIdStr = params.id!

  // Verify sandbox exists and is running
  const sandbox = yield* sandboxRepo.findById(sandboxIdBytes, auth.orgId)
  if (!sandbox) {
    return yield* Effect.fail(new NotFoundError({ message: `Sandbox ${sandboxIdStr} not found` }))
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

  const raw = yield* request.json.pipe(Effect.orElseSucceed(() => ({})))
  const body = raw && typeof raw === 'object' ? (raw as CreateSessionRequest) : ({} as CreateSessionRequest)

  const shell = body.shell ?? DEFAULT_SHELL
  const env = body.env ?? {}

  // Enforce max 5 concurrent sessions
  const activeCount = yield* sessionRepo.countActive(sandboxIdBytes)
  if (activeCount >= MAX_SESSIONS) {
    return yield* Effect.fail(
      new ConflictError({
        message: `Maximum ${MAX_SESSIONS} concurrent sessions per sandbox exceeded`,
      }),
    )
  }

  // Create session ID and DB row
  const sessionId = generateUUIDv7()
  yield* sessionRepo.create({
    id: sessionId,
    sandboxId: sandboxIdBytes,
    orgId: auth.orgId,
    shell,
  })

  const sessionIdStr = bytesToId(SESSION_PREFIX, sessionId)

  // Route to node
  yield* nodeClient.createSession({
    sandboxId: sandboxIdBytes,
    sessionId: sessionIdStr,
    shell,
    env,
  })

  const response: CreateSessionResponse = {
    session_id: sessionIdStr,
    status: 'running',
  }
  return HttpServerResponse.unsafeJson(response, { status: 201 })
})

// -- Session exec ------------------------------------------------------------

const sessionExec = Effect.gen(function* () {
  yield* requireScope('session:write')
  const auth = yield* AuthContext
  const sandboxRepo = yield* SandboxRepo
  const sessionRepo = yield* SessionRepo
  const execRepo = yield* ExecRepo
  const nodeClient = yield* NodeClient
  const redis = yield* RedisService
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

  const sandboxIdBytes = yield* parseSandboxId(params.id)
  const sandboxIdStr = params.id!
  const sessionIdBytes = yield* parseSessionId(params.sessionId)
  const sessionIdStr = params.sessionId!

  // Verify sandbox exists and is running
  const sandbox = yield* sandboxRepo.findById(sandboxIdBytes, auth.orgId)
  if (!sandbox) {
    return yield* Effect.fail(new NotFoundError({ message: `Sandbox ${sandboxIdStr} not found` }))
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

  // Verify session exists
  const session = yield* sessionRepo.findById(sessionIdBytes, sandboxIdBytes, auth.orgId)
  if (!session) {
    return yield* Effect.fail(new NotFoundError({ message: `Session ${sessionIdStr} not found` }))
  }
  if (session.status !== 'running') {
    return yield* Effect.fail(
      new ConflictError({ message: `Session ${sessionIdStr} is not running` }),
    )
  }

  const raw = yield* request.json.pipe(Effect.orElseSucceed(() => ({})))
  const body = raw && typeof raw === 'object' ? (raw as SessionExecRequest) : ({} as SessionExecRequest)

  // Validate cmd (string only for sessions)
  if (!body.cmd || typeof body.cmd !== 'string' || body.cmd.trim().length === 0) {
    return yield* Effect.fail(
      new ValidationError({ message: 'cmd is required and must be a non-empty string' }),
    )
  }

  const wait = body.wait !== false
  const timeoutSeconds = body.timeout_seconds ?? DEFAULT_TIMEOUT

  if (timeoutSeconds < 1 || timeoutSeconds > 3600) {
    return yield* Effect.fail(
      new ValidationError({ message: 'timeout_seconds must be between 1 and 3600' }),
    )
  }

  if (wait && timeoutSeconds > MAX_SYNC_TIMEOUT) {
    return yield* Effect.fail(
      new ValidationError({
        message: `Sync exec timeout must not exceed ${MAX_SYNC_TIMEOUT} seconds`,
      }),
    )
  }

  // Create exec row linked to session
  const seq = yield* execRepo.nextSeq(sandboxIdBytes)
  const execId = generateUUIDv7()
  yield* execRepo.create({
    id: execId,
    sandboxId: sandboxIdBytes,
    orgId: auth.orgId,
    sessionId: sessionIdBytes,
    seq,
    cmd: body.cmd,
    cmdFormat: 'shell',
  })

  const execIdStr = bytesToId(EXEC_PREFIX, execId)

  // Async mode
  if (!wait) {
    // Billing: track exec (fire-and-forget)
    yield* billing.track(auth.userId, 'execs')

    return HttpServerResponse.unsafeJson(
      { exec_id: execIdStr, status: 'queued' },
      { status: 202 },
    )
  }

  // Sync mode: execute and wait
  yield* execRepo.updateStatus(execId, 'running', { startedAt: new Date() })

  const result = yield* nodeClient.sessionExec({
    sandboxId: sandboxIdBytes,
    sessionId: sessionIdStr,
    cmd: body.cmd,
    timeoutSeconds,
  })

  // Push events to Redis
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
      data: { seq: eventSeq, t: 'exit', code: result.exitCode, duration_ms: result.durationMs },
    },
    EVENT_TTL_SECONDS,
  )

  yield* execRepo.updateStatus(execId, 'done', {
    exitCode: result.exitCode,
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

  const response: SessionExecResponse = {
    exec_id: execIdStr,
    status: 'done',
    exit_code: result.exitCode,
    stdout,
    stderr,
    duration_ms: result.durationMs,
    resource_usage: { cpu_ms: 0, peak_memory_bytes: 0 },
  }

  return HttpServerResponse.unsafeJson(response)
})

// -- Session input -----------------------------------------------------------

const sessionInput = Effect.gen(function* () {
  yield* requireScope('session:write')
  const auth = yield* AuthContext
  const sandboxRepo = yield* SandboxRepo
  const sessionRepo = yield* SessionRepo
  const nodeClient = yield* NodeClient
  const request = yield* HttpServerRequest.HttpServerRequest
  const params = yield* HttpRouter.params

  const sandboxIdBytes = yield* parseSandboxId(params.id)
  const sandboxIdStr = params.id!
  const sessionIdBytes = yield* parseSessionId(params.sessionId)
  const sessionIdStr = params.sessionId!

  // Verify sandbox exists and is running
  const sandbox = yield* sandboxRepo.findById(sandboxIdBytes, auth.orgId)
  if (!sandbox) {
    return yield* Effect.fail(new NotFoundError({ message: `Sandbox ${sandboxIdStr} not found` }))
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

  // Verify session exists and is running
  const session = yield* sessionRepo.findById(sessionIdBytes, sandboxIdBytes, auth.orgId)
  if (!session) {
    return yield* Effect.fail(new NotFoundError({ message: `Session ${sessionIdStr} not found` }))
  }
  if (session.status !== 'running') {
    return yield* Effect.fail(
      new ConflictError({ message: `Session ${sessionIdStr} is not running` }),
    )
  }

  const raw = yield* request.json.pipe(Effect.orElseSucceed(() => ({})))
  const body = raw && typeof raw === 'object' ? (raw as SessionInputRequest) : ({} as SessionInputRequest)

  if (!body.data || typeof body.data !== 'string') {
    return yield* Effect.fail(
      new ValidationError({ message: 'data is required and must be a string' }),
    )
  }

  yield* nodeClient.sessionInput({
    sandboxId: sandboxIdBytes,
    sessionId: sessionIdStr,
    data: body.data,
  })

  return HttpServerResponse.unsafeJson({ ok: true })
})

// -- Session stream (SSE) ----------------------------------------------------

const sessionStream = Effect.gen(function* () {
  yield* requireScope('session:read')
  const auth = yield* AuthContext
  const sandboxRepo = yield* SandboxRepo
  const sessionRepo = yield* SessionRepo
  const redis = yield* RedisService
  const request = yield* HttpServerRequest.HttpServerRequest
  const params = yield* HttpRouter.params

  const sandboxIdBytes = yield* parseSandboxId(params.id)
  const sandboxIdStr = params.id!
  const sessionIdBytes = yield* parseSessionId(params.sessionId)
  const sessionIdStr = params.sessionId!

  // Verify sandbox
  const sandbox = yield* sandboxRepo.findById(sandboxIdBytes, auth.orgId)
  if (!sandbox) {
    return yield* Effect.fail(new NotFoundError({ message: `Sandbox ${sandboxIdStr} not found` }))
  }

  // Verify session
  const session = yield* sessionRepo.findById(sessionIdBytes, sandboxIdBytes, auth.orgId)
  if (!session) {
    return yield* Effect.fail(new NotFoundError({ message: `Session ${sessionIdStr} not found` }))
  }

  // Parse Last-Event-ID header for reconnection
  const lastEventIdHeader = request.headers['last-event-id']
  const afterSeq = lastEventIdHeader ? parseInt(lastEventIdHeader, 10) : 0

  // Retrieve buffered events using the session ID as key
  const events = yield* redis.getExecEvents(sessionIdStr, isNaN(afterSeq) ? 0 : afterSeq)

  let sseBody = ''
  for (const event of events) {
    const data = event.data as ExecStreamEvent
    sseBody += `id: ${data.seq}\ndata: ${JSON.stringify(data)}\n\n`
  }

  return HttpServerResponse.text(sseBody, {
    contentType: 'text/event-stream',
    headers: {
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
})

// -- List sessions -----------------------------------------------------------

const listSessions = Effect.gen(function* () {
  yield* requireScope('session:read')
  const auth = yield* AuthContext
  const sandboxRepo = yield* SandboxRepo
  const sessionRepo = yield* SessionRepo
  const params = yield* HttpRouter.params

  const sandboxIdBytes = yield* parseSandboxId(params.id)
  const sandboxIdStr = params.id!

  // Verify sandbox exists
  const sandbox = yield* sandboxRepo.findById(sandboxIdBytes, auth.orgId)
  if (!sandbox) {
    return yield* Effect.fail(new NotFoundError({ message: `Sandbox ${sandboxIdStr} not found` }))
  }

  const rows = yield* sessionRepo.list(sandboxIdBytes, auth.orgId)

  const response: ListSessionsResponse = {
    sessions: rows.map(rowToSession),
    next_cursor: null,
  }
  return HttpServerResponse.unsafeJson(response)
})

// -- Destroy session ---------------------------------------------------------

const destroySession = Effect.gen(function* () {
  yield* requireScope('session:write')
  const auth = yield* AuthContext
  const sandboxRepo = yield* SandboxRepo
  const sessionRepo = yield* SessionRepo
  const nodeClient = yield* NodeClient
  const params = yield* HttpRouter.params

  const sandboxIdBytes = yield* parseSandboxId(params.id)
  const sandboxIdStr = params.id!
  const sessionIdBytes = yield* parseSessionId(params.sessionId)
  const sessionIdStr = params.sessionId!

  // Verify sandbox exists
  const sandbox = yield* sandboxRepo.findById(sandboxIdBytes, auth.orgId)
  if (!sandbox) {
    return yield* Effect.fail(new NotFoundError({ message: `Sandbox ${sandboxIdStr} not found` }))
  }

  // Verify session exists
  const session = yield* sessionRepo.findById(sessionIdBytes, sandboxIdBytes, auth.orgId)
  if (!session) {
    return yield* Effect.fail(new NotFoundError({ message: `Session ${sessionIdStr} not found` }))
  }

  // Route destroy to node
  yield* nodeClient.destroySession({
    sandboxId: sandboxIdBytes,
    sessionId: sessionIdStr,
  })

  // Update DB
  yield* sessionRepo.destroy(sessionIdBytes, sandboxIdBytes, auth.orgId)

  return HttpServerResponse.unsafeJson({ ok: true })
})

// -- Router ------------------------------------------------------------------

export const SessionRouter = HttpRouter.empty.pipe(
  HttpRouter.post('/v1/sandboxes/:id/sessions', createSession),
  HttpRouter.post('/v1/sandboxes/:id/sessions/:sessionId/exec', sessionExec),
  HttpRouter.post('/v1/sandboxes/:id/sessions/:sessionId/input', sessionInput),
  HttpRouter.get('/v1/sandboxes/:id/sessions/:sessionId/stream', sessionStream),
  HttpRouter.get('/v1/sandboxes/:id/sessions', listSessions),
  HttpRouter.del('/v1/sandboxes/:id/sessions/:sessionId', destroySession),
)
