import { HttpRouter, HttpServerRequest, HttpServerResponse } from '@effect/platform'
import { Effect } from 'effect'
import {
  generateUUIDv7,
  idToBytes,
  bytesToId,
  SANDBOX_PREFIX,
  EXEC_PREFIX,
  SESSION_PREFIX,
} from '@sandchest/contract'
import type {
  CreateSandboxRequest,
  CreateSandboxResponse,
  ForkSandboxRequest,
  ForkSandboxResponse,
  ForkTreeNode,
  GetForkTreeResponse,
  GetSandboxResponse,
  ListSandboxesResponse,
  SetReplayVisibilityRequest,
  SetReplayVisibilityResponse,
  StopSandboxResponse,
  ProfileName,
  SandboxStatus,
  SandboxSummary,
  ReplayBundle,
  ReplayForkTreeNode,
  ReplayExec,
  ReplaySession,
  ReplayEvent,
} from '@sandchest/contract'
import {
  ForkDepthExceededError,
  ForkLimitExceededError,
  GoneError,
  NotFoundError,
  QuotaExceededError,
  SandboxNotRunningError,
  ValidationError,
} from '../errors.js'
import { AuthContext } from '../context.js'
import { SandboxRepo } from '../services/sandbox-repo.js'
import { ExecRepo, type ExecRow } from '../services/exec-repo.js'
import { SessionRepo } from '../services/session-repo.js'
import { ObjectStorage } from '../services/object-storage.js'
import { NodeClient } from '../services/node-client.js'
import { ArtifactRepo } from '../services/artifact-repo.js'
import { RedisService } from '../services/redis.js'
import { QuotaService } from '../services/quota.js'
import { BillingService } from '../services/billing.js'
import { BillingLimitError } from '../errors.js'
import { requireScope } from '../scopes.js'
import { AuditLog } from '../services/audit-log.js'
import type { SandboxRow } from '../services/sandbox-repo.js'

const VALID_PROFILES: ProfileName[] = ['small', 'medium', 'large']
const VALID_STATUSES: SandboxStatus[] = [
  'queued',
  'provisioning',
  'running',
  'stopping',
  'stopped',
  'failed',
  'deleted',
]
const DEFAULT_IMAGE = 'ubuntu-22.04'
const DEFAULT_PROFILE: ProfileName = 'small'
const DEFAULT_TTL = 3600
const REPLAY_BASE_URL = 'https://sandchest.com/s'

function replayUrl(sandboxId: string): string {
  return `${REPLAY_BASE_URL}/${sandboxId}`
}

