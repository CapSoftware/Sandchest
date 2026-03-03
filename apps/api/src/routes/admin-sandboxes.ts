import { HttpRouter, HttpServerResponse } from '@effect/platform'
import { Effect } from 'effect'
import { idToBytes, bytesToId, SANDBOX_PREFIX } from '@sandchest/contract'
import { ValidationError } from '../errors.js'
import { NodeRepo } from '../services/node-repo.js'
import { SandboxRepo } from '../services/sandbox-repo.js'

/**
 * Admin sandbox routes. Protected by ADMIN_API_TOKEN bearer auth (see middleware).
 */
export const AdminSandboxRouter = HttpRouter.empty.pipe(
  // GET /v1/admin/nodes/:id/sandboxes — list running sandboxes on a node
  HttpRouter.get(
    '/v1/admin/nodes/:id/sandboxes',
    Effect.gen(function* () {
      const params = yield* HttpRouter.params
      const nodeId = params.id!

      let nodeIdBytes: Uint8Array
      try {
        nodeIdBytes = idToBytes(nodeId)
      } catch {
        return yield* Effect.fail(new ValidationError({ message: 'Invalid node ID format' }))
      }

      const nodeRepo = yield* NodeRepo
      const sandboxRepo = yield* SandboxRepo

      const count = yield* nodeRepo.countActiveSandboxes(nodeIdBytes)
      const rows = yield* sandboxRepo.findRunningOnNodes([nodeIdBytes])

      const sandboxes = rows.map((row) => ({
        id: bytesToId(SANDBOX_PREFIX, row.id),
        status: row.status,
        profile_name: row.profileName,
        org_id: row.orgId,
        started_at: row.startedAt?.toISOString() ?? null,
        last_activity_at: row.lastActivityAt?.toISOString() ?? null,
        ttl_seconds: row.ttlSeconds,
        created_at: row.createdAt.toISOString(),
      }))

      return HttpServerResponse.unsafeJson({ sandboxes, count }, { status: 200 })
    }),
  ),
)
