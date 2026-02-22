import { HttpRouter, HttpServerRequest, HttpServerResponse } from '@effect/platform'
import { Effect } from 'effect'
import { idToBytes } from '@sandchest/contract'
import type { FileEntry, ListFilesResponse } from '@sandchest/contract'
import {
  NotFoundError,
  SandboxNotRunningError,
  ValidationError,
} from '../errors.js'
import { AuthContext } from '../context.js'
import { requireScope } from '../scopes.js'
import { SandboxRepo } from '../services/sandbox-repo.js'
import { NodeClient } from '../services/node-client.js'

const MAX_SINGLE_FILE = 5 * 1024 * 1024 * 1024 // 5 GB
const MAX_BATCH_FILE = 10 * 1024 * 1024 * 1024 // 10 GB
const DEFAULT_LIST_LIMIT = 200

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

// -- Upload file -------------------------------------------------------------

const uploadFile = Effect.gen(function* () {
  yield* requireScope('file:write')
  const auth = yield* AuthContext
  const sandboxRepo = yield* SandboxRepo
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

  const url = new URL(request.url, 'http://localhost')
  const path = url.searchParams.get('path')
  const batch = url.searchParams.get('batch') === 'true'

  if (!path) {
    return yield* Effect.fail(new ValidationError({ message: 'path query parameter is required' }))
  }

  // Read body as array buffer
  const arrayBuffer = yield* request.arrayBuffer
  const data = new Uint8Array(arrayBuffer)

  const maxSize = batch ? MAX_BATCH_FILE : MAX_SINGLE_FILE
  if (data.length > maxSize) {
    return yield* Effect.fail(
      new ValidationError({
        message: `File size exceeds maximum allowed (${batch ? '10 GB' : '5 GB'})`,
      }),
    )
  }

  const result = yield* nodeClient.putFile({
    sandboxId: sandboxIdBytes,
    path,
    data,
  })

  return HttpServerResponse.unsafeJson({
    path,
    bytes_written: result.bytesWritten,
    batch,
  })
})

// -- Download or list files --------------------------------------------------

const downloadOrListFiles = Effect.gen(function* () {
  yield* requireScope('file:read')
  const auth = yield* AuthContext
  const sandboxRepo = yield* SandboxRepo
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

  const url = new URL(request.url, 'http://localhost')
  const path = url.searchParams.get('path')
  const list = url.searchParams.get('list') === 'true'

  if (!path) {
    return yield* Effect.fail(new ValidationError({ message: 'path query parameter is required' }))
  }

  // Directory listing
  if (list) {
    const limitStr = url.searchParams.get('limit')
    const limit = limitStr ? parseInt(limitStr, 10) : DEFAULT_LIST_LIMIT
    const cursor = url.searchParams.get('cursor')

    if (limit < 1 || limit > 200) {
      return yield* Effect.fail(
        new ValidationError({ message: 'limit must be between 1 and 200' }),
      )
    }

    const entries = yield* nodeClient.listFiles({
      sandboxId: sandboxIdBytes,
      path,
    })

    // Apply cursor-based pagination
    let startIdx = 0
    if (cursor) {
      const idx = entries.findIndex((e) => e.path === cursor)
      if (idx >= 0) startIdx = idx + 1
    }

    const page = entries.slice(startIdx, startIdx + limit)
    const hasMore = startIdx + limit < entries.length
    const nextCursor = hasMore ? page[page.length - 1].path : null

    const files: FileEntry[] = page.map((e) => ({
      name: e.name,
      path: e.path,
      type: e.type,
      size_bytes: e.sizeBytes,
    }))

    const response: ListFilesResponse = {
      files,
      next_cursor: nextCursor,
    }
    return HttpServerResponse.unsafeJson(response)
  }

  // File download
  const data = yield* nodeClient.getFile({
    sandboxId: sandboxIdBytes,
    path,
  })

  return HttpServerResponse.uint8Array(data, {
    contentType: 'application/octet-stream',
    headers: {
      'content-disposition': `attachment; filename="${path.split('/').pop()}"`,
    },
  })
})

// -- Delete file -------------------------------------------------------------

const deleteFile = Effect.gen(function* () {
  yield* requireScope('file:write')
  const auth = yield* AuthContext
  const sandboxRepo = yield* SandboxRepo
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

  const url = new URL(request.url, 'http://localhost')
  const path = url.searchParams.get('path')

  if (!path) {
    return yield* Effect.fail(new ValidationError({ message: 'path query parameter is required' }))
  }

  yield* nodeClient.deleteFile({
    sandboxId: sandboxIdBytes,
    path,
  })

  return HttpServerResponse.unsafeJson({ ok: true })
})

// -- Router ------------------------------------------------------------------

export const FileRouter = HttpRouter.empty.pipe(
  HttpRouter.put('/v1/sandboxes/:id/files', uploadFile),
  HttpRouter.get('/v1/sandboxes/:id/files', downloadOrListFiles),
  HttpRouter.del('/v1/sandboxes/:id/files', deleteFile),
)
