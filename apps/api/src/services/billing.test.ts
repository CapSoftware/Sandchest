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
import { AuditLogMemory } from '../services/audit-log.memory.js'
import { NodeRepo } from '../services/node-repo.js'
import { createInMemoryNodeRepo } from '../services/node-repo.memory.js'
import { MetricsRepo } from '../services/metrics-repo.js'
import { createInMemoryMetricsRepo } from '../services/metrics-repo.memory.js'
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
    Layer.provide(AuditLogMemory),
    Layer.provide(Layer.succeed(NodeRepo, createInMemoryNodeRepo())),
    Layer.provide(Layer.succeed(MetricsRepo, createInMemoryMetricsRepo())),
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
// Billing check — sandbox creation (credits)
// ---------------------------------------------------------------------------

describe('Billing check — sandbox creation', () => {
  test('blocks sandbox creation when credits depleted', async () => {
    const env = createTestEnv()
    env.billingApi.blockFeature(TEST_ORG, 'credits')

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
    expect(result.body.message).toContain('Credits depleted')
  })

  test('allows sandbox creation when credits available', async () => {
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

  test('does not track per-event usage on sandbox creation', async () => {
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

    // Under the credit model, no per-event tracking happens at creation time
    const sandboxEvents = env.billingApi._tracked.filter((e) => e.featureId === 'sandboxes')
    expect(sandboxEvents.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Billing check — fork (credits)
// ---------------------------------------------------------------------------

describe('Billing check — fork', () => {
  test('blocks fork when credits depleted', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    env.billingApi.blockFeature(TEST_ORG, 'credits')

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

  test('does not track per-event usage on fork', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

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
    expect(sandboxEvents.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Billing check — exec (credits)
// ---------------------------------------------------------------------------

describe('Billing check — exec', () => {
  test('blocks exec when credits depleted', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    env.billingApi.blockFeature(TEST_ORG, 'credits')

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

  test('does not track per-event usage on sync exec', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

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
    expect(execEvents.length).toBe(0)
  })

  test('does not track per-event usage on async exec', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

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
    expect(execEvents.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Billing check — session exec (credits)
// ---------------------------------------------------------------------------

describe('Billing check — session exec', () => {
  test('blocks session exec when credits depleted', async () => {
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

    env.billingApi.blockFeature(TEST_ORG, 'credits')

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

  test('does not track per-event usage on session exec', async () => {
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
    expect(execEvents.length).toBe(0)
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

  test('trackCompute records compute events', async () => {
    const api = createInMemoryBillingApi()
    await Effect.runPromise(api.trackCompute('user1', 0.05, 'sb_123'))
    expect(api._tracked.length).toBe(1)
    expect(api._tracked[0]).toEqual({
      customerId: 'user1',
      featureId: 'compute',
      value: 0.05,
      sandboxId: 'sb_123',
    })
  })

  test('checkCredits allows by default', async () => {
    const api = createInMemoryBillingApi()
    const result = await Effect.runPromise(api.checkCredits('user1', 10))
    expect(result.allowed).toBe(true)
    expect(result.featureId).toBe('credits')
  })

  test('checkCredits blocks when credits feature is blocked', async () => {
    const api = createInMemoryBillingApi()
    api.blockFeature('user1', 'credits')
    const result = await Effect.runPromise(api.checkCredits('user1', 10))
    expect(result.allowed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Compute cost calculator
// ---------------------------------------------------------------------------

describe('computeCostForMinutes', () => {
  test('calculates free tier cost correctly', async () => {
    const { computeCostForMinutes } = await import('../services/compute-cost.js')
    // Free tier: 2 vCPUs × $0.030/hr + 4 GiB × $0.010/hr = $0.10/hr
    const cost = computeCostForMinutes(60, 'free', 2, 4)
    expect(cost).toBeCloseTo(0.1, 5)
  })

  test('calculates max tier cost correctly', async () => {
    const { computeCostForMinutes } = await import('../services/compute-cost.js')
    // Max tier: 2 vCPUs × $0.025/hr + 4 GiB × $0.008/hr = $0.082/hr
    const cost = computeCostForMinutes(60, 'max', 2, 4)
    expect(cost).toBeCloseTo(0.082, 5)
  })

  test('scales with minutes', async () => {
    const { computeCostForMinutes } = await import('../services/compute-cost.js')
    const oneHour = computeCostForMinutes(60, 'free', 2, 4)
    const halfHour = computeCostForMinutes(30, 'free', 2, 4)
    expect(halfHour).toBeCloseTo(oneHour / 2, 5)
  })

  test('returns zero for zero minutes', async () => {
    const { computeCostForMinutes } = await import('../services/compute-cost.js')
    expect(computeCostForMinutes(0, 'free')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// computeCostForProfile
// ---------------------------------------------------------------------------

describe('computeCostForProfile', () => {
  test('maps small profile to 2 vCPUs / 4 GiB', async () => {
    const { computeCostForMinutes, computeCostForProfile } = await import('../services/compute-cost.js')
    const profileCost = computeCostForProfile(60, 'free', 'small')
    const directCost = computeCostForMinutes(60, 'free', 2, 4)
    expect(profileCost).toBe(directCost)
  })

  test('maps medium profile to 4 vCPUs / 8 GiB', async () => {
    const { computeCostForMinutes, computeCostForProfile } = await import('../services/compute-cost.js')
    const profileCost = computeCostForProfile(60, 'free', 'medium')
    const directCost = computeCostForMinutes(60, 'free', 4, 8)
    expect(profileCost).toBe(directCost)
  })

  test('maps large profile to 8 vCPUs / 16 GiB', async () => {
    const { computeCostForMinutes, computeCostForProfile } = await import('../services/compute-cost.js')
    const profileCost = computeCostForProfile(60, 'free', 'large')
    const directCost = computeCostForMinutes(60, 'free', 8, 16)
    expect(profileCost).toBe(directCost)
  })

  test('uses max tier rates for max tier', async () => {
    const { computeCostForProfile } = await import('../services/compute-cost.js')
    const freeCost = computeCostForProfile(60, 'free', 'small')
    const maxCost = computeCostForProfile(60, 'max', 'small')
    expect(maxCost).toBeLessThan(freeCost)
  })
})

// ---------------------------------------------------------------------------
// meterSandbox
// ---------------------------------------------------------------------------

describe('meterSandbox', () => {
  function createMeteringEnv() {
    const sandboxRepo = createInMemorySandboxRepo()
    const billingApi = createInMemoryBillingApi()

    const testLayer = Layer.mergeAll(
      Layer.succeed(SandboxRepo, sandboxRepo),
      Layer.succeed(BillingService, billingApi),
    )

    function run<A>(effect: Effect.Effect<A, unknown, SandboxRepo | BillingService>) {
      return Effect.runPromise(Effect.provide(effect, testLayer))
    }

    return { sandboxRepo, billingApi, run }
  }

  async function createRunningTestSandbox(env: ReturnType<typeof createMeteringEnv>, startedAt: Date) {
    const { generateUUIDv7 } = await import('@sandchest/contract')
    const repo = env.sandboxRepo
    const id = generateUUIDv7()

    await Effect.runPromise(
      repo.create({
        id,
        orgId: TEST_ORG,
        imageId: new Uint8Array(16),
        profileId: new Uint8Array(16),
        profileName: 'small',
        env: null,
        ttlSeconds: 3600,
        imageRef: 'ubuntu-22.04/base',
      }),
    )

    // Assign node to transition to running
    const nodeId = generateUUIDv7()
    await Effect.runPromise(repo.assignNode(id, TEST_ORG, nodeId))

    // Override startedAt for test control
    const row = await Effect.runPromise(repo.findById(id, TEST_ORG))
    if (!row) throw new Error('Sandbox not found')
    // Directly set startedAt by updating the store via touchLastActivity
    // then we need to get the row again
    return { id, row: { ...row, startedAt } }
  }

  test('calculates cost based on elapsed time since startedAt', async () => {
    const { meterSandbox } = await import('../workers/credit-metering.js')
    const env = createMeteringEnv()

    const startedAt = new Date(Date.now() - 60 * 60_000) // 60 minutes ago
    const { id, row } = await createRunningTestSandbox(env, startedAt)
    const now = new Date()

    await env.run(meterSandbox(row, now, 'free'))

    expect(env.billingApi._tracked.length).toBe(1)
    const event = env.billingApi._tracked[0]
    expect(event.featureId).toBe('compute')
    expect(event.customerId).toBe(TEST_ORG)
    // Small profile, free tier, 60 min = $0.10
    expect(event.value).toBeCloseTo(0.1, 2)
  })

  test('skips metering when startedAt is null', async () => {
    const { meterSandbox } = await import('../workers/credit-metering.js')
    const env = createMeteringEnv()

    const row = {
      id: new Uint8Array(16),
      orgId: TEST_ORG,
      nodeId: null,
      imageId: new Uint8Array(16),
      profileId: new Uint8Array(16),
      profileName: 'small' as const,
      status: 'running' as const,
      env: null,
      forkedFrom: null,
      forkDepth: 0,
      forkCount: 0,
      ttlSeconds: 3600,
      failureReason: null,
      replayPublic: false,
      replayExpiresAt: null,
      lastActivityAt: null,
      lastMeteredAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      startedAt: null,
      endedAt: null,
      imageRef: 'test',
    }

    await env.run(meterSandbox(row, new Date(), 'free'))

    expect(env.billingApi._tracked.length).toBe(0)
  })

  test('skips metering when elapsed time is zero or negative', async () => {
    const { meterSandbox } = await import('../workers/credit-metering.js')
    const env = createMeteringEnv()

    const now = new Date()
    const { row } = await createRunningTestSandbox(env, now)

    // Meter at the same time as start
    await env.run(meterSandbox(row, now, 'free'))

    expect(env.billingApi._tracked.length).toBe(0)
  })

  test('reads lastMeteredAt from repo instead of using stale snapshot', async () => {
    const { meterSandbox } = await import('../workers/credit-metering.js')
    const env = createMeteringEnv()

    const startedAt = new Date(Date.now() - 120 * 60_000) // 120 min ago
    const { id, row } = await createRunningTestSandbox(env, startedAt)

    // First metering: should bill from startedAt (120 min of compute)
    const now = new Date()
    await env.run(meterSandbox(row, now, 'free'))

    expect(env.billingApi._tracked.length).toBe(1)
    const firstBill = env.billingApi._tracked[0].value
    // Small profile, free tier, ~120 min ≈ $0.20
    expect(firstBill).toBeCloseTo(0.2, 1)

    env.billingApi._tracked.length = 0

    // Second metering 1 minute later: the row snapshot is stale (lastMeteredAt=null)
    // but meterSandbox re-reads from the repo where lastMeteredAt was just set
    const later = new Date(now.getTime() + 60_000)
    await env.run(meterSandbox(row, later, 'free'))

    // Should only bill for the ~1 minute since last meter, not 121 minutes
    if (env.billingApi._tracked.length > 0) {
      const secondBill = env.billingApi._tracked[0].value
      expect(secondBill).toBeLessThan(0.01)
    }
    // If no event tracked, elapsed was too small — that's also correct
  })

  test('updates lastMeteredAt after metering', async () => {
    const { meterSandbox } = await import('../workers/credit-metering.js')
    const env = createMeteringEnv()

    const startedAt = new Date(Date.now() - 60 * 60_000)
    const { id, row } = await createRunningTestSandbox(env, startedAt)
    const now = new Date()

    await env.run(meterSandbox(row, now, 'free'))

    const lastMetered = await Effect.runPromise(env.sandboxRepo.getLastMeteredAt(id))
    expect(lastMetered).not.toBeNull()
  })

  test('applies max tier rates when tier is max', async () => {
    const { meterSandbox } = await import('../workers/credit-metering.js')
    const env = createMeteringEnv()

    const startedAt = new Date(Date.now() - 60 * 60_000)
    const { row: freeRow } = await createRunningTestSandbox(env, startedAt)
    const { row: maxRow } = await createRunningTestSandbox(env, startedAt)
    const now = new Date()

    await env.run(meterSandbox(freeRow, now, 'free'))
    const freeCost = env.billingApi._tracked[0].value

    env.billingApi._tracked.length = 0

    await env.run(meterSandbox(maxRow, now, 'max'))
    const maxCost = env.billingApi._tracked[0].value

    expect(maxCost).toBeLessThan(freeCost)
  })
})

// ---------------------------------------------------------------------------
// Repo: findRunningForMetering and touchLastMetered
// ---------------------------------------------------------------------------

describe('SandboxRepo metering methods', () => {
  test('findRunningForMetering returns only running sandboxes with startedAt', async () => {
    const repo = createInMemorySandboxRepo()
    const { generateUUIDv7 } = await import('@sandchest/contract')

    // Create a sandbox and leave it queued (should not appear)
    const queuedId = generateUUIDv7()
    await Effect.runPromise(
      repo.create({
        id: queuedId,
        orgId: TEST_ORG,
        imageId: new Uint8Array(16),
        profileId: new Uint8Array(16),
        profileName: 'small',
        env: null,
        ttlSeconds: 3600,
        imageRef: 'test',
      }),
    )

    // Create a running sandbox
    const runningId = generateUUIDv7()
    await Effect.runPromise(
      repo.create({
        id: runningId,
        orgId: TEST_ORG,
        imageId: new Uint8Array(16),
        profileId: new Uint8Array(16),
        profileName: 'small',
        env: null,
        ttlSeconds: 3600,
        imageRef: 'test',
      }),
    )
    const nodeId = generateUUIDv7()
    await Effect.runPromise(repo.assignNode(runningId, TEST_ORG, nodeId))

    const running = await Effect.runPromise(repo.findRunningForMetering())
    expect(running.length).toBe(1)
    expect(running[0].status).toBe('running')
    expect(running[0].startedAt).not.toBeNull()
  })

  test('getLastMeteredAt returns null when not set', async () => {
    const repo = createInMemorySandboxRepo()
    const { generateUUIDv7 } = await import('@sandchest/contract')

    const id = generateUUIDv7()
    await Effect.runPromise(
      repo.create({
        id,
        orgId: TEST_ORG,
        imageId: new Uint8Array(16),
        profileId: new Uint8Array(16),
        profileName: 'small',
        env: null,
        ttlSeconds: 3600,
        imageRef: 'test',
      }),
    )

    const result = await Effect.runPromise(repo.getLastMeteredAt(id))
    expect(result).toBeNull()
  })

  test('touchLastMetered sets lastMeteredAt and getLastMeteredAt returns it', async () => {
    const repo = createInMemorySandboxRepo()
    const { generateUUIDv7 } = await import('@sandchest/contract')

    const id = generateUUIDv7()
    await Effect.runPromise(
      repo.create({
        id,
        orgId: TEST_ORG,
        imageId: new Uint8Array(16),
        profileId: new Uint8Array(16),
        profileName: 'small',
        env: null,
        ttlSeconds: 3600,
        imageRef: 'test',
      }),
    )

    await Effect.runPromise(repo.touchLastMetered(id))

    const result = await Effect.runPromise(repo.getLastMeteredAt(id))
    expect(result).not.toBeNull()
    expect(result!.getTime()).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// getBillingTier
// ---------------------------------------------------------------------------

describe('getBillingTier', () => {
  test('defaults to free tier in memory implementation', async () => {
    const api = createInMemoryBillingApi()
    const tier = await Effect.runPromise(api.getBillingTier('org1'))
    expect(tier).toBe('free')
  })
})