/** Tag a response with a header warning that the included replay URL is publicly accessible. */
function withReplayWarning(
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse {
  return response.pipe(HttpServerResponse.setHeader('x-replay-access', 'public'))
}

function rowToGetResponse(row: SandboxRow): GetSandboxResponse {
  const sandboxId = bytesToId(SANDBOX_PREFIX, row.id)
  return {
    sandbox_id: sandboxId,
    image: row.imageRef,
    profile: row.profileName,
    status: row.status,
    env: row.env ?? {},
    forked_from: row.forkedFrom ? bytesToId(SANDBOX_PREFIX, row.forkedFrom) : null,
    fork_count: row.forkCount,
    created_at: row.createdAt.toISOString(),
    started_at: row.startedAt?.toISOString() ?? null,
    ended_at: row.endedAt?.toISOString() ?? null,
    failure_reason: row.failureReason,
    replay_url: replayUrl(sandboxId),
    replay_public: row.replayPublic,
  }
}

function rowToSummary(row: SandboxRow): SandboxSummary {
  const sandboxId = bytesToId(SANDBOX_PREFIX, row.id)
  return {
    sandbox_id: sandboxId,
    status: row.status,
    image: row.imageRef,
    profile: row.profileName,
    forked_from: row.forkedFrom ? bytesToId(SANDBOX_PREFIX, row.forkedFrom) : null,
    created_at: row.createdAt.toISOString(),
    replay_url: replayUrl(sandboxId),
  }
}

// -- Create sandbox ----------------------------------------------------------

const createSandbox = Effect.gen(function* () {
  yield* requireScope('sandbox:create')
  const auth = yield* AuthContext
  const repo = yield* SandboxRepo
  const quotaService = yield* QuotaService
  const billing = yield* BillingService
  const nodeClient = yield* NodeClient
  const request = yield* HttpServerRequest.HttpServerRequest

  // Billing: check sandbox creation access
  const billingCheck = yield* billing.check(auth.userId, 'sandboxes')
  if (!billingCheck.allowed) {
    return yield* Effect.fail(
      new BillingLimitError({ message: 'Sandbox creation limit reached on your current plan' }),
    )
  }

  const raw = yield* request.json.pipe(Effect.orElseSucceed(() => ({})))
  const body: CreateSandboxRequest =
    raw && typeof raw === 'object' ? (raw as CreateSandboxRequest) : {}

  // Sandbox creation is always synchronous — reject wait=false
  if ('wait' in body && (body as Record<string, unknown>).wait === false) {
    return yield* Effect.fail(
      new ValidationError({
        message: 'wait=false is not supported for sandbox creation',
      }),
    )
  }

  const imageStr = body.image ?? DEFAULT_IMAGE
  const profileName = body.profile ?? DEFAULT_PROFILE
  const ttlSeconds = body.ttl_seconds ?? DEFAULT_TTL

  if (!VALID_PROFILES.includes(profileName)) {
    return yield* Effect.fail(
      new ValidationError({
        message: `Invalid profile: ${profileName}. Must be one of: ${VALID_PROFILES.join(', ')}`,
      }),
    )
  }

  const quota = yield* quotaService.getOrgQuota(auth.orgId)

  if (ttlSeconds < 1 || ttlSeconds > quota.maxTtlSeconds) {
    return yield* Effect.fail(
      new ValidationError({
        message: `ttl_seconds must be between 1 and ${quota.maxTtlSeconds}`,
      }),
    )
  }

  // Enforce concurrent sandbox limit
  const activeCount = yield* repo.countActive(auth.orgId)
  if (activeCount >= quota.maxConcurrentSandboxes) {
    return yield* Effect.fail(
      new QuotaExceededError({
        message: `Concurrent sandbox limit reached (max: ${quota.maxConcurrentSandboxes})`,
      }),
    )
  }

  const image = yield* repo.resolveImage(imageStr)
  if (!image) {
    return yield* Effect.fail(
      new ValidationError({ message: `Unknown image: ${imageStr}` }),
    )
  }

  const profile = yield* repo.resolveProfile(profileName)
  if (!profile) {
    return yield* Effect.fail(
      new ValidationError({ message: `Unknown profile: ${profileName}` }),
    )
  }

  const id = generateUUIDv7()
  const row = yield* repo.create({
    id,
    orgId: auth.orgId,
    imageId: image.id,
    profileId: profile.id,
    profileName,
    env: body.env ?? null,
    ttlSeconds,
    imageRef: image.ref,
  })

  // Tell the node daemon to create the VM
  yield* nodeClient.createSandbox({
    sandboxId: id,
    kernelRef: image.kernelRef,
    rootfsRef: image.rootfsRef,
    cpuCores: profile.cpuCores,
    memoryMb: profile.memoryMb,
    diskGb: profile.diskGb,
    env: body.env ?? {},
    ttlSeconds,
  })

  // Transition to running and assign to the node
  const assigned = yield* repo.assignNode(id, auth.orgId, nodeClient.nodeId)

  const sandboxId = bytesToId(SANDBOX_PREFIX, row.id)
  const response: CreateSandboxResponse = {
    sandbox_id: sandboxId,
    status: assigned?.status ?? row.status,
    queue_position: 0,
    estimated_ready_seconds: 0,
    replay_url: replayUrl(sandboxId),
    created_at: row.createdAt.toISOString(),
  }

  // Billing: track sandbox creation (fire-and-forget)
  yield* billing.track(auth.userId, 'sandboxes')

  const auditLog = yield* AuditLog
  yield* auditLog.append({
    orgId: auth.orgId,
    actorId: auth.userId,
    action: 'sandbox.create',
    resourceType: 'sandbox',
    resourceId: sandboxId,
    metadata: { image: imageStr, profile: profileName, ttl_seconds: ttlSeconds },
  })

  return withReplayWarning(HttpServerResponse.unsafeJson(response, { status: 201 }))
})

// -- List sandboxes ----------------------------------------------------------

const listSandboxes = Effect.gen(function* () {
  yield* requireScope('sandbox:read')
  const auth = yield* AuthContext
  const repo = yield* SandboxRepo
  const request = yield* HttpServerRequest.HttpServerRequest

  const url = new URL(request.url, 'http://localhost')
  const status = url.searchParams.get('status') as SandboxStatus | null
  const forkedFrom = url.searchParams.get('forked_from')
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

  const result = yield* repo.list(auth.orgId, {
    status: status ?? undefined,
    forked_from: forkedFrom ?? undefined,
    cursor: cursor ?? undefined,
    limit,
  })

  const response: ListSandboxesResponse = {
    sandboxes: result.rows.map(rowToSummary),
    next_cursor: result.nextCursor,
  }

  return withReplayWarning(HttpServerResponse.unsafeJson(response))
})

// -- Get sandbox -------------------------------------------------------------

const getSandbox = Effect.gen(function* () {
  yield* requireScope('sandbox:read')
  const auth = yield* AuthContext
  const repo = yield* SandboxRepo
  const params = yield* HttpRouter.params

  const id = params.id
  if (!id) {
    return yield* Effect.fail(new ValidationError({ message: 'Missing sandbox ID' }))
  }

  let idBytes: Uint8Array
  try {
    idBytes = idToBytes(id)
  } catch {
    return yield* Effect.fail(new ValidationError({ message: `Invalid sandbox ID: ${id}` }))
  }

  const row = yield* repo.findById(idBytes, auth.orgId)
  if (!row) {
    return yield* Effect.fail(new NotFoundError({ message: `Sandbox ${id} not found` }))
  }

  return withReplayWarning(HttpServerResponse.unsafeJson(rowToGetResponse(row)))
})

// -- Stop sandbox ------------------------------------------------------------

/** Collect registered artifacts before shutdown. Non-blocking: logs warning on failure. */
const collectArtifactsOnStop = (
  sandboxId: string,
  idBytes: Uint8Array,
  orgId: string,
) =>
  Effect.gen(function* () {
    const redis = yield* RedisService
    const nodeClient = yield* NodeClient
    const artifactRepo = yield* ArtifactRepo

    const paths = yield* redis.getArtifactPaths(sandboxId)
    if (paths.length === 0) return

    const collected = yield* nodeClient.collectArtifacts({
      sandboxId: idBytes,
      paths,
    })

    for (const artifact of collected) {
      const artifactId = generateUUIDv7()
      yield* artifactRepo.create({
        id: artifactId,
        sandboxId: idBytes,
        orgId,
        name: artifact.name,
        mime: artifact.mime,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
        ref: artifact.ref,
      })
    }
  }).pipe(
    Effect.catchAll(() => Effect.void),
  )

const stopSandbox = Effect.gen(function* () {
  yield* requireScope('sandbox:write')
  const auth = yield* AuthContext
  const repo = yield* SandboxRepo
  const params = yield* HttpRouter.params

  const id = params.id
  if (!id) {
    return yield* Effect.fail(new ValidationError({ message: 'Missing sandbox ID' }))
  }

  let idBytes: Uint8Array
  try {
    idBytes = idToBytes(id)
  } catch {
    return yield* Effect.fail(new ValidationError({ message: `Invalid sandbox ID: ${id}` }))
  }

  const row = yield* repo.findById(idBytes, auth.orgId)
  if (!row) {
    return yield* Effect.fail(new NotFoundError({ message: `Sandbox ${id} not found` }))
  }

  // Idempotent: already stopped/failed → return current status
  if (row.status === 'stopped' || row.status === 'failed' || row.status === 'deleted') {
    const response: StopSandboxResponse = {
      sandbox_id: id,
      status: row.status,
    }
    return HttpServerResponse.unsafeJson(response)
  }

  // Already stopping → return 202
  if (row.status === 'stopping') {
    const response: StopSandboxResponse = {
      sandbox_id: id,
      status: 'stopping',
    }
    return HttpServerResponse.unsafeJson(response, { status: 202 })
  }

  // Transition to stopping
  yield* repo.updateStatus(idBytes, auth.orgId, 'stopping', {
    failureReason: 'sandbox_stopped',
  })

  // Collect artifacts before fully stopping (best-effort)
  yield* collectArtifactsOnStop(id, idBytes, auth.orgId)

  // Tell the node daemon to stop the VM (best-effort)
  const nodeClient = yield* NodeClient
  yield* nodeClient.stopSandbox({ sandboxId: idBytes }).pipe(
    Effect.catchAll(() => Effect.void),
  )

  // Transition to stopped
  const stopped = yield* repo.updateStatus(idBytes, auth.orgId, 'stopped', {
    endedAt: new Date(),
  })

  const auditLog = yield* AuditLog
  yield* auditLog.append({
    orgId: auth.orgId,
    actorId: auth.userId,
    action: 'sandbox.stop',
    resourceType: 'sandbox',
    resourceId: id,
  })

  const response: StopSandboxResponse = {
    sandbox_id: id,
    status: stopped?.status ?? 'stopped',
  }

  return HttpServerResponse.unsafeJson(response, { status: 202 })
})

// -- Delete sandbox ----------------------------------------------------------

const deleteSandbox = Effect.gen(function* () {
  yield* requireScope('sandbox:write')
  const auth = yield* AuthContext
  const repo = yield* SandboxRepo
  const params = yield* HttpRouter.params

  const id = params.id
  if (!id) {
    return yield* Effect.fail(new ValidationError({ message: 'Missing sandbox ID' }))
  }

  let idBytes: Uint8Array
  try {
    idBytes = idToBytes(id)
  } catch {
    return yield* Effect.fail(new ValidationError({ message: `Invalid sandbox ID: ${id}` }))
  }

  const row = yield* repo.findById(idBytes, auth.orgId)
  if (!row) {
    return yield* Effect.fail(new NotFoundError({ message: `Sandbox ${id} not found` }))
  }

  // Idempotent: already deleted → return 200
  if (row.status === 'deleted') {
    return HttpServerResponse.unsafeJson(
      { sandbox_id: id, status: 'deleted' },
    )
  }

  // Destroy the VM on the node if it's still active (best-effort)
  const isActive = row.status === 'running' || row.status === 'stopping' || row.status === 'queued' || row.status === 'provisioning'
  if (isActive) {
    const nodeClient = yield* NodeClient
    yield* nodeClient.destroySandbox({ sandboxId: idBytes }).pipe(
      Effect.catchAll(() => Effect.void),
    )
  }

  const updated = yield* repo.softDelete(idBytes, auth.orgId)

  const auditLog = yield* AuditLog
  yield* auditLog.append({
    orgId: auth.orgId,
    actorId: auth.userId,
    action: 'sandbox.delete',
    resourceType: 'sandbox',
    resourceId: id,
  })

  return HttpServerResponse.unsafeJson(
    { sandbox_id: id, status: updated?.status ?? 'deleted' },
  )
})

// -- Fork sandbox ------------------------------------------------------------

const DEFAULT_FORK_TTL = 3600

const forkSandbox = Effect.gen(function* () {
  yield* requireScope('sandbox:create')
  const auth = yield* AuthContext
  const repo = yield* SandboxRepo
  const quotaService = yield* QuotaService
  const billing = yield* BillingService
  const nodeClient = yield* NodeClient
  const request = yield* HttpServerRequest.HttpServerRequest
  const params = yield* HttpRouter.params

  // Billing: check sandbox creation access (forks count as sandbox creation)
  const billingCheck = yield* billing.check(auth.userId, 'sandboxes')
  if (!billingCheck.allowed) {
    return yield* Effect.fail(
      new BillingLimitError({ message: 'Sandbox creation limit reached on your current plan' }),
    )
  }

  const id = params.id
  if (!id) {
    return yield* Effect.fail(new ValidationError({ message: 'Missing sandbox ID' }))
  }

  let sourceIdBytes: Uint8Array
  try {
    sourceIdBytes = idToBytes(id)
  } catch {
    return yield* Effect.fail(new ValidationError({ message: `Invalid sandbox ID: ${id}` }))
  }

  const source = yield* repo.findById(sourceIdBytes, auth.orgId)
  if (!source) {
    return yield* Effect.fail(new NotFoundError({ message: `Sandbox ${id} not found` }))
  }

  if (source.status !== 'running') {
    return yield* Effect.fail(
      new SandboxNotRunningError({
        message: `Sandbox ${id} is not running (current: ${source.status})`,
      }),
    )
  }

  const quota = yield* quotaService.getOrgQuota(auth.orgId)

  if (source.forkDepth + 1 > quota.maxForkDepth) {
    return yield* Effect.fail(
      new ForkDepthExceededError({
        message: `Fork depth limit exceeded (max: ${quota.maxForkDepth})`,
      }),
    )
  }

  if (source.forkCount >= quota.maxForksPerSandbox) {
    return yield* Effect.fail(
      new ForkLimitExceededError({
        message: `Fork limit exceeded for sandbox ${id} (max: ${quota.maxForksPerSandbox})`,
      }),
    )
  }

  // Enforce concurrent sandbox limit for fork creation
  const activeCount = yield* repo.countActive(auth.orgId)
  if (activeCount >= quota.maxConcurrentSandboxes) {
    return yield* Effect.fail(
      new QuotaExceededError({
        message: `Concurrent sandbox limit reached (max: ${quota.maxConcurrentSandboxes})`,
      }),
    )
  }

  const raw = yield* request.json.pipe(Effect.orElseSucceed(() => ({})))
  const body: ForkSandboxRequest =
    raw && typeof raw === 'object' ? (raw as ForkSandboxRequest) : {}

  const ttlSeconds = body.ttl_seconds ?? DEFAULT_FORK_TTL

  if (ttlSeconds < 1 || ttlSeconds > quota.maxTtlSeconds) {
    return yield* Effect.fail(
      new ValidationError({ message: `ttl_seconds must be between 1 and ${quota.maxTtlSeconds}` }),
    )
  }

  // Merge env: source env + request env overrides
  const mergedEnv =
    body.env || source.env
      ? { ...(source.env ?? {}), ...(body.env ?? {}) }
      : null

  const forkId = generateUUIDv7()

  // Create fork row in DB
  const forkRow = yield* repo.createFork({
    id: forkId,
    orgId: auth.orgId,
    source,
    env: mergedEnv,
    ttlSeconds,
  })

  // Increment parent's fork count
  yield* repo.incrementForkCount(sourceIdBytes, auth.orgId)

  // Tell the node to fork the VM
  yield* nodeClient.forkSandbox({
    sourceSandboxId: sourceIdBytes,
    newSandboxId: forkId,
  })

  const sandboxId = bytesToId(SANDBOX_PREFIX, forkRow.id)
  const response: ForkSandboxResponse = {
    sandbox_id: sandboxId,
    forked_from: id,
    status: forkRow.status,
    replay_url: replayUrl(sandboxId),
    created_at: forkRow.createdAt.toISOString(),
  }

  // Billing: track fork as sandbox creation (fire-and-forget)
  yield* billing.track(auth.userId, 'sandboxes')

  const auditLog = yield* AuditLog
  yield* auditLog.append({
    orgId: auth.orgId,
    actorId: auth.userId,
    action: 'sandbox.fork',
    resourceType: 'sandbox',
    resourceId: sandboxId,
    metadata: { forked_from: id, ttl_seconds: ttlSeconds },
  })

  return withReplayWarning(HttpServerResponse.unsafeJson(response, { status: 201 }))
})

// -- Get fork tree -----------------------------------------------------------

const getForkTree = Effect.gen(function* () {
  yield* requireScope('sandbox:read')
  const auth = yield* AuthContext
  const repo = yield* SandboxRepo
  const params = yield* HttpRouter.params

  const id = params.id
  if (!id) {
    return yield* Effect.fail(new ValidationError({ message: 'Missing sandbox ID' }))
  }

  let idBytes: Uint8Array
  try {
    idBytes = idToBytes(id)
  } catch {
    return yield* Effect.fail(new ValidationError({ message: `Invalid sandbox ID: ${id}` }))
  }

  const row = yield* repo.findById(idBytes, auth.orgId)
  if (!row) {
    return yield* Effect.fail(new NotFoundError({ message: `Sandbox ${id} not found` }))
  }

  const treeRows = yield* repo.getForkTree(idBytes, auth.orgId)

  // Build a map of children per sandbox
  const childrenMap = new Map<string, string[]>()
  let rootId = ''

  for (const r of treeRows) {
    const sid = bytesToId(SANDBOX_PREFIX, r.id)
    if (!childrenMap.has(sid)) {
      childrenMap.set(sid, [])
    }
    if (r.forkedFrom) {
      const parentId = bytesToId(SANDBOX_PREFIX, r.forkedFrom)
      if (!childrenMap.has(parentId)) {
        childrenMap.set(parentId, [])
      }
      childrenMap.get(parentId)!.push(sid)
    } else {
      rootId = sid
    }
  }

  const tree: ForkTreeNode[] = treeRows.map((r) => {
    const sid = bytesToId(SANDBOX_PREFIX, r.id)
    return {
      sandbox_id: sid,
      status: r.status,
      forked_from: r.forkedFrom ? bytesToId(SANDBOX_PREFIX, r.forkedFrom) : null,
      forked_at: r.forkedFrom ? r.createdAt.toISOString() : null,
      children: childrenMap.get(sid) ?? [],
    }
  })

  const response: GetForkTreeResponse = {
    root: rootId,
    tree,
  }

  return HttpServerResponse.unsafeJson(response)
})

// -- Get replay --------------------------------------------------------------

const EVENTS_PRESIGN_TTL_SECONDS = 86400

function execRowToReplayExec(row: ExecRow): ReplayExec {
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
    exec_id: bytesToId(EXEC_PREFIX, row.id),
    session_id: row.sessionId ? bytesToId(SESSION_PREFIX, row.sessionId) : null,
    cmd,
    cwd: row.cwd ?? '/root',
    exit_code: row.exitCode,
    duration_ms: row.durationMs,
    started_at: row.startedAt?.toISOString() ?? row.createdAt.toISOString(),
    ended_at: row.endedAt?.toISOString() ?? null,
    resource_usage:
      row.cpuMs != null && row.peakMemoryBytes != null
        ? { cpu_ms: row.cpuMs, peak_memory_bytes: row.peakMemoryBytes }
        : null,
    output_ref: row.logRef ?? '',
  }
}

