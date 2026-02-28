import { HttpClient, HttpClientRequest } from '@effect/platform'
import { NodeHttpServer } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { describe, expect, test } from 'bun:test'
import { AppLive } from '../server.js'
import { AuthContext } from '../context.js'
import { SandboxRepo } from '../services/sandbox-repo.js'
import { ExecRepo } from '../services/exec-repo.js'
import { SessionRepo } from '../services/session-repo.js'
import { ObjectStorage } from '../services/object-storage.js'
import { NodeClient } from '../services/node-client.js'
import { RedisService } from '../services/redis.js'
import { ArtifactRepo } from '../services/artifact-repo.js'
import { QuotaService } from '../services/quota.js'
import { BillingService } from '../services/billing.js'
import { AuditLog } from '../services/audit-log.js'
import { createInMemorySandboxRepo } from '../services/sandbox-repo.memory.js'
import { createInMemoryExecRepo } from '../services/exec-repo.memory.js'
import { createInMemorySessionRepo } from '../services/session-repo.memory.js'
import { createInMemoryObjectStorage } from '../services/object-storage.memory.js'
import { createInMemoryNodeClient } from '../services/node-client.memory.js'
import { createInMemoryRedisApi } from '../services/redis.memory.js'
import { createInMemoryArtifactRepo } from '../services/artifact-repo.memory.js'
import { createInMemoryQuotaApi } from '../services/quota.memory.js'
import { createInMemoryBillingApi } from '../services/billing.memory.js'
import { createInMemoryAuditLog } from '../services/audit-log.memory.js'
import { NodeRepo } from '../services/node-repo.js'
import { createInMemoryNodeRepo } from '../services/node-repo.memory.js'
import { MetricsRepo } from '../services/metrics-repo.js'
import { createInMemoryMetricsRepo } from '../services/metrics-repo.memory.js'
import { ShutdownControllerLive } from '../shutdown.js'
import { idToBytes } from '@sandchest/contract'

const TEST_ORG = 'org_test_123'
const TEST_USER = 'user_test_456'

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
  const auditLog = createInMemoryAuditLog()

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
    Layer.provide(Layer.succeed(AuditLog, auditLog)),
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

  return { runTest, sandboxRepo, auditLog }
}

function createRunningSandbox(env: ReturnType<typeof createTestEnv>): Promise<string> {
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

describe('audit log — sandbox operations', () => {
  test('sandbox create emits audit log entry', async () => {
    const env = createTestEnv()

    await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post('/v1/sandboxes').pipe(
            HttpClientRequest.bodyUnsafeJson({ image: 'ubuntu-22.04', profile: 'small' }),
          ),
        )
        expect(response.status).toBe(201)
      }),
    )

    const entries = await Effect.runPromise(env.auditLog.list(TEST_ORG))
    expect(entries.length).toBe(1)
    expect(entries[0].action).toBe('sandbox.create')
    expect(entries[0].actorId).toBe(TEST_USER)
    expect(entries[0].orgId).toBe(TEST_ORG)
    expect(entries[0].resourceType).toBe('sandbox')
    expect(entries[0].resourceId).toMatch(/^sb_/)
    expect(entries[0].metadata).toEqual({
      image: 'ubuntu-22.04',
      profile: 'small',
      ttl_seconds: 3600,
    })
  })

  test('sandbox stop emits audit log entry', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/stop`),
        )
        expect(response.status).toBe(200)
      }),
    )

    const entries = await Effect.runPromise(
      env.auditLog.list(TEST_ORG, { action: 'sandbox.stop' }),
    )
    expect(entries.length).toBe(1)
    expect(entries[0].action).toBe('sandbox.stop')
    expect(entries[0].resourceId).toBe(sandboxId)
  })

  test('sandbox delete emits audit log entry', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.del(`/v1/sandboxes/${sandboxId}`),
        )
        expect(response.status).toBe(200)
      }),
    )

    const entries = await Effect.runPromise(
      env.auditLog.list(TEST_ORG, { action: 'sandbox.delete' }),
    )
    expect(entries.length).toBe(1)
    expect(entries[0].action).toBe('sandbox.delete')
    expect(entries[0].resourceId).toBe(sandboxId)
  })

  test('sandbox fork emits audit log entry', async () => {
    const env = createTestEnv()
    const parentId = await createRunningSandbox(env)

    await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${parentId}/fork`).pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        expect(response.status).toBe(201)
      }),
    )

    const entries = await Effect.runPromise(
      env.auditLog.list(TEST_ORG, { action: 'sandbox.fork' }),
    )
    expect(entries.length).toBe(1)
    expect(entries[0].action).toBe('sandbox.fork')
    expect(entries[0].metadata).toMatchObject({ forked_from: parentId })
  })

  test('replay visibility change emits audit log entry', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.patch(`/v1/sandboxes/${sandboxId}/replay`).pipe(
            HttpClientRequest.bodyUnsafeJson({ public: true }),
          ),
        )
        expect(response.status).toBe(200)
      }),
    )

    const entries = await Effect.runPromise(
      env.auditLog.list(TEST_ORG, { action: 'sandbox.replay_visibility' }),
    )
    expect(entries.length).toBe(1)
    expect(entries[0].action).toBe('sandbox.replay_visibility')
    expect(entries[0].resourceId).toBe(sandboxId)
    expect(entries[0].metadata).toEqual({ public: true })
  })

  test('list returns entries filtered by action', async () => {
    const env = createTestEnv()

    // Create two sandboxes (two create events)
    await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        yield* client.execute(
          HttpClientRequest.post('/v1/sandboxes').pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        yield* client.execute(
          HttpClientRequest.post('/v1/sandboxes').pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
      }),
    )

    const allEntries = await Effect.runPromise(env.auditLog.list(TEST_ORG))
    expect(allEntries.length).toBe(2)

    const createEntries = await Effect.runPromise(
      env.auditLog.list(TEST_ORG, { action: 'sandbox.create' }),
    )
    expect(createEntries.length).toBe(2)

    const stopEntries = await Effect.runPromise(
      env.auditLog.list(TEST_ORG, { action: 'sandbox.stop' }),
    )
    expect(stopEntries.length).toBe(0)
  })

  test('list respects limit parameter', async () => {
    const env = createTestEnv()

    // Create three sandboxes
    await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        for (let i = 0; i < 3; i++) {
          yield* client.execute(
            HttpClientRequest.post('/v1/sandboxes').pipe(
              HttpClientRequest.bodyUnsafeJson({}),
            ),
          )
        }
      }),
    )

    const limited = await Effect.runPromise(env.auditLog.list(TEST_ORG, { limit: 2 }))
    expect(limited.length).toBe(2)
  })

  test('list returns newest entries first', async () => {
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

    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 10))

    const sandboxId = await createRunningSandbox(env)

    await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        yield* client.execute(
          HttpClientRequest.del(`/v1/sandboxes/${sandboxId}`),
        )
      }),
    )

    const entries = await Effect.runPromise(env.auditLog.list(TEST_ORG))
    // Should have 3 entries: create, create (from createRunningSandbox), delete
    expect(entries.length).toBe(3)
    // Most recent first
    expect(entries[0].action).toBe('sandbox.delete')
  })

  test('entries are isolated by orgId', async () => {
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

    const entries = await Effect.runPromise(env.auditLog.list('other_org'))
    expect(entries.length).toBe(0)
  })
})
