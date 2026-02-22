import { HttpClient, HttpClientRequest } from '@effect/platform'
import { NodeHttpServer } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { describe, expect, test } from 'bun:test'
import { AppLive } from '../server.js'
import { AuthContext } from '../context.js'
import { SandboxRepo } from '../services/sandbox-repo.js'
import { ExecRepo } from '../services/exec-repo.js'
import { SessionRepo } from '../services/session-repo.js'
import { NodeClient } from '../services/node-client.js'
import { RedisService } from '../services/redis.js'
import { createInMemorySandboxRepo } from '../services/sandbox-repo.memory.js'
import { createInMemoryExecRepo } from '../services/exec-repo.memory.js'
import { createInMemorySessionRepo } from '../services/session-repo.memory.js'
import { createInMemoryNodeClient } from '../services/node-client.memory.js'
import { createInMemoryRedisApi } from '../services/redis.memory.js'
import { ArtifactRepo } from '../services/artifact-repo.js'
import { createInMemoryArtifactRepo } from '../services/artifact-repo.memory.js'
import { QuotaService } from '../services/quota.js'
import { createInMemoryQuotaApi } from '../services/quota.memory.js'
import { BillingService } from '../services/billing.js'
import { createInMemoryBillingApi } from '../services/billing.memory.js'
import { ObjectStorage } from '../services/object-storage.js'
import { createInMemoryObjectStorage } from '../services/object-storage.memory.js'
import { ShutdownControllerLive } from '../shutdown.js'
import { idToBytes } from '@sandchest/contract'

const TEST_ORG = 'org_test_billing'
const TEST_USER = 'user_test_billing'

function createTestEnv() {
  const sandboxRepo = createInMemorySandboxRepo()
  const execRepo = createInMemoryExecRepo()
  const sessionRepo = createInMemorySessionRepo()
  const objectStorage = createInMemoryObjectStorage()
  const nodeClient = createInMemoryNodeClient()
  const redis = createInMemoryRedisApi()
  const artifactRepo = createInMemoryArtifactRepo()
  const quotaApi = createInMemoryQuotaApi()
  const billingApi = createInMemoryBillingApi()

  const TestLayer = AppLive.pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provide(Layer.succeed(SandboxRepo, sandboxRepo)),
    Layer.provide(Layer.succeed(ExecRepo, execRepo)),
    Layer.provide(Layer.succeed(SessionRepo, sessionRepo)),
    Layer.provide(Layer.succeed(ObjectStorage, objectStorage)),
    Layer.provide(Layer.succeed(NodeClient, nodeClient)),
    Layer.provide(Layer.succeed(RedisService, redis)),
    Layer.provide(Layer.succeed(ArtifactRepo, artifactRepo)),
    Layer.provide(Layer.succeed(QuotaService, quotaApi)),
    Layer.provide(Layer.succeed(BillingService, billingApi)),
    Layer.provide(ShutdownControllerLive),
    Layer.provide(
      Layer.succeed(AuthContext, { userId: TEST_USER, orgId: TEST_ORG, scopes: null }),
    ),
  )

  function runTest<A>(effect: Effect.Effect<A, unknown, HttpClient.HttpClient>) {
    return effect.pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise)
  }

  return { runTest, sandboxRepo, billingApi }
}

function createRunningSandbox(
  env: ReturnType<typeof createTestEnv>,
): Promise<string> {
  return env.runTest(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const createRes = yield* client.execute(
        HttpClientRequest.post('/v1/sandboxes').pipe(
          HttpClientRequest.bodyUnsafeJson({}),
        ),
      )
      const created = (yield* createRes.json) as { sandbox_id: string }
      const bytes = idToBytes(created.sandbox_id)
      yield* env.sandboxRepo.updateStatus(bytes, TEST_ORG, 'running')
      return created.sandbox_id
    }),
  )
}

// ---------------------------------------------------------------------------
// Billing check — sandbox creation
// ---------------------------------------------------------------------------

describe('Billing check — sandbox creation', () => {
  test('blocks sandbox creation when billing check fails', async () => {
    const env = createTestEnv()
    env.billingApi.blockFeature(TEST_USER, 'sandboxes')

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post('/v1/sandboxes').pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        const body = yield* response.json
        return { status: response.status, body: body as { error: string; message: string } }
      }),
    )

    expect(result.status).toBe(403)
    expect(result.body.error).toBe('billing_limit')
    expect(result.body.message).toContain('Sandbox creation limit')
  })

  test('allows sandbox creation when billing check passes', async () => {
    const env = createTestEnv()

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post('/v1/sandboxes').pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        return { status: response.status }
      }),
    )

    expect(result.status).toBe(201)
  })

  test('tracks sandbox creation after success', async () => {
    const env = createTestEnv()

    await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        yield* client.execute(
          HttpClientRequest.post('/v1/sandboxes').pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
      }),
    )

    const tracked = env.billingApi._tracked
    const sandboxEvents = tracked.filter((e) => e.featureId === 'sandboxes')
    expect(sandboxEvents.length).toBe(1)
    expect(sandboxEvents[0].customerId).toBe(TEST_USER)
    expect(sandboxEvents[0].value).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Billing check — fork
// ---------------------------------------------------------------------------