function buildReplayForkTree(
  rootId: Uint8Array,
  treeRows: SandboxRow[],
): ReplayForkTreeNode {
  const childrenMap = new Map<string, SandboxRow[]>()

  for (const r of treeRows) {
    if (r.forkedFrom) {
      const parentKey = bytesToId(SANDBOX_PREFIX, r.forkedFrom)
      const children = childrenMap.get(parentKey) ?? []
      children.push(r)
      childrenMap.set(parentKey, children)
    }
  }

  function build(row: SandboxRow): ReplayForkTreeNode {
    const sid = bytesToId(SANDBOX_PREFIX, row.id)
    const children = childrenMap.get(sid) ?? []
    return {
      sandbox_id: sid,
      forked_at: row.forkedFrom ? row.createdAt.toISOString() : undefined,
      children: children.map(build),
    }
  }

  const root = treeRows.find((r) => bytesEqual(r.id, rootId))
  if (!root) {
    return { sandbox_id: bytesToId(SANDBOX_PREFIX, rootId), children: [] }
  }
  return build(root)
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

const getReplay = Effect.gen(function* () {
  yield* requireScope('sandbox:read')
  const auth = yield* AuthContext
  const sandboxRepo = yield* SandboxRepo
  const execRepo = yield* ExecRepo
  const sessionRepo = yield* SessionRepo
  const objectStorage = yield* ObjectStorage
  const params = yield* HttpRouter.params

  const id = params.id
  if (!id) {
    return yield* Effect.fail(new ValidationError({ message: 'Missing sandbox ID' }))
  }

  let idBytes: Uint8Array
  try {
    idBytes = idToBytes(id)
  } catch {
    return yield* Effect.fail(new ValidationError({ message: `Invalid sandbox ID: ${id}` }))
  }

  const row = yield* sandboxRepo.findById(idBytes, auth.orgId)
  if (!row) {
    return yield* Effect.fail(new NotFoundError({ message: `Sandbox ${id} not found` }))
  }

  if (row.replayExpiresAt && row.replayExpiresAt.getTime() <= Date.now()) {
    return yield* Effect.fail(new GoneError({ message: `Replay for sandbox ${id} has expired` }))
  }

  // Fetch fork tree
  const treeRows = yield* sandboxRepo.getForkTree(idBytes, auth.orgId)

  // Find the root of the fork tree
  let rootRow = row
  for (const r of treeRows) {
    if (!r.forkedFrom) {
      rootRow = r
      break
    }
  }

  const forkTree = buildReplayForkTree(rootRow.id, treeRows)

  // Fetch execs
  const execResult = yield* execRepo.list(idBytes, auth.orgId, {})
  const replayExecs: ReplayExec[] = execResult.rows.map(execRowToReplayExec)

  // Fetch sessions
  const sessionRows = yield* sessionRepo.list(idBytes, auth.orgId)
  const replaySessions: ReplaySession[] = sessionRows.map((s) => ({
    session_id: bytesToId(SESSION_PREFIX, s.id),
    shell: s.shell,
    created_at: s.createdAt.toISOString(),
    destroyed_at: s.destroyedAt?.toISOString() ?? null,
  }))

  // Generate presigned events URL
  const eventsKey = `${auth.orgId}/${id}/events.jsonl`
  const eventsUrl = yield* objectStorage.getPresignedUrl(eventsKey, EVENTS_PRESIGN_TTL_SECONDS)

  // Determine replay status
  const isRunning = row.status === 'running' || row.status === 'queued' || row.status === 'provisioning'
  const status = isRunning ? 'in_progress' : 'complete'

  // Calculate total duration
  const totalDurationMs =
    row.endedAt && row.createdAt
      ? row.endedAt.getTime() - row.createdAt.getTime()
      : null

  const response: ReplayBundle = {
    version: 1,
    sandbox_id: id,
    status,
    image: row.imageRef,
    profile: row.profileName,
    forked_from: row.forkedFrom ? bytesToId(SANDBOX_PREFIX, row.forkedFrom) : null,
    fork_tree: forkTree,
    started_at: row.createdAt.toISOString(),
    ended_at: row.endedAt?.toISOString() ?? null,
    total_duration_ms: totalDurationMs,
    sessions: replaySessions,
    execs: replayExecs,
    artifacts: [],
    events_url: eventsUrl,
  }

  return withReplayWarning(HttpServerResponse.unsafeJson(response))
})

// -- Set replay visibility ---------------------------------------------------

const setReplayVisibility = Effect.gen(function* () {
  yield* requireScope('sandbox:write')
  const auth = yield* AuthContext
  const repo = yield* SandboxRepo
  const request = yield* HttpServerRequest.HttpServerRequest
  const params = yield* HttpRouter.params

  const id = params.id
  if (!id) {
    return yield* Effect.fail(new ValidationError({ message: 'Missing sandbox ID' }))
  }

  let idBytes: Uint8Array
  try {
    idBytes = idToBytes(id)
  } catch {
    return yield* Effect.fail(new ValidationError({ message: `Invalid sandbox ID: ${id}` }))
  }

  const raw = yield* request.json.pipe(Effect.orElseSucceed(() => ({})))
  const body: SetReplayVisibilityRequest =
    raw && typeof raw === 'object' ? (raw as SetReplayVisibilityRequest) : { public: false }

  if (typeof body.public !== 'boolean') {
    return yield* Effect.fail(
      new ValidationError({ message: '"public" must be a boolean' }),
    )
  }

  const updated = yield* repo.setReplayPublic(idBytes, auth.orgId, body.public)
  if (!updated) {
    return yield* Effect.fail(new NotFoundError({ message: `Sandbox ${id} not found` }))
  }

  const auditLog = yield* AuditLog
  yield* auditLog.append({
    orgId: auth.orgId,
    actorId: auth.userId,
    action: 'sandbox.replay_visibility',
    resourceType: 'sandbox',
    resourceId: id,
    metadata: { public: updated.replayPublic },
  })

  const response: SetReplayVisibilityResponse = {
    sandbox_id: id,
    replay_public: updated.replayPublic,
  }

  return HttpServerResponse.unsafeJson(response)
})

// -- Get public replay -------------------------------------------------------

const getPublicReplay = Effect.gen(function* () {
  const sandboxRepo = yield* SandboxRepo
  const execRepo = yield* ExecRepo
  const sessionRepo = yield* SessionRepo
  const objectStorage = yield* ObjectStorage
  const params = yield* HttpRouter.params

  const id = params.id
  if (!id) {
    return yield* Effect.fail(new ValidationError({ message: 'Missing sandbox ID' }))
  }

  let idBytes: Uint8Array
  try {
    idBytes = idToBytes(id)
  } catch {
    return yield* Effect.fail(new ValidationError({ message: `Invalid sandbox ID: ${id}` }))
  }

  const row = yield* sandboxRepo.findByIdPublic(idBytes)
  if (!row) {
    return yield* Effect.fail(new NotFoundError({ message: 'Replay not found or is private' }))
  }

  if (row.replayExpiresAt && row.replayExpiresAt.getTime() <= Date.now()) {
    return yield* Effect.fail(new GoneError({ message: 'Replay has expired' }))
  }

  // Fetch fork tree using the sandbox's orgId
  const treeRows = yield* sandboxRepo.getForkTree(idBytes, row.orgId)

  let rootRow = row
  for (const r of treeRows) {
    if (!r.forkedFrom) {
      rootRow = r
      break
    }
  }

  const forkTree = buildReplayForkTree(rootRow.id, treeRows)

  // Fetch execs
  const execResult = yield* execRepo.list(idBytes, row.orgId, {})
  const replayExecs: ReplayExec[] = execResult.rows.map(execRowToReplayExec)

  // Fetch sessions
  const sessionRows = yield* sessionRepo.list(idBytes, row.orgId)
  const replaySessions: ReplaySession[] = sessionRows.map((s) => ({
    session_id: bytesToId(SESSION_PREFIX, s.id),
    shell: s.shell,
    created_at: s.createdAt.toISOString(),
    destroyed_at: s.destroyedAt?.toISOString() ?? null,
  }))

  // Generate presigned events URL
  const eventsKey = `${row.orgId}/${id}/events.jsonl`
  const eventsUrl = yield* objectStorage.getPresignedUrl(eventsKey, EVENTS_PRESIGN_TTL_SECONDS)

  const isRunning = row.status === 'running' || row.status === 'queued' || row.status === 'provisioning'
  const status = isRunning ? 'in_progress' : 'complete'

  const totalDurationMs =
    row.endedAt && row.createdAt
      ? row.endedAt.getTime() - row.createdAt.getTime()
      : null

  const response: ReplayBundle = {
    version: 1,
    sandbox_id: id,
    status,
    image: row.imageRef,
    profile: row.profileName,
    forked_from: row.forkedFrom ? bytesToId(SANDBOX_PREFIX, row.forkedFrom) : null,
    fork_tree: forkTree,
    started_at: row.createdAt.toISOString(),
    ended_at: row.endedAt?.toISOString() ?? null,
    total_duration_ms: totalDurationMs,
    sessions: replaySessions,
    execs: replayExecs,
    artifacts: [],
    events_url: eventsUrl,
  }

  return HttpServerResponse.unsafeJson(response)
})

// -- Stream sandbox events (SSE) ---------------------------------------------

const streamSandbox = Effect.gen(function* () {
  yield* requireScope('sandbox:read')
  const auth = yield* AuthContext
  const sandboxRepo = yield* SandboxRepo
  const redis = yield* RedisService
  const request = yield* HttpServerRequest.HttpServerRequest
  const params = yield* HttpRouter.params

  const id = params.id
  if (!id) {
    return yield* Effect.fail(new ValidationError({ message: 'Missing sandbox ID' }))
  }

  let idBytes: Uint8Array
  try {
    idBytes = idToBytes(id)
  } catch {
    return yield* Effect.fail(new ValidationError({ message: `Invalid sandbox ID: ${id}` }))
  }

  const row = yield* sandboxRepo.findById(idBytes, auth.orgId)
  if (!row) {
    return yield* Effect.fail(new NotFoundError({ message: `Sandbox ${id} not found` }))
  }

  // Parse Last-Event-ID header for reconnection
  const lastEventIdHeader = request.headers['last-event-id']
  const afterSeq = lastEventIdHeader ? parseInt(lastEventIdHeader, 10) : 0

  // Get buffered replay events from Redis
  const events = yield* redis.getReplayEvents(id, isNaN(afterSeq) ? 0 : afterSeq)

  // Format as SSE
  let sseBody = ''
  for (const event of events) {
    const data = event.data as ReplayEvent
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

// -- Router ------------------------------------------------------------------

export const SandboxRouter = HttpRouter.empty.pipe(
  HttpRouter.post('/v1/sandboxes', createSandbox),
  HttpRouter.get('/v1/sandboxes', listSandboxes),
  HttpRouter.get('/v1/sandboxes/:id', getSandbox),
  HttpRouter.post('/v1/sandboxes/:id/fork', forkSandbox),
  HttpRouter.get('/v1/sandboxes/:id/forks', getForkTree),
  HttpRouter.post('/v1/sandboxes/:id/stop', stopSandbox),
  HttpRouter.del('/v1/sandboxes/:id', deleteSandbox),
  HttpRouter.get('/v1/sandboxes/:id/replay', getReplay),
  HttpRouter.get('/v1/sandboxes/:id/stream', streamSandbox),
  HttpRouter.patch('/v1/sandboxes/:id/replay', setReplayVisibility),
  HttpRouter.get('/v1/public/replay/:id', getPublicReplay),
)
