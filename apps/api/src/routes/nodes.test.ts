import { HttpClient, HttpClientRequest } from '@effect/platform'
import { NodeHttpServer } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { describe, expect, test } from 'bun:test'
import { AppLive } from '../server.js'
import { AuthContext } from '../context.js'
import { SandboxRepoMemory } from '../services/sandbox-repo.memory.js'
import { ExecRepoMemory } from '../services/exec-repo.memory.js'
import { SessionRepoMemory } from '../services/session-repo.memory.js'
import { NodeClientMemory } from '../services/node-client.memory.js'
import { ArtifactRepoMemory } from '../services/artifact-repo.memory.js'
import { RedisMemory } from '../services/redis.memory.js'
import { QuotaMemory } from '../services/quota.memory.js'
import { BillingMemory } from '../services/billing.memory.js'
import { ShutdownControllerLive } from '../shutdown.js'

const TestAuthLayer = Layer.succeed(AuthContext, {
  userId: 'user_test',
  orgId: 'org_test',
  scopes: null,
})

const TestLayer = AppLive.pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(SandboxRepoMemory),
  Layer.provide(ExecRepoMemory),
  Layer.provide(SessionRepoMemory),
  Layer.provide(NodeClientMemory),
  Layer.provide(ArtifactRepoMemory),
  Layer.provide(RedisMemory),
  Layer.provide(QuotaMemory),
  Layer.provide(BillingMemory),
  Layer.provide(ShutdownControllerLive),
  Layer.provide(TestAuthLayer),
)

function runTest<A>(effect: Effect.Effect<A, unknown, HttpClient.HttpClient>) {
  return effect.pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise)
}

describe('POST /v1/internal/nodes/:nodeId/heartbeat', () => {
  test('registers heartbeat and returns 200', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post('/v1/internal/nodes/node_abc123/heartbeat').pipe(
            HttpClientRequest.bodyUnsafeJson({ ttl_seconds: 30 }),
          ),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(200)
    const body = result.body as Record<string, unknown>
    expect(body.node_id).toBe('node_abc123')
    expect(body.ttl_seconds).toBe(30)
  })

  test('uses default TTL when no body provided', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post('/v1/internal/nodes/node_xyz/heartbeat'),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(200)
    const body = result.body as Record<string, unknown>
    expect(body.node_id).toBe('node_xyz')
    expect(body.ttl_seconds).toBe(30)
  })

  test('caps TTL at 300 seconds', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post('/v1/internal/nodes/node_cap/heartbeat').pipe(
            HttpClientRequest.bodyUnsafeJson({ ttl_seconds: 9999 }),
          ),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(200)
    const body = result.body as Record<string, unknown>
    expect(body.ttl_seconds).toBe(300)
  })

  test('does not require auth (internal route)', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post('/v1/internal/nodes/node_noauth/heartbeat').pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        return response.status
      }),
    )

    expect(result).toBe(200)
  })
})
