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

describe('GET /openapi.json', () => {
  test('returns valid OpenAPI JSON', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(HttpClientRequest.get('/openapi.json'))
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(200)
    const body = result.body as Record<string, unknown>
    expect(body.openapi).toBe('3.1.0')
    expect(body.info).toBeDefined()
    expect(body.paths).toBeDefined()
    expect(body.components).toBeDefined()
  })

  test('does not require authentication', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(HttpClientRequest.get('/openapi.json'))
        return response.status
      }),
    )

    expect(result).toBe(200)
  })
})

describe('GET /docs', () => {
  test('returns HTML page with Scalar', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(HttpClientRequest.get('/docs'))
        const body = yield* response.text
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(200)
    expect(result.body).toContain('<!DOCTYPE html>')
    expect(result.body).toContain('api-reference')
    expect(result.body).toContain('/openapi.json')
    expect(result.body).toContain('@scalar/api-reference')
  })

  test('does not require authentication', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(HttpClientRequest.get('/docs'))
        return response.status
      }),
    )

    expect(result).toBe(200)
  })
})
