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
import { createInMemorySandboxRepo } from '../services/sandbox-repo.memory.js'
import { createInMemoryExecRepo } from '../services/exec-repo.memory.js'
import { createInMemorySessionRepo } from '../services/session-repo.memory.js'
import { createInMemoryObjectStorage } from '../services/object-storage.memory.js'
import { createInMemoryNodeClient } from '../services/node-client.memory.js'
import { createInMemoryRedisApi } from '../services/redis.memory.js'
import { ArtifactRepo } from '../services/artifact-repo.js'
import { createInMemoryArtifactRepo } from '../services/artifact-repo.memory.js'
import { QuotaService } from '../services/quota.js'
import { createInMemoryQuotaApi } from '../services/quota.memory.js'
import { BillingService } from '../services/billing.js'
import { createInMemoryBillingApi } from '../services/billing.memory.js'
import { AuditLog } from '../services/audit-log.js'
import { createInMemoryAuditLog } from '../services/audit-log.memory.js'
import { ShutdownControllerLive } from '../shutdown.js'
import { idToBytes } from '@sandchest/contract'
import type { ReplayBundle } from '@sandchest/contract'
import type { BufferedEvent } from '../services/redis.js'

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
    Layer.provide(ShutdownControllerLive),
    Layer.provide(
      Layer.succeed(AuthContext, { userId: TEST_USER, orgId: TEST_ORG, scopes: null }),
    ),
  )

  function runTest<A>(effect: Effect.Effect<A, unknown, HttpClient.HttpClient>) {
    return effect.pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise)
  }

  return { runTest, sandboxRepo, execRepo, sessionRepo, redis, quotaApi, billingApi }
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
// GET /v1/sandboxes/:id/replay
// ---------------------------------------------------------------------------

