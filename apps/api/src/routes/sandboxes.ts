import { HttpRouter, HttpServerRequest, HttpServerResponse } from '@effect/platform'
import { Effect } from 'effect'
import {
  generateUUIDv7,
  idToBytes,
  bytesToId,
  SANDBOX_PREFIX,
} from '@sandchest/contract'
import type {
  CreateSandboxRequest,
  CreateSandboxResponse,
  GetSandboxResponse,
  ListSandboxesResponse,
  StopSandboxResponse,
  ProfileName,
  SandboxStatus,
  SandboxSummary,
} from '@sandchest/contract'
import { NotFoundError, NotImplementedError, ValidationError } from '../errors.js'
import { AuthContext } from '../context.js'
import { SandboxRepo } from '../services/sandbox-repo.js'
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

const stub = (name: string) =>
  Effect.fail(new NotImplementedError({ message: `${name} not yet implemented` }))

// -- Create sandbox ----------------------------------------------------------

const createSandbox = Effect.gen(function* () {
  const auth = yield* AuthContext
  const repo = yield* SandboxRepo
  const request = yield* HttpServerRequest.HttpServerRequest

  const raw = yield* request.json.pipe(Effect.orElseSucceed(() => ({})))
  const body: CreateSandboxRequest =
    raw && typeof raw === 'object' ? (raw as CreateSandboxRequest) : {}

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

  if (ttlSeconds < 1 || ttlSeconds > 86400) {
    return yield* Effect.fail(
      new ValidationError({
        message: 'ttl_seconds must be between 1 and 86400',
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

  const sandboxId = bytesToId(SANDBOX_PREFIX, row.id)
  const response: CreateSandboxResponse = {
    sandbox_id: sandboxId,
    status: row.status,
    queue_position: 0,
    estimated_ready_seconds: 2,
    replay_url: replayUrl(sandboxId),
    created_at: row.createdAt.toISOString(),
  }

  return HttpServerResponse.unsafeJson(response, { status: 201 })
})

// -- List sandboxes ----------------------------------------------------------

const listSandboxes = Effect.gen(function* () {
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

  return HttpServerResponse.unsafeJson(response)
})

// -- Get sandbox -------------------------------------------------------------

const getSandbox = Effect.gen(function* () {
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

  return HttpServerResponse.unsafeJson(rowToGetResponse(row))
})

// -- Stop sandbox ------------------------------------------------------------

const stopSandbox = Effect.gen(function* () {
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
  const updated = yield* repo.updateStatus(idBytes, auth.orgId, 'stopping', {
    failureReason: 'sandbox_stopped',
  })

  const response: StopSandboxResponse = {
    sandbox_id: id,
    status: updated?.status ?? 'stopping',
  }

  return HttpServerResponse.unsafeJson(response, { status: 202 })
})

// -- Delete sandbox ----------------------------------------------------------

const deleteSandbox = Effect.gen(function* () {
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

  const updated = yield* repo.softDelete(idBytes, auth.orgId)

  return HttpServerResponse.unsafeJson(
    { sandbox_id: id, status: updated?.status ?? 'deleted' },
  )
})

// -- Router ------------------------------------------------------------------

export const SandboxRouter = HttpRouter.empty.pipe(
  HttpRouter.post('/v1/sandboxes', createSandbox),
  HttpRouter.get('/v1/sandboxes', listSandboxes),
  HttpRouter.get('/v1/sandboxes/:id', getSandbox),
  HttpRouter.post('/v1/sandboxes/:id/fork', stub('Fork sandbox')),
  HttpRouter.get('/v1/sandboxes/:id/forks', stub('Get fork tree')),
  HttpRouter.post('/v1/sandboxes/:id/stop', stopSandbox),
  HttpRouter.del('/v1/sandboxes/:id', deleteSandbox),
  HttpRouter.get('/v1/sandboxes/:id/replay', stub('Get replay')),
)
