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
import { createInMemorySandboxRepo } from '../services/sandbox-repo.memory.js'
import { createInMemoryExecRepo } from '../services/exec-repo.memory.js'
import { createInMemorySessionRepo } from '../services/session-repo.memory.js'
import { createInMemoryObjectStorage } from '../services/object-storage.memory.js'
import { createInMemoryNodeClient } from '../services/node-client.memory.js'
import { createInMemoryRedisApi } from '../services/redis.memory.js'
import { createInMemoryArtifactRepo } from '../services/artifact-repo.memory.js'
import { QuotaMemory } from '../services/quota.memory.js'
import { BillingMemory } from '../services/billing.memory.js'
import { AuditLogMemory } from '../services/audit-log.memory.js'
import { NodeRepo } from '../services/node-repo.js'
import { createInMemoryNodeRepo } from '../services/node-repo.memory.js'
import { MetricsRepo } from '../services/metrics-repo.js'
import { createInMemoryMetricsRepo } from '../services/metrics-repo.memory.js'
import { ShutdownControllerLive } from '../shutdown.js'
import { idToBytes, generateUUIDv7 } from '@sandchest/contract'
import type {
  RegisterArtifactsResponse,
  ListArtifactsResponse,
} from '@sandchest/contract'

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

  const TestLayer = AppLive.pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provide(Layer.succeed(SandboxRepo, sandboxRepo)),
    Layer.provide(Layer.succeed(ExecRepo, execRepo)),
    Layer.provide(Layer.succeed(SessionRepo, sessionRepo)),
    Layer.provide(Layer.succeed(ObjectStorage, objectStorage)),
    Layer.provide(Layer.succeed(NodeClient, nodeClient)),
    Layer.provide(Layer.succeed(RedisService, redis)),
    Layer.provide(Layer.succeed(ArtifactRepo, artifactRepo)),
    Layer.provide(QuotaMemory),
    Layer.provide(BillingMemory),
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

  return { runTest, sandboxRepo, redis, artifactRepo, nodeClient }
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
// POST /v1/sandboxes/:id/artifacts — register artifact paths
// ---------------------------------------------------------------------------

