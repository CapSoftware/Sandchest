import { HttpClient, HttpClientRequest, HttpRouter, HttpServer, HttpServerResponse } from '@effect/platform'
import { NodeHttpServer } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { describe, expect, test } from 'bun:test'
import { withRateLimit } from './rate-limit.js'
import { AuthContext } from '../context.js'
import { RedisMemory } from '../services/redis.memory.js'
import { RedisService, type RedisApi } from '../services/redis.js'
import { QuotaService } from '../services/quota.js'
import { QuotaMemory, createInMemoryQuotaApi } from '../services/quota.memory.js'
import { BillingMemory } from '../services/billing.memory.js'
import { withRequestId } from '../middleware.js'

const TEST_ORG = 'org_ratelimit_test'
const TEST_USER = 'user_ratelimit_test'

const TestAuthLayer = Layer.succeed(AuthContext, {
  userId: TEST_USER,
  orgId: TEST_ORG,
})

const TestRouter = HttpRouter.empty.pipe(
  HttpRouter.get('/health', Effect.succeed(HttpServerResponse.unsafeJson({ status: 'ok' }))),
  HttpRouter.get('/v1/sandboxes', Effect.succeed(HttpServerResponse.unsafeJson({ sandboxes: [] }))),
  HttpRouter.post(
    '/v1/sandboxes',
    Effect.succeed(HttpServerResponse.unsafeJson({ sandbox_id: 'sb_test' }, { status: 201 })),
  ),
  HttpRouter.post(
    '/v1/sandboxes/sb_1/exec',
    Effect.succeed(HttpServerResponse.unsafeJson({ exec_id: 'ex_test' })),
  ),
)

const AppLive = TestRouter.pipe(withRateLimit, withRequestId, HttpServer.serve())

const TestLayer = AppLive.pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(RedisMemory),
  Layer.provide(QuotaMemory),
  Layer.provide(BillingMemory),
  Layer.provide(TestAuthLayer),
)

function runTest<A>(effect: Effect.Effect<A, unknown, HttpClient.HttpClient>) {
  return effect.pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise)
}

// ---------------------------------------------------------------------------
// Rate limit headers
// ---------------------------------------------------------------------------

describe('rate limit middleware', () => {
  test('adds X-RateLimit-* headers to GET responses', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(HttpClientRequest.get('/v1/sandboxes'))
        return {
          status: response.status,
          limit: response.headers['x-ratelimit-limit'],
          remaining: response.headers['x-ratelimit-remaining'],
          reset: response.headers['x-ratelimit-reset'],
        }
      }),
    )

    expect(result.status).toBe(200)
    expect(result.limit).toBe('600')
    expect(result.remaining).toBeDefined()
    expect(result.reset).toBeDefined()
  })

  test('adds X-RateLimit-* headers to POST /v1/sandboxes', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post('/v1/sandboxes').pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        return {
          status: response.status,
          limit: response.headers['x-ratelimit-limit'],
        }
      }),
    )

    expect(result.status).toBe(201)
    expect(result.limit).toBe('30')
  })

  test('exec endpoint uses exec category limit', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post('/v1/sandboxes/sb_1/exec').pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        return {
          status: response.status,
          limit: response.headers['x-ratelimit-limit'],
        }
      }),
    )

    expect(result.status).toBe(200)
    expect(result.limit).toBe('120')
  })

  test('skips rate limiting for /health', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(HttpClientRequest.get('/health'))
        return {
          status: response.status,
          limit: response.headers['x-ratelimit-limit'],
        }
      }),
    )

    expect(result.status).toBe(200)
    expect(result.limit).toBeUndefined()
  })

  test('remaining decrements with each request', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const r1 = yield* client.execute(HttpClientRequest.get('/v1/sandboxes'))
        const r2 = yield* client.execute(HttpClientRequest.get('/v1/sandboxes'))
        return {
          remaining1: Number(r1.headers['x-ratelimit-remaining']),
          remaining2: Number(r2.headers['x-ratelimit-remaining']),
        }
      }),
    )

    expect(result.remaining1).toBeGreaterThan(result.remaining2)
  })

  test('fails open when Redis is unavailable', async () => {
    // Create a Redis implementation where checkRateLimit always throws
    const brokenRedis: RedisApi = {
      acquireSlotLease: () => Effect.succeed(false),
      releaseSlotLease: () => Effect.void,
      renewSlotLease: () => Effect.succeed(false),
      checkRateLimit: () =>
        Effect.promise(() => Promise.reject(new Error('Redis connection refused'))),
      pushExecEvent: () => Effect.void,
      getExecEvents: () => Effect.succeed([]),
      pushReplayEvent: () => Effect.void,
      getReplayEvents: (_sandboxId: string, _afterSeq: number) => Effect.succeed([]),
      addArtifactPaths: () => Effect.succeed(0),
      getArtifactPaths: () => Effect.succeed([]),
      countArtifactPaths: () => Effect.succeed(0),
      acquireLeaderLock: () => Effect.succeed(false),
      registerNodeHeartbeat: () => Effect.void,
      hasNodeHeartbeat: () => Effect.succeed(false),
      ping: () => Effect.succeed(false),
    }

    const BrokenRedisLayer = Layer.succeed(RedisService, brokenRedis)

    const BrokenTestLayer = AppLive.pipe(
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provide(BrokenRedisLayer),
      Layer.provide(QuotaMemory),
      Layer.provide(BillingMemory),
      Layer.provide(TestAuthLayer),
    )

    const result = await Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* client.execute(HttpClientRequest.get('/v1/sandboxes'))
      return {
        status: response.status,
        limit: response.headers['x-ratelimit-limit'],
      }
    }).pipe(Effect.provide(BrokenTestLayer), Effect.scoped, Effect.runPromise)

    // Request should succeed (fail open) despite Redis being down
    expect(result.status).toBe(200)
    // Rate limit headers are still set with defaults
    expect(result.limit).toBe('600')
  })

  test('uses per-org quota for rate limit values', async () => {
    const quotaApi = createInMemoryQuotaApi()
    quotaApi.setOrgQuota(TEST_ORG, { rateSandboxCreatePerMin: 5 })

    const CustomQuotaLayer = AppLive.pipe(
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provide(RedisMemory),
      Layer.provide(Layer.succeed(QuotaService, quotaApi)),
      Layer.provide(BillingMemory),
      Layer.provide(TestAuthLayer),
    )

    const result = await Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* client.execute(
        HttpClientRequest.post('/v1/sandboxes').pipe(
          HttpClientRequest.bodyUnsafeJson({}),
        ),
      )
      return {
        status: response.status,
        limit: response.headers['x-ratelimit-limit'],
      }
    }).pipe(Effect.provide(CustomQuotaLayer), Effect.scoped, Effect.runPromise)

    expect(result.status).toBe(201)
    expect(result.limit).toBe('5')
  })
})