describe('GET /v1/sandboxes/:id/replay — get replay bundle', () => {
  test('returns replay bundle for a running sandbox', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get(`/v1/sandboxes/${sandboxId}/replay`),
        )
        const body = yield* response.json
        return { status: response.status, body: body as ReplayBundle }
      }),
    )

    expect(result.status).toBe(200)
    const body = result.body
    expect(body.version).toBe(1)
    expect(body.sandbox_id).toBe(sandboxId)
    expect(body.status).toBe('in_progress')
    expect(body.image).toBeDefined()
    expect(body.profile).toBe('small')
    expect(body.forked_from).toBeNull()
    expect(body.fork_tree).toBeDefined()
    expect(body.fork_tree.sandbox_id).toBe(sandboxId)
    expect(body.fork_tree.children).toEqual([])
    expect(body.started_at).toBeDefined()
    expect(body.ended_at).toBeNull()
    expect(body.total_duration_ms).toBeNull()
    expect(body.sessions).toEqual([])
    expect(body.execs).toEqual([])
    expect(body.artifacts).toEqual([])
    expect(body.events_url).toBeDefined()
    expect(body.events_url).toContain('events.jsonl')
  })

  test('returns complete status for a stopped sandbox', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const idBytes = idToBytes(sandboxId)
    await Effect.runPromise(
      env.sandboxRepo.updateStatus(idBytes, TEST_ORG, 'stopped', {
        endedAt: new Date(),
      }),
    )

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get(`/v1/sandboxes/${sandboxId}/replay`),
        )
        const body = yield* response.json
        return { status: response.status, body: body as ReplayBundle }
      }),
    )

    expect(result.status).toBe(200)
    expect(result.body.status).toBe('complete')
    expect(result.body.ended_at).not.toBeNull()
    expect(result.body.total_duration_ms).toBeGreaterThanOrEqual(0)
  })

  test('includes execs in replay bundle', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    // Create an exec via API
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

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get(`/v1/sandboxes/${sandboxId}/replay`),
        )
        const body = yield* response.json
        return { status: response.status, body: body as ReplayBundle }
      }),
    )

    expect(result.status).toBe(200)
    expect(result.body.execs.length).toBe(1)
    const exec = result.body.execs[0]
    expect(exec.exec_id).toBeDefined()
    expect(exec.exec_id.startsWith('ex_')).toBe(true)
    expect(exec.cmd).toEqual(['echo', 'hello'])
    expect(exec.exit_code).toBe(0)
    expect(exec.started_at).toBeDefined()
    expect(exec.ended_at).toBeDefined()
    expect(exec.resource_usage).toBeDefined()
  })

  test('includes sessions in replay bundle', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    // Create a session via API
    await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/sessions`).pipe(
            HttpClientRequest.bodyUnsafeJson({ shell: '/bin/bash' }),
          ),
        )
      }),
    )

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get(`/v1/sandboxes/${sandboxId}/replay`),
        )
        const body = yield* response.json
        return { status: response.status, body: body as ReplayBundle }
      }),
    )

    expect(result.status).toBe(200)
    expect(result.body.sessions.length).toBe(1)
    const session = result.body.sessions[0]
    expect(session.session_id).toBeDefined()
    expect(session.session_id.startsWith('sess_')).toBe(true)
    expect(session.shell).toBeDefined()
    expect(session.created_at).toBeDefined()
    expect(session.destroyed_at).toBeNull()
  })

  test('includes fork tree with children', async () => {
    const env = createTestEnv()
    const parentId = await createRunningSandbox(env)

    // Fork the sandbox via API
    const forkId = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${parentId}/fork`).pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        const body = (yield* response.json) as { sandbox_id: string }
        return body.sandbox_id
      }),
    )

    // Get replay of the parent — fork tree should include the child
    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get(`/v1/sandboxes/${parentId}/replay`),
        )
        const body = yield* response.json
        return { status: response.status, body: body as ReplayBundle }
      }),
    )

    expect(result.status).toBe(200)
    expect(result.body.fork_tree.sandbox_id).toBe(parentId)
    expect(result.body.fork_tree.children.length).toBe(1)
    expect(result.body.fork_tree.children[0].sandbox_id).toBe(forkId)
  })

  test('forked sandbox replay includes forked_from', async () => {
    const env = createTestEnv()
    const parentId = await createRunningSandbox(env)

    const forkId = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${parentId}/fork`).pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        const body = (yield* response.json) as { sandbox_id: string }
        return body.sandbox_id
      }),
    )

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get(`/v1/sandboxes/${forkId}/replay`),
        )
        const body = yield* response.json
        return { status: response.status, body: body as ReplayBundle }
      }),
    )

    expect(result.status).toBe(200)
    expect(result.body.forked_from).toBe(parentId)
    expect(result.body.fork_tree.children.length).toBeGreaterThanOrEqual(0)
  })

  test('returns 404 for unknown sandbox', async () => {
    const env = createTestEnv()

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get('/v1/sandboxes/sb_0000000000000000000000/replay'),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(404)
  })

  test('returns 400 for invalid sandbox ID', async () => {
    const env = createTestEnv()

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get('/v1/sandboxes/invalid-id/replay'),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(400)
  })

  test('events_url contains presigned URL with sandbox ID', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get(`/v1/sandboxes/${sandboxId}/replay`),
        )
        const body = yield* response.json
        return body as ReplayBundle
      }),
    )

    expect(result.events_url).toContain(sandboxId)
    expect(result.events_url).toContain('events.jsonl')
  })

  test('queued sandbox has in_progress status', async () => {
    const env = createTestEnv()

    // Create sandbox but don't transition to running (stays queued)
    const sandboxId = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const createRes = yield* client.execute(
          HttpClientRequest.post('/v1/sandboxes').pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        const created = (yield* createRes.json) as { sandbox_id: string }
        return created.sandbox_id
      }),
    )

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get(`/v1/sandboxes/${sandboxId}/replay`),
        )
        const body = yield* response.json
        return body as ReplayBundle
      }),
    )

    expect(result.status).toBe('in_progress')
  })

  test('returns 410 Gone when replay has expired', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    // Stop the sandbox and set replay_expires_at to the past
    const idBytes = idToBytes(sandboxId)
    await Effect.runPromise(
      env.sandboxRepo.updateStatus(idBytes, TEST_ORG, 'stopped', {
        endedAt: new Date(Date.now() - 86_400_000),
      }),
    )
    await Effect.runPromise(
      env.sandboxRepo.setReplayExpiresAt(idBytes, new Date(Date.now() - 1000)),
    )

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get(`/v1/sandboxes/${sandboxId}/replay`),
        )
        const body = yield* response.json
        return { status: response.status, body: body as { error: string; message: string } }
      }),
    )

    expect(result.status).toBe(410)
    expect(result.body.error).toBe('gone')
    expect(result.body.message).toContain('expired')
  })

  test('returns 200 when replay has future expiry', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const idBytes = idToBytes(sandboxId)
    await Effect.runPromise(
      env.sandboxRepo.updateStatus(idBytes, TEST_ORG, 'stopped', {
        endedAt: new Date(),
      }),
    )
    // Set expiry 30 days in the future
    await Effect.runPromise(
      env.sandboxRepo.setReplayExpiresAt(idBytes, new Date(Date.now() + 30 * 86_400_000)),
    )

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get(`/v1/sandboxes/${sandboxId}/replay`),
        )
        return { status: response.status }
      }),
    )

    expect(result.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Quota enforcement — create sandbox
// ---------------------------------------------------------------------------

describe('POST /v1/sandboxes — quota enforcement', () => {
  test('rejects creation when TTL exceeds org maxTtlSeconds', async () => {
    const env = createTestEnv()
    env.quotaApi.setOrgQuota(TEST_ORG, { maxTtlSeconds: 600 })

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post('/v1/sandboxes').pipe(
            HttpClientRequest.bodyUnsafeJson({ ttl_seconds: 601 }),
          ),
        )
        const body = yield* response.json
        return { status: response.status, body: body as { error: string; message: string } }
      }),
    )

    expect(result.status).toBe(400)
    expect(result.body.error).toBe('validation_error')
    expect(result.body.message).toContain('600')
  })

  test('allows creation when TTL is within org maxTtlSeconds', async () => {
    const env = createTestEnv()
    env.quotaApi.setOrgQuota(TEST_ORG, { maxTtlSeconds: 600 })

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post('/v1/sandboxes').pipe(
            HttpClientRequest.bodyUnsafeJson({ ttl_seconds: 600 }),
          ),
        )
        return { status: response.status }
      }),
    )

    expect(result.status).toBe(201)
  })

  test('rejects creation when concurrent sandbox limit is reached', async () => {
    const env = createTestEnv()
    env.quotaApi.setOrgQuota(TEST_ORG, { maxConcurrentSandboxes: 2 })

    // Create 2 sandboxes (they start as queued, which counts as active)
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

    // Third should fail
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

    expect(result.status).toBe(429)
    expect(result.body.error).toBe('quota_exceeded')
    expect(result.body.message).toContain('2')
  })
})

// ---------------------------------------------------------------------------
// Quota enforcement — fork sandbox
// ---------------------------------------------------------------------------

describe('POST /v1/sandboxes/:id/fork — quota enforcement', () => {
  test('rejects fork when depth exceeds org maxForkDepth', async () => {
    const env = createTestEnv()
    env.quotaApi.setOrgQuota(TEST_ORG, { maxForkDepth: 1 })

    const parentId = await createRunningSandbox(env)

    // Fork once (depth becomes 1, which equals maxForkDepth)
    const forkId = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${parentId}/fork`).pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        const body = (yield* response.json) as { sandbox_id: string }
        return body.sandbox_id
      }),
    )

    // Fork from the fork (depth would become 2, exceeds maxForkDepth=1)
    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${forkId}/fork`).pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        const body = yield* response.json
        return { status: response.status, body: body as { error: string; message: string } }
      }),
    )

    expect(result.status).toBe(422)
    expect(result.body.error).toBe('fork_depth_exceeded')
  })

  test('rejects fork when per-sandbox fork count exceeds org maxForksPerSandbox', async () => {
    const env = createTestEnv()
    env.quotaApi.setOrgQuota(TEST_ORG, { maxForksPerSandbox: 1 })

    const parentId = await createRunningSandbox(env)

    // Fork once (uses up the limit)
    await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${parentId}/fork`).pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
      }),
    )

    // Second fork should fail
    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${parentId}/fork`).pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        const body = yield* response.json
        return { status: response.status, body: body as { error: string; message: string } }
      }),
    )

    expect(result.status).toBe(422)
    expect(result.body.error).toBe('fork_limit_exceeded')
  })

  test('rejects fork when concurrent sandbox limit is reached', async () => {
    const env = createTestEnv()
    env.quotaApi.setOrgQuota(TEST_ORG, { maxConcurrentSandboxes: 1 })

    const parentId = await createRunningSandbox(env)

    // The parent itself is already 1 active sandbox, so fork should fail
    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${parentId}/fork`).pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        const body = yield* response.json
        return { status: response.status, body: body as { error: string; message: string } }
      }),
    )

    expect(result.status).toBe(429)
    expect(result.body.error).toBe('quota_exceeded')
  })

  test('rejects fork when TTL exceeds org maxTtlSeconds', async () => {
    const env = createTestEnv()

    // Create sandbox before restricting TTL quota
    const parentId = await createRunningSandbox(env)

    // Now restrict TTL for the fork request
    env.quotaApi.setOrgQuota(TEST_ORG, { maxTtlSeconds: 300 })

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${parentId}/fork`).pipe(
            HttpClientRequest.bodyUnsafeJson({ ttl_seconds: 301 }),
          ),
        )
        const body = yield* response.json
        return { status: response.status, body: body as { error: string; message: string } }
      }),
    )

    expect(result.status).toBe(400)
    expect(result.body.error).toBe('validation_error')
    expect(result.body.message).toContain('300')
  })
})

// ---------------------------------------------------------------------------
// GET /v1/sandboxes/:id/stream — sandbox-level SSE
// ---------------------------------------------------------------------------

describe('GET /v1/sandboxes/:id/stream — sandbox event stream', () => {
  test('returns SSE content-type with empty body when no events', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get(`/v1/sandboxes/${sandboxId}/stream`),
        )
        const body = yield* response.text
        return {
          status: response.status,
          contentType: response.headers['content-type'],
          cacheControl: response.headers['cache-control'],
          body,
        }
      }),
    )

    expect(result.status).toBe(200)
    expect(result.contentType).toContain('text/event-stream')
    expect(result.cacheControl).toBe('no-cache')
    expect(result.body).toBe('')
  })

  test('returns buffered replay events as SSE', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const event1: BufferedEvent = {
      seq: 1,
      ts: '2026-01-01T00:00:00Z',
      data: { seq: 1, ts: '2026-01-01T00:00:00Z', type: 'sandbox.created', data: { image: 'ubuntu-22.04' } },
    }
    const event2: BufferedEvent = {
      seq: 2,
      ts: '2026-01-01T00:00:01Z',
      data: { seq: 2, ts: '2026-01-01T00:00:01Z', type: 'sandbox.ready', data: { boot_duration_ms: 150 } },
    }

    await Effect.runPromise(env.redis.pushReplayEvent(sandboxId, event1, 600))
    await Effect.runPromise(env.redis.pushReplayEvent(sandboxId, event2, 600))

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get(`/v1/sandboxes/${sandboxId}/stream`),
        )
        const body = yield* response.text
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(200)
    const lines = result.body.split('\n')
    expect(lines[0]).toBe('id: 1')
    expect(lines[1]).toContain('"type":"sandbox.created"')
    expect(lines[3]).toBe('id: 2')
    expect(lines[4]).toContain('"type":"sandbox.ready"')
  })

  test('supports Last-Event-ID for reconnection', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const event1: BufferedEvent = {
      seq: 1,
      ts: '2026-01-01T00:00:00Z',
      data: { seq: 1, ts: '2026-01-01T00:00:00Z', type: 'sandbox.created', data: { image: 'ubuntu-22.04' } },
    }
    const event2: BufferedEvent = {
      seq: 2,
      ts: '2026-01-01T00:00:01Z',
      data: { seq: 2, ts: '2026-01-01T00:00:01Z', type: 'sandbox.ready', data: { boot_duration_ms: 150 } },
    }
    const event3: BufferedEvent = {
      seq: 3,
      ts: '2026-01-01T00:00:02Z',
      data: { seq: 3, ts: '2026-01-01T00:00:02Z', type: 'exec.started', data: { exec_id: 'ex_1', cmd: ['ls'] } },
    }

    await Effect.runPromise(env.redis.pushReplayEvent(sandboxId, event1, 600))
    await Effect.runPromise(env.redis.pushReplayEvent(sandboxId, event2, 600))
    await Effect.runPromise(env.redis.pushReplayEvent(sandboxId, event3, 600))

    // Reconnect after seq 1, should only get events 2 and 3
    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get(`/v1/sandboxes/${sandboxId}/stream`).pipe(
            HttpClientRequest.setHeader('last-event-id', '1'),
          ),
        )
        const body = yield* response.text
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(200)
    // Should not contain event 1
    expect(result.body).not.toContain('"seq":1')
    // Should contain events 2 and 3
    expect(result.body).toContain('id: 2')
    expect(result.body).toContain('id: 3')
  })

  test('returns 404 for unknown sandbox', async () => {
    const env = createTestEnv()

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get('/v1/sandboxes/sb_0000000000000000000000/stream'),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(404)
  })

  test('returns 400 for invalid sandbox ID', async () => {
    const env = createTestEnv()

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get('/v1/sandboxes/invalid-id/stream'),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(400)
  })
})
