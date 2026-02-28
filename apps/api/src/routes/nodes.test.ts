import { HttpClient, HttpClientRequest } from '@effect/platform'
import { NodeHttpServer } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { describe, expect, test } from 'bun:test'
import { generateUUIDv7, bytesToId, NODE_PREFIX } from '@sandchest/contract'
import { AppLive } from '../server.js'
import { AuthContext } from '../context.js'
import { SandboxRepoMemory } from '../services/sandbox-repo.memory.js'
import { ExecRepoMemory } from '../services/exec-repo.memory.js'
import { SessionRepoMemory } from '../services/session-repo.memory.js'
import { NodeClientMemory } from '../services/node-client.memory.js'
import { ArtifactRepoMemory } from '../services/artifact-repo.memory.js'
import { createInMemoryRedisApi } from '../services/redis.memory.js'
import { createInMemoryNodeRepo } from '../services/node-repo.memory.js'
import { QuotaMemory } from '../services/quota.memory.js'
import { BillingMemory } from '../services/billing.memory.js'
import { MetricsRepoMemory } from '../services/metrics-repo.memory.js'
import { ShutdownControllerLive } from '../shutdown.js'
import { NodeRepo } from '../services/node-repo.js'
import { RedisService } from '../services/redis.js'

const TestAuthLayer = Layer.succeed(AuthContext, {
  userId: 'user_test',
  orgId: 'org_test',
  scopes: null,
})

function makeTestLayer() {
  const nodeRepo = createInMemoryNodeRepo()
  const redis = createInMemoryRedisApi()

  const layer = AppLive.pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(SandboxRepoMemory),
    Layer.provide(ExecRepoMemory),
    Layer.provide(SessionRepoMemory),
    Layer.provide(NodeClientMemory),
    Layer.provide(ArtifactRepoMemory),
    Layer.provide(Layer.succeed(RedisService, redis)),
    Layer.provide(QuotaMemory),
    Layer.provide(BillingMemory),
    Layer.provide(Layer.succeed(NodeRepo, nodeRepo)),
    Layer.provide(MetricsRepoMemory),
    Layer.provide(ShutdownControllerLive),
    Layer.provide(TestAuthLayer),
  )

  return { layer, nodeRepo, redis }
}

describe('POST /v1/internal/nodes/:nodeId/heartbeat', () => {
  test('registers heartbeat and returns 200', async () => {
    const { layer } = makeTestLayer()
    const result = await Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* client.execute(
        HttpClientRequest.post('/v1/internal/nodes/node_abc123/heartbeat').pipe(
          HttpClientRequest.bodyUnsafeJson({ ttl_seconds: 30 }),
        ),
      )
      const body = yield* response.json
      return { status: response.status, body }
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise)

    expect(result.status).toBe(200)
    const body = result.body as Record<string, unknown>
    expect(body.node_id).toBe('node_abc123')
    expect(body.ttl_seconds).toBe(30)
  })

  test('uses default TTL when no body provided', async () => {
    const { layer } = makeTestLayer()
    const result = await Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* client.execute(
        HttpClientRequest.post('/v1/internal/nodes/node_xyz/heartbeat'),
      )
      const body = yield* response.json
      return { status: response.status, body }
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise)

    expect(result.status).toBe(200)
    const body = result.body as Record<string, unknown>
    expect(body.node_id).toBe('node_xyz')
    expect(body.ttl_seconds).toBe(30)
  })

  test('caps TTL at 300 seconds', async () => {
    const { layer } = makeTestLayer()
    const result = await Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* client.execute(
        HttpClientRequest.post('/v1/internal/nodes/node_cap/heartbeat').pipe(
          HttpClientRequest.bodyUnsafeJson({ ttl_seconds: 9999 }),
        ),
      )
      const body = yield* response.json
      return { status: response.status, body }
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise)

    expect(result.status).toBe(200)
    const body = result.body as Record<string, unknown>
    expect(body.ttl_seconds).toBe(300)
  })

  test('does not require auth (internal route)', async () => {
    const { layer } = makeTestLayer()
    const result = await Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* client.execute(
        HttpClientRequest.post('/v1/internal/nodes/node_noauth/heartbeat').pipe(
          HttpClientRequest.bodyUnsafeJson({}),
        ),
      )
      return response.status
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise)

    expect(result).toBe(200)
  })

  test('updates lastSeenAt in node repo for valid node ID', async () => {
    const { layer, nodeRepo } = makeTestLayer()
    const idBytes = generateUUIDv7()
    const nodeId = bytesToId(NODE_PREFIX, idBytes)

    // Pre-create the node
    await Effect.runPromise(
      nodeRepo.create({
        id: idBytes,
        name: 'test-node',
        hostname: 'test.local',
        slotsTotal: 4,
        status: 'online',
        version: null,
        firecrackerVersion: null,
      }),
    )

    // Verify lastSeenAt is null initially
    const before = await Effect.runPromise(nodeRepo.findById(idBytes))
    expect(before?.lastSeenAt).toBeNull()

    // Send heartbeat
    await Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      yield* client.execute(
        HttpClientRequest.post(`/v1/internal/nodes/${nodeId}/heartbeat`).pipe(
          HttpClientRequest.bodyUnsafeJson({ ttl_seconds: 60 }),
        ),
      )
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise)

    // Verify lastSeenAt was updated
    const after = await Effect.runPromise(nodeRepo.findById(idBytes))
    expect(after?.lastSeenAt).not.toBeNull()
    expect(after!.lastSeenAt!.getTime()).toBeGreaterThan(0)
  })

  test('sets Redis heartbeat key for valid node ID', async () => {
    const { layer, redis } = makeTestLayer()
    const idBytes = generateUUIDv7()
    const nodeId = bytesToId(NODE_PREFIX, idBytes)

    // Send heartbeat
    await Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      yield* client.execute(
        HttpClientRequest.post(`/v1/internal/nodes/${nodeId}/heartbeat`).pipe(
          HttpClientRequest.bodyUnsafeJson({ ttl_seconds: 60 }),
        ),
      )
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise)

    // Verify Redis heartbeat key
    const hasHeartbeat = await Effect.runPromise(redis.hasNodeHeartbeat(nodeId))
    expect(hasHeartbeat).toBe(true)
  })

  test('still succeeds for non-parseable node IDs without DB update', async () => {
    const { layer, redis } = makeTestLayer()
    const fakeNodeId = 'not_a_valid_node_id'

    const result = await Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* client.execute(
        HttpClientRequest.post(`/v1/internal/nodes/${fakeNodeId}/heartbeat`).pipe(
          HttpClientRequest.bodyUnsafeJson({ ttl_seconds: 45 }),
        ),
      )
      const body = yield* response.json
      return { status: response.status, body }
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise)

    expect(result.status).toBe(200)
    const body = result.body as Record<string, unknown>
    expect(body.node_id).toBe(fakeNodeId)
    expect(body.ttl_seconds).toBe(45)

    // Redis heartbeat should still be set even for non-parseable IDs
    const hasHeartbeat = await Effect.runPromise(redis.hasNodeHeartbeat(fakeNodeId))
    expect(hasHeartbeat).toBe(true)
  })
})