describe('Billing check — fork', () => {
  test('blocks fork when billing check fails', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    env.billingApi.blockFeature(TEST_USER, 'sandboxes')

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/fork`).pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        const body = yield* response.json
        return { status: response.status, body: body as { error: string } }
      }),
    )

    expect(result.status).toBe(403)
    expect(result.body.error).toBe('billing_limit')
  })

  test('tracks fork as sandbox creation', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    // Clear tracked events from sandbox creation
    env.billingApi._tracked.length = 0

    await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/fork`).pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
      }),
    )

    const sandboxEvents = env.billingApi._tracked.filter((e) => e.featureId === 'sandboxes')
    expect(sandboxEvents.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Billing check — exec
// ---------------------------------------------------------------------------

describe('Billing check — exec', () => {
  test('blocks exec when billing check fails', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    env.billingApi.blockFeature(TEST_USER, 'execs')

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/exec`).pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: ['echo', 'hello'] }),
          ),
        )
        const body = yield* response.json
        return { status: response.status, body: body as { error: string } }
      }),
    )

    expect(result.status).toBe(403)
    expect(result.body.error).toBe('billing_limit')
  })

  test('tracks sync exec after success', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    // Clear tracked events from sandbox creation
    env.billingApi._tracked.length = 0

    await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/exec`).pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: ['echo', 'hello'] }),
          ),
        )
      }),
    )

    const execEvents = env.billingApi._tracked.filter((e) => e.featureId === 'execs')
    expect(execEvents.length).toBe(1)
    expect(execEvents[0].customerId).toBe(TEST_USER)
  })

  test('tracks async exec after success', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    // Clear tracked events from sandbox creation
    env.billingApi._tracked.length = 0

    await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/exec`).pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: ['sleep', '10'], wait: false }),
          ),
        )
      }),
    )

    const execEvents = env.billingApi._tracked.filter((e) => e.featureId === 'execs')
    expect(execEvents.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Billing check — session exec
// ---------------------------------------------------------------------------

describe('Billing check — session exec', () => {
  test('blocks session exec when billing check fails', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    // Create session first (sessions themselves don't require billing check)
    const sessionId = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const sessRes = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/sessions`).pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        const sessBody = (yield* sessRes.json) as { session_id: string }
        return sessBody.session_id
      }),
    )

    env.billingApi.blockFeature(TEST_USER, 'execs')

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(
            `/v1/sandboxes/${sandboxId}/sessions/${sessionId}/exec`,
          ).pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: 'pwd' }),
          ),
        )
        const body = yield* response.json
        return { status: response.status, body: body as { error: string } }
      }),
    )

    expect(result.status).toBe(403)
    expect(result.body.error).toBe('billing_limit')
  })

  test('tracks session exec after success', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const sessionId = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const sessRes = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/sessions`).pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        const sessBody = (yield* sessRes.json) as { session_id: string }
        return sessBody.session_id
      }),
    )

    // Clear tracked events
    env.billingApi._tracked.length = 0

    await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        yield* client.execute(
          HttpClientRequest.post(
            `/v1/sandboxes/${sandboxId}/sessions/${sessionId}/exec`,
          ).pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: 'pwd' }),
          ),
        )
      }),
    )

    const execEvents = env.billingApi._tracked.filter((e) => e.featureId === 'execs')
    expect(execEvents.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// In-memory billing API unit tests
// ---------------------------------------------------------------------------

describe('In-memory billing API', () => {
  test('allows all features by default', async () => {
    const api = createInMemoryBillingApi()
    const result = await Effect.runPromise(api.check('user1', 'sandboxes'))
    expect(result.allowed).toBe(true)
    expect(result.featureId).toBe('sandboxes')
  })

  test('blocks feature after blockFeature call', async () => {
    const api = createInMemoryBillingApi()
    api.blockFeature('user1', 'sandboxes')
    const result = await Effect.runPromise(api.check('user1', 'sandboxes'))
    expect(result.allowed).toBe(false)
  })

  test('unblockFeature restores access', async () => {
    const api = createInMemoryBillingApi()
    api.blockFeature('user1', 'sandboxes')
    api.unblockFeature('user1', 'sandboxes')
    const result = await Effect.runPromise(api.check('user1', 'sandboxes'))
    expect(result.allowed).toBe(true)
  })

  test('blocking one customer does not affect another', async () => {
    const api = createInMemoryBillingApi()
    api.blockFeature('user1', 'sandboxes')
    const result = await Effect.runPromise(api.check('user2', 'sandboxes'))
    expect(result.allowed).toBe(true)
  })

  test('track records events', async () => {
    const api = createInMemoryBillingApi()
    await Effect.runPromise(api.track('user1', 'sandboxes', 1))
    await Effect.runPromise(api.track('user1', 'execs', 5))
    expect(api._tracked.length).toBe(2)
    expect(api._tracked[0]).toEqual({ customerId: 'user1', featureId: 'sandboxes', value: 1 })
    expect(api._tracked[1]).toEqual({ customerId: 'user1', featureId: 'execs', value: 5 })
  })

  test('track defaults value to 1', async () => {
    const api = createInMemoryBillingApi()
    await Effect.runPromise(api.track('user1', 'sandboxes'))
    expect(api._tracked[0].value).toBe(1)
  })
})