describe('POST /v1/sandboxes/:id/artifacts — register artifact paths', () => {
  test('registers artifact paths successfully', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/artifacts`).pipe(
            HttpClientRequest.bodyUnsafeJson({
              paths: ['/output/report.pdf', '/output/data.csv'],
            }),
          ),
        )
        const body = yield* response.json
        return { status: response.status, body: body as RegisterArtifactsResponse }
      }),
    )

    expect(result.status).toBe(200)
    expect(result.body.registered).toBe(2)
    expect(result.body.total).toBe(2)
  })

  test('deduplicates paths across requests', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    // First request
    await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/artifacts`).pipe(
            HttpClientRequest.bodyUnsafeJson({
              paths: ['/output/report.pdf'],
            }),
          ),
        )
      }),
    )

    // Second request with duplicate + new
    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/artifacts`).pipe(
            HttpClientRequest.bodyUnsafeJson({
              paths: ['/output/report.pdf', '/output/new.txt'],
            }),
          ),
        )
        const body = yield* response.json
        return { status: response.status, body: body as RegisterArtifactsResponse }
      }),
    )

    expect(result.status).toBe(200)
    expect(result.body.registered).toBe(1)
    expect(result.body.total).toBe(2)
  })

  test('rejects empty paths array', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/artifacts`).pipe(
            HttpClientRequest.bodyUnsafeJson({ paths: [] }),
          ),
        )
        return { status: response.status }
      }),
    )

    expect(result.status).toBe(400)
  })

  test('rejects too many paths in single request', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const paths = Array.from({ length: 101 }, (_, i) => `/file${i}.txt`)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/artifacts`).pipe(
            HttpClientRequest.bodyUnsafeJson({ paths }),
          ),
        )
        return { status: response.status }
      }),
    )

    expect(result.status).toBe(400)
  })

  test('returns 404 for unknown sandbox', async () => {
    const env = createTestEnv()

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(
            '/v1/sandboxes/sb_0000000000000000000000/artifacts',
          ).pipe(
            HttpClientRequest.bodyUnsafeJson({
              paths: ['/output/file.txt'],
            }),
          ),
        )
        return { status: response.status }
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
          HttpClientRequest.post('/v1/sandboxes/invalid-id/artifacts').pipe(
            HttpClientRequest.bodyUnsafeJson({
              paths: ['/output/file.txt'],
            }),
          ),
        )
        return { status: response.status }
      }),
    )

    expect(result.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// GET /v1/sandboxes/:id/artifacts — list artifacts
// ---------------------------------------------------------------------------

describe('GET /v1/sandboxes/:id/artifacts — list artifacts', () => {
  test('returns empty list when no artifacts collected', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get(`/v1/sandboxes/${sandboxId}/artifacts`),
        )
        const body = yield* response.json
        return { status: response.status, body: body as ListArtifactsResponse }
      }),
    )

    expect(result.status).toBe(200)
    expect(result.body.artifacts).toEqual([])
    expect(result.body.next_cursor).toBeNull()
  })

  test('returns collected artifacts with download URLs', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)
    const idBytes = idToBytes(sandboxId)

    // Directly insert an artifact into the repo
    await Effect.runPromise(
      env.artifactRepo.create({
        id: generateUUIDv7(),
        sandboxId: idBytes,
        orgId: TEST_ORG,
        name: 'report.pdf',
        mime: 'application/pdf',
        bytes: 1024,
        sha256: 'a'.repeat(64),
        ref: `${TEST_ORG}/${sandboxId}/artifacts/report.pdf`,
      }),
    )

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get(`/v1/sandboxes/${sandboxId}/artifacts`),
        )
        const body = yield* response.json
        return { status: response.status, body: body as ListArtifactsResponse }
      }),
    )

    expect(result.status).toBe(200)
    expect(result.body.artifacts.length).toBe(1)
    const artifact = result.body.artifacts[0]
    expect(artifact.name).toBe('report.pdf')
    expect(artifact.mime).toBe('application/pdf')
    expect(artifact.bytes).toBe(1024)
    expect(artifact.sha256).toBe('a'.repeat(64))
    expect(artifact.id.startsWith('art_')).toBe(true)
    expect(artifact.download_url).toBeDefined()
    expect(artifact.download_url).toContain('report.pdf')
    expect(artifact.exec_id).toBeNull()
    expect(artifact.created_at).toBeDefined()
  })

  test('returns 404 for unknown sandbox', async () => {
    const env = createTestEnv()

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get(
            '/v1/sandboxes/sb_0000000000000000000000/artifacts',
          ),
        )
        return { status: response.status }
      }),
    )

    expect(result.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Graceful shutdown — artifact collection during stop
// ---------------------------------------------------------------------------

describe('Stop sandbox — artifact collection integration', () => {
  test('collects registered artifacts when stopping a sandbox', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)
    const idBytes = idToBytes(sandboxId)

    // Put files in the sandbox (via in-memory node client)
    await Effect.runPromise(
      env.nodeClient.putFile({
        sandboxId: idBytes,
        path: '/output/result.txt',
        data: new TextEncoder().encode('hello world'),
      }),
    )

    // Register artifact paths
    await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/artifacts`).pipe(
            HttpClientRequest.bodyUnsafeJson({
              paths: ['/output/result.txt'],
            }),
          ),
        )
      }),
    )

    // Stop the sandbox — triggers artifact collection
    await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/stop`),
        )
        expect(response.status).toBe(202)
      }),
    )

    // Verify artifacts were collected
    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get(`/v1/sandboxes/${sandboxId}/artifacts`),
        )
        const body = yield* response.json
        return body as ListArtifactsResponse
      }),
    )

    expect(result.artifacts.length).toBe(1)
    expect(result.artifacts[0].name).toBe('result.txt')
  })

  test('stop succeeds even if artifact collection has no registered paths', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/stop`),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(202)
  })

  test('stop succeeds even if registered paths do not exist on sandbox', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    // Register paths to files that don't exist
    await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/artifacts`).pipe(
            HttpClientRequest.bodyUnsafeJson({
              paths: ['/nonexistent/file.txt'],
            }),
          ),
        )
      }),
    )

    // Stop should succeed without error
    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/stop`),
        )
        return { status: response.status }
      }),
    )

    expect(result.status).toBe(202)

    // No artifacts should be collected (file didn't exist)
    const listResult = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get(`/v1/sandboxes/${sandboxId}/artifacts`),
        )
        const body = yield* response.json
        return body as ListArtifactsResponse
      }),
    )

    expect(listResult.artifacts.length).toBe(0)
  })
})
