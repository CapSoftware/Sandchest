import { HttpRouter, HttpServerRequest, HttpServerResponse } from '@effect/platform'
import { Effect } from 'effect'
import {
  idToBytes,
  bytesToId,
  ARTIFACT_PREFIX,
} from '@sandchest/contract'
import type {
  RegisterArtifactsRequest,
  RegisterArtifactsResponse,
  ListArtifactsResponse,
  Artifact,
} from '@sandchest/contract'
import { NotFoundError, ValidationError } from '../errors.js'
import { AuthContext } from '../context.js'
import { requireScope } from '../scopes.js'
import { SandboxRepo } from '../services/sandbox-repo.js'
import { ArtifactRepo } from '../services/artifact-repo.js'
import { RedisService } from '../services/redis.js'
import { ObjectStorage } from '../services/object-storage.js'
import type { ArtifactRow } from '../services/artifact-repo.js'

const MAX_PATHS_PER_REQUEST = 100
const MAX_TOTAL_PATHS = 500
const DOWNLOAD_URL_TTL_SECONDS = 3600

// -- Register artifact paths -------------------------------------------------

const registerArtifacts = Effect.gen(function* () {
  yield* requireScope('artifact:write')
  const auth = yield* AuthContext
  const sandboxRepo = yield* SandboxRepo
  const redis = yield* RedisService
  const params = yield* HttpRouter.params
  const request = yield* HttpServerRequest.HttpServerRequest

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

  const raw = yield* request.json.pipe(Effect.orElseSucceed(() => ({})))
  const body: RegisterArtifactsRequest =
    raw && typeof raw === 'object' && 'paths' in (raw as Record<string, unknown>)
      ? (raw as RegisterArtifactsRequest)
      : { paths: [] }

  if (!Array.isArray(body.paths)) {
    return yield* Effect.fail(
      new ValidationError({ message: 'paths must be an array of strings' }),
    )
  }

  if (body.paths.length === 0) {
    return yield* Effect.fail(
      new ValidationError({ message: 'paths must not be empty' }),
    )
  }

  if (body.paths.length > MAX_PATHS_PER_REQUEST) {
    return yield* Effect.fail(
      new ValidationError({
        message: `Too many paths: ${body.paths.length} (max ${MAX_PATHS_PER_REQUEST} per request)`,
      }),
    )
  }

  for (const p of body.paths) {
    if (typeof p !== 'string' || p.length === 0) {
      return yield* Effect.fail(
        new ValidationError({ message: 'Each path must be a non-empty string' }),
      )
    }
  }

  // Check total limit
  const currentCount = yield* redis.countArtifactPaths(id)
  if (currentCount + body.paths.length > MAX_TOTAL_PATHS) {
    return yield* Effect.fail(
      new ValidationError({
        message: `Total artifact paths would exceed limit: ${currentCount} existing + ${body.paths.length} new > ${MAX_TOTAL_PATHS} max`,
      }),
    )
  }

  const added = yield* redis.addArtifactPaths(id, body.paths)
  const total = currentCount + added

  const response: RegisterArtifactsResponse = {
    registered: added,
    total,
  }

  return HttpServerResponse.unsafeJson(response)
})

// -- List artifacts ----------------------------------------------------------

function rowToArtifact(row: ArtifactRow, downloadUrl: string): Artifact {
  return {
    id: bytesToId(ARTIFACT_PREFIX, row.id),
    name: row.name,
    mime: row.mime,
    bytes: row.bytes,
    sha256: row.sha256,
    download_url: downloadUrl,
    exec_id: row.execId ? bytesToId('ex_', row.execId) : null,
    created_at: row.createdAt.toISOString(),
  }
}

const listArtifacts = Effect.gen(function* () {
  yield* requireScope('artifact:read')
  const auth = yield* AuthContext
  const sandboxRepo = yield* SandboxRepo
  const artifactRepo = yield* ArtifactRepo
  const objectStorage = yield* ObjectStorage
  const params = yield* HttpRouter.params
  const request = yield* HttpServerRequest.HttpServerRequest

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

  const url = new URL(request.url, 'http://localhost')
  const cursor = url.searchParams.get('cursor')
  const limitStr = url.searchParams.get('limit')
  const limit = limitStr ? parseInt(limitStr, 10) : undefined

  if (limit !== undefined && (isNaN(limit) || limit < 1 || limit > 200)) {
    return yield* Effect.fail(
      new ValidationError({ message: 'limit must be between 1 and 200' }),
    )
  }

  const result = yield* artifactRepo.list(idBytes, auth.orgId, {
    cursor: cursor ?? undefined,
    limit,
  })

  const artifacts: Artifact[] = []
  for (const artifactRow of result.rows) {
    const downloadUrl = yield* objectStorage.getPresignedUrl(
      artifactRow.ref,
      DOWNLOAD_URL_TTL_SECONDS,
    )
    artifacts.push(rowToArtifact(artifactRow, downloadUrl))
  }

  const response: ListArtifactsResponse = {
    artifacts,
    next_cursor: result.nextCursor,
  }

  return HttpServerResponse.unsafeJson(response)
})

// -- Router ------------------------------------------------------------------

export const ArtifactRouter = HttpRouter.empty.pipe(
  HttpRouter.post('/v1/sandboxes/:id/artifacts', registerArtifacts),
  HttpRouter.get('/v1/sandboxes/:id/artifacts', listArtifacts),
)
