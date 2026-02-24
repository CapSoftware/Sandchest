import { HttpRouter, HttpServerRequest, HttpServerResponse } from '@effect/platform'
import { Effect } from 'effect'
import { generateUUIDv7, idToBytes, bytesToId, NODE_PREFIX } from '@sandchest/contract'
import { NotFoundError, ValidationError } from '../errors.js'
import { RedisService } from '../services/redis.js'
import { NodeRepo } from '../services/node-repo.js'

/**
 * Admin node routes. Protected by ADMIN_API_TOKEN bearer auth (see middleware).
 */
export const AdminNodeRouter = HttpRouter.empty.pipe(
  // GET /v1/admin/nodes — list all nodes with heartbeat status
  HttpRouter.get(
    '/v1/admin/nodes',
    Effect.gen(function* () {
      const nodeRepo = yield* NodeRepo
      const redis = yield* RedisService

      const nodes = yield* nodeRepo.list()

      const enriched = yield* Effect.all(
        nodes.map((node) =>
          Effect.gen(function* () {
            const nodeIdStr = bytesToId(NODE_PREFIX, node.id)
            const hasHeartbeat = yield* redis.hasNodeHeartbeat(nodeIdStr)
            return {
              id: nodeIdStr,
              name: node.name,
              hostname: node.hostname,
              status: node.status,
              slots_total: node.slotsTotal,
              version: node.version,
              firecracker_version: node.firecrackerVersion,
              last_seen_at: node.lastSeenAt?.toISOString() ?? null,
              heartbeat_active: hasHeartbeat,
              created_at: node.createdAt.toISOString(),
              updated_at: node.updatedAt.toISOString(),
            }
          }),
        ),
      )

      return HttpServerResponse.unsafeJson({ nodes: enriched }, { status: 200 })
    }),
  ),

  // GET /v1/admin/nodes/:id — single node detail
  HttpRouter.get(
    '/v1/admin/nodes/:id',
    Effect.gen(function* () {
      const params = yield* HttpRouter.params
      const nodeId = params.id!
      const nodeRepo = yield* NodeRepo
      const redis = yield* RedisService

      let nodeIdBytes: Uint8Array
      try {
        nodeIdBytes = idToBytes(nodeId)
      } catch {
        return yield* Effect.fail(new ValidationError({ message: 'Invalid node ID format' }))
      }

      const node = yield* nodeRepo.findById(nodeIdBytes)
      if (!node) {
        return yield* Effect.fail(new NotFoundError({ message: `Node ${nodeId} not found` }))
      }

      const hasHeartbeat = yield* redis.hasNodeHeartbeat(nodeId)

      return HttpServerResponse.unsafeJson(
        {
          id: nodeId,
          name: node.name,
          hostname: node.hostname,
          status: node.status,
          slots_total: node.slotsTotal,
          version: node.version,
          firecracker_version: node.firecrackerVersion,
          capabilities: node.capabilities,
          last_seen_at: node.lastSeenAt?.toISOString() ?? null,
          heartbeat_active: hasHeartbeat,
          created_at: node.createdAt.toISOString(),
          updated_at: node.updatedAt.toISOString(),
        },
        { status: 200 },
      )
    }),
  ),

  // POST /v1/admin/nodes — register a new node
  HttpRouter.post(
    '/v1/admin/nodes',
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const body = (yield* request.json) as {
        name?: string
        hostname?: string
        slots_total?: number
        version?: string
        firecracker_version?: string
      }

      if (!body.name || typeof body.name !== 'string') {
        return yield* Effect.fail(new ValidationError({ message: 'name is required' }))
      }
      if (!body.hostname || typeof body.hostname !== 'string') {
        return yield* Effect.fail(new ValidationError({ message: 'hostname is required' }))
      }

      const nodeRepo = yield* NodeRepo
      const idBytes = generateUUIDv7()
      const id = bytesToId(NODE_PREFIX, idBytes)

      yield* nodeRepo.create({
        id: idBytes,
        name: body.name,
        hostname: body.hostname,
        slotsTotal: body.slots_total ?? 4,
        status: 'online',
        version: body.version ?? null,
        firecrackerVersion: body.firecracker_version ?? null,
      })

      return HttpServerResponse.unsafeJson(
        { id, name: body.name, hostname: body.hostname, status: 'online' },
        { status: 201 },
      )
    }),
  ),

  // PATCH /v1/admin/nodes/:id — update status, slots
  HttpRouter.patch(
    '/v1/admin/nodes/:id',
    Effect.gen(function* () {
      const params = yield* HttpRouter.params
      const nodeId = params.id!
      const request = yield* HttpServerRequest.HttpServerRequest
      const body = (yield* request.json) as {
        status?: string
        slots_total?: number
        version?: string
        firecracker_version?: string
      }

      let nodeIdBytes: Uint8Array
      try {
        nodeIdBytes = idToBytes(nodeId)
      } catch {
        return yield* Effect.fail(new ValidationError({ message: 'Invalid node ID format' }))
      }

      const nodeRepo = yield* NodeRepo
      const node = yield* nodeRepo.findById(nodeIdBytes)
      if (!node) {
        return yield* Effect.fail(new NotFoundError({ message: `Node ${nodeId} not found` }))
      }

      const validStatuses = ['online', 'offline', 'draining', 'disabled']
      if (body.status && !validStatuses.includes(body.status)) {
        return yield* Effect.fail(
          new ValidationError({ message: `Invalid status. Must be one of: ${validStatuses.join(', ')}` }),
        )
      }

      yield* nodeRepo.update(nodeIdBytes, {
        status: body.status as 'online' | 'offline' | 'draining' | 'disabled' | undefined,
        slotsTotal: body.slots_total,
        version: body.version,
        firecrackerVersion: body.firecracker_version,
      })

      return HttpServerResponse.unsafeJson({ id: nodeId, updated: true }, { status: 200 })
    }),
  ),

  // DELETE /v1/admin/nodes/:id — remove node
  HttpRouter.del(
    '/v1/admin/nodes/:id',
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
      const node = yield* nodeRepo.findById(nodeIdBytes)
      if (!node) {
        return yield* Effect.fail(new NotFoundError({ message: `Node ${nodeId} not found` }))
      }

      const activeSandboxes = yield* nodeRepo.countActiveSandboxes(nodeIdBytes)
      if (activeSandboxes > 0) {
        return yield* Effect.fail(
          new ValidationError({
            message: `Cannot remove node with ${activeSandboxes} active sandbox(es). Drain first.`,
          }),
        )
      }

      yield* nodeRepo.remove(nodeIdBytes)

      return HttpServerResponse.unsafeJson({ id: nodeId, deleted: true }, { status: 200 })
    }),
  ),
)
