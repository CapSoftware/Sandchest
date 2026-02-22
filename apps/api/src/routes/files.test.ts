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
import { QuotaMemory } from '../services/quota.memory.js'
import { BillingMemory } from '../services/billing.memory.js'
import { AuditLogMemory } from '../services/audit-log.memory.js'
import { ShutdownControllerLive } from '../shutdown.js'
import { idToBytes } from '@sandchest/contract'

const TEST_ORG = 'org_test_123'
const TEST_USER = 'user_test_456'

function createTestEnv() {
  const sandboxRepo = createInMemorySandboxRepo()
  const execRepo = createInMemoryExecRepo()
  const sessionRepo = createInMemorySessionRepo()
  const nodeClient = createInMemoryNodeClient()
  const redis = createInMemoryRedisApi()
  const artifactRepo = createInMemoryArtifactRepo()

  const TestLayer = AppLive.pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provide(Layer.succeed(SandboxRepo, sandboxRepo)),
    Layer.provide(Layer.succeed(ExecRepo, execRepo)),
    Layer.provide(Layer.succeed(SessionRepo, sessionRepo)),
    Layer.provide(Layer.succeed(NodeClient, nodeClient)),
    Layer.provide(Layer.succeed(RedisService, redis)),
    Layer.provide(Layer.succeed(ArtifactRepo, artifactRepo)),
    Layer.provide(QuotaMemory),
    Layer.provide(BillingMemory),
    Layer.provide(AuditLogMemory),
    Layer.provide(ShutdownControllerLive),
    Layer.provide(
      Layer.succeed(AuthContext, { userId: TEST_USER, orgId: TEST_ORG, scopes: null }),
    ),
  )

  function runTest<A>(effect: Effect.Effect<A, unknown, HttpClient.HttpClient>) {
    return effect.pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise)
  }

  return { runTest, sandboxRepo }
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
// Upload file
// ---------------------------------------------------------------------------

describe('PUT /v1/sandboxes/:id/files — upload file', () => {
  test('uploads a file and returns bytes written', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.put(
            `/v1/sandboxes/${sandboxId}/files?path=/work/test.txt`,
          ).pipe(
            HttpClientRequest.bodyUint8Array(
              new TextEncoder().encode('hello world'),
              'application/octet-stream',
            ),
          ),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(200)
    const body = result.body as Record<string, unknown>
    expect(body.path).toBe('/work/test.txt')
    expect(body.bytes_written).toBe(11)
    expect(body.batch).toBe(false)
  })

  test('upload with batch flag', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.put(
            `/v1/sandboxes/${sandboxId}/files?path=/work&batch=true`,
          ).pipe(
            HttpClientRequest.bodyUint8Array(
              new TextEncoder().encode('tar data'),
              'application/x-tar',
            ),
          ),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(200)
    const body = result.body as Record<string, unknown>
    expect(body.batch).toBe(true)
  })

  test('rejects missing path', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.put(`/v1/sandboxes/${sandboxId}/files`).pipe(
            HttpClientRequest.bodyUint8Array(
              new TextEncoder().encode('data'),
              'application/octet-stream',
            ),
          ),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(400)
    const body = result.body as Record<string, unknown>
    expect(body.error).toBe('validation_error')
  })

  test('returns 404 for unknown sandbox', async () => {
    const env = createTestEnv()

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.put(
            '/v1/sandboxes/sb_0000000000000000000000/files?path=/work/test.txt',
          ).pipe(
            HttpClientRequest.bodyUint8Array(
              new TextEncoder().encode('data'),
              'application/octet-stream',
            ),
          ),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(404)
  })

  test('returns 409 when sandbox is not running', async () => {
    const env = createTestEnv()

    const sandboxId = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const createRes = yield* client.execute(
          HttpClientRequest.post('/v1/sandboxes').pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        return ((yield* createRes.json) as { sandbox_id: string }).sandbox_id
      }),
    )

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.put(
            `/v1/sandboxes/${sandboxId}/files?path=/work/test.txt`,
          ).pipe(
            HttpClientRequest.bodyUint8Array(
              new TextEncoder().encode('data'),
              'application/octet-stream',
            ),
          ),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(409)
  })
})

// ---------------------------------------------------------------------------
// Download file
// ---------------------------------------------------------------------------

describe('GET /v1/sandboxes/:id/files — download file', () => {
  test('downloads a previously uploaded file', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        // Upload
        yield* client.execute(
          HttpClientRequest.put(
            `/v1/sandboxes/${sandboxId}/files?path=/work/download.txt`,
          ).pipe(
            HttpClientRequest.bodyUint8Array(
              new TextEncoder().encode('file contents'),
              'application/octet-stream',
            ),
          ),
        )

        // Download
        const response = yield* client.execute(
          HttpClientRequest.get(
            `/v1/sandboxes/${sandboxId}/files?path=/work/download.txt`,
          ),
        )
        const body = yield* response.arrayBuffer
        return {
          status: response.status,
          contentType: response.headers['content-type'],
          body: new TextDecoder().decode(body),
        }
      }),
    )

    expect(result.status).toBe(200)
    expect(result.contentType).toContain('application/octet-stream')
    expect(result.body).toBe('file contents')
  })

  test('rejects missing path', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get(`/v1/sandboxes/${sandboxId}/files`),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// List files
// ---------------------------------------------------------------------------

describe('GET /v1/sandboxes/:id/files?list=true — list files', () => {
  test('returns file listing after upload', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        // Upload a file
        yield* client.execute(
          HttpClientRequest.put(
            `/v1/sandboxes/${sandboxId}/files?path=/work/listed.txt`,
          ).pipe(
            HttpClientRequest.bodyUint8Array(
              new TextEncoder().encode('data'),
              'application/octet-stream',
            ),
          ),
        )

        // List files
        const response = yield* client.execute(
          HttpClientRequest.get(
            `/v1/sandboxes/${sandboxId}/files?path=/work&list=true`,
          ),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(200)
    const body = result.body as { files: Array<Record<string, unknown>>; next_cursor: unknown }
    expect(body.files).toBeArray()
    expect(body.next_cursor).toBeNull()
  })

  test('rejects invalid limit', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get(
            `/v1/sandboxes/${sandboxId}/files?path=/work&list=true&limit=999`,
          ),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Delete file
// ---------------------------------------------------------------------------

describe('DELETE /v1/sandboxes/:id/files — delete file', () => {
  test('deletes a file', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        // Upload
        yield* client.execute(
          HttpClientRequest.put(
            `/v1/sandboxes/${sandboxId}/files?path=/work/delete-me.txt`,
          ).pipe(
            HttpClientRequest.bodyUint8Array(
              new TextEncoder().encode('delete this'),
              'application/octet-stream',
            ),
          ),
        )

        // Delete
        const response = yield* client.execute(
          HttpClientRequest.del(
            `/v1/sandboxes/${sandboxId}/files?path=/work/delete-me.txt`,
          ),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(200)
    const body = result.body as Record<string, unknown>
    expect(body.ok).toBe(true)
  })

  test('rejects missing path', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.del(`/v1/sandboxes/${sandboxId}/files`),
        )
        const body = yield* response.json
        return { status: response.status, body }
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
          HttpClientRequest.del(
            '/v1/sandboxes/sb_0000000000000000000000/files?path=/work/test.txt',
          ),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(404)
  })
})
