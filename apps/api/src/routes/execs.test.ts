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
  const quotaApi = createInMemoryQuotaApi()

  const TestLayer = AppLive.pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provide(Layer.succeed(SandboxRepo, sandboxRepo)),
    Layer.provide(Layer.succeed(ExecRepo, execRepo)),
    Layer.provide(Layer.succeed(SessionRepo, sessionRepo)),
    Layer.provide(Layer.succeed(NodeClient, nodeClient)),
    Layer.provide(Layer.succeed(RedisService, redis)),
    Layer.provide(Layer.succeed(ArtifactRepo, artifactRepo)),
    Layer.provide(Layer.succeed(QuotaService, quotaApi)),
    Layer.provide(ShutdownControllerLive),
    Layer.provide(
      Layer.succeed(AuthContext, { userId: TEST_USER, orgId: TEST_ORG }),
    ),
  )

  function runTest<A>(effect: Effect.Effect<A, unknown, HttpClient.HttpClient>) {
    return effect.pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise)
  }

  return { runTest, sandboxRepo, quotaApi }
}

/** Helper: create a sandbox via HTTP and transition it to running. */
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
// Execute command (sync / async)
// ---------------------------------------------------------------------------

describe('POST /v1/sandboxes/:id/exec — execute command', () => {
  test('sync exec returns result with exit code', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/exec`).pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: ['echo', 'hello'] }),
          ),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(200)
    const body = result.body as Record<string, unknown>
    expect(body.exec_id).toBeDefined()
    expect((body.exec_id as string).startsWith('ex_')).toBe(true)
    expect(body.status).toBe('done')
    expect(body.exit_code).toBe(0)
    expect(body).toHaveProperty('stdout')
    expect(body).toHaveProperty('stderr')
    expect(body).toHaveProperty('duration_ms')
    expect(body).toHaveProperty('resource_usage')
  })

  test('async exec returns exec_id with queued status', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/exec`).pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: ['sleep', '10'], wait: false }),
          ),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(202)
    const body = result.body as Record<string, unknown>
    expect(body.exec_id).toBeDefined()
    expect((body.exec_id as string).startsWith('ex_')).toBe(true)
    expect(body.status).toBe('queued')
  })

  test('accepts shell string cmd', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/exec`).pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: 'echo hello && ls' }),
          ),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(200)
    const body = result.body as Record<string, unknown>
    expect(body.status).toBe('done')
  })

  test('rejects empty array cmd', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/exec`).pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: [] }),
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

  test('rejects sync exec with timeout > 300', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/exec`).pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: ['echo'], timeout_seconds: 600 }),
          ),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(400)
  })

  test('allows async exec with timeout > 300', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/exec`).pipe(
            HttpClientRequest.bodyUnsafeJson({
              cmd: ['make', 'build'],
              wait: false,
              timeout_seconds: 600,
            }),
          ),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(202)
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
        const created = (yield* createRes.json) as { sandbox_id: string }
        return created.sandbox_id
      }),
    )

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/exec`).pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: ['echo', 'hello'] }),
          ),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(409)
    const body = result.body as Record<string, unknown>
    expect(body.error).toBe('sandbox_not_running')
  })

  test('returns 404 for unknown sandbox', async () => {
    const env = createTestEnv()

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post('/v1/sandboxes/sb_0000000000000000000000/exec').pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: ['echo'] }),
          ),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Get exec
// ---------------------------------------------------------------------------

describe('GET /v1/sandboxes/:id/exec/:execId — get exec', () => {
  test('returns exec details after sync execution', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        const execRes = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/exec`).pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: ['echo', 'hello'] }),
          ),
        )
        const execBody = (yield* execRes.json) as { exec_id: string }

        const getRes = yield* client.execute(
          HttpClientRequest.get(
            `/v1/sandboxes/${sandboxId}/exec/${execBody.exec_id}`,
          ),
        )
        const body = yield* getRes.json
        return { status: getRes.status, body }
      }),
    )

    expect(result.status).toBe(200)
    const body = result.body as Record<string, unknown>
    expect(body.exec_id).toBeDefined()
    expect(body.sandbox_id).toBe(sandboxId)
    expect(body.status).toBe('done')
    expect(body.exit_code).toBe(0)
    expect(body.cmd).toEqual(['echo', 'hello'])
    expect(body.created_at).toBeDefined()
    expect(body.started_at).toBeDefined()
    expect(body.ended_at).toBeDefined()
  })

  test('returns queued exec from async execution', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        const execRes = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/exec`).pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: ['sleep', '10'], wait: false }),
          ),
        )
        const execBody = (yield* execRes.json) as { exec_id: string }

        const getRes = yield* client.execute(
          HttpClientRequest.get(
            `/v1/sandboxes/${sandboxId}/exec/${execBody.exec_id}`,
          ),
        )
        const body = yield* getRes.json
        return { status: getRes.status, body }
      }),
    )

    expect(result.status).toBe(200)
    const body = result.body as Record<string, unknown>
    expect(body.status).toBe('queued')
    expect(body.exit_code).toBeNull()
  })

  test('returns 404 for unknown exec', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get(
            `/v1/sandboxes/${sandboxId}/exec/ex_0000000000000000000000`,
          ),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(404)
  })

  test('returns 400 for invalid exec ID', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get(`/v1/sandboxes/${sandboxId}/exec/invalid`),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// List execs
// ---------------------------------------------------------------------------

describe('GET /v1/sandboxes/:id/execs — list execs', () => {
  test('returns empty list when no execs exist', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get(`/v1/sandboxes/${sandboxId}/execs`),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(200)
    const body = result.body as { execs: unknown[]; next_cursor: unknown }
    expect(body.execs).toEqual([])
    expect(body.next_cursor).toBeNull()
  })

  test('returns created execs in seq order', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/exec`).pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: ['echo', 'one'] }),
          ),
        )
        yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/exec`).pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: ['echo', 'two'] }),
          ),
        )

        const response = yield* client.execute(
          HttpClientRequest.get(`/v1/sandboxes/${sandboxId}/execs`),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(200)
    const body = result.body as { execs: unknown[] }
    expect(body.execs.length).toBe(2)
  })

  test('filters by status', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        // Sync exec → done
        yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/exec`).pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: ['echo', 'sync'] }),
          ),
        )
        // Async exec → queued
        yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/exec`).pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: ['sleep', '10'], wait: false }),
          ),
        )

        const response = yield* client.execute(
          HttpClientRequest.get(`/v1/sandboxes/${sandboxId}/execs?status=done`),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(200)
    const body = result.body as { execs: Array<{ status: string }> }
    expect(body.execs.length).toBe(1)
    expect(body.execs[0].status).toBe('done')
  })

  test('returns 404 for unknown sandbox', async () => {
    const env = createTestEnv()

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get('/v1/sandboxes/sb_0000000000000000000000/execs'),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(404)
  })

  test('rejects invalid limit', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get(`/v1/sandboxes/${sandboxId}/execs?limit=999`),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Stream exec output (SSE)
// ---------------------------------------------------------------------------

describe('GET /v1/sandboxes/:id/exec/:execId/stream — SSE stream', () => {
  test('returns valid SSE events after sync exec', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        const execRes = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/exec`).pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: ['echo', 'hello'] }),
          ),
        )
        const execBody = (yield* execRes.json) as { exec_id: string }

        const streamRes = yield* client.execute(
          HttpClientRequest.get(
            `/v1/sandboxes/${sandboxId}/exec/${execBody.exec_id}/stream`,
          ),
        )
        const body = yield* streamRes.text
        return {
          status: streamRes.status,
          contentType: streamRes.headers['content-type'],
          body,
        }
      }),
    )

    expect(result.status).toBe(200)
    expect(result.contentType).toContain('text/event-stream')
    expect(result.body).toContain('data:')
    expect(result.body).toContain('"t":"exit"')
  })

  test('SSE events have sequential seq numbers', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        const execRes = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/exec`).pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: ['echo', 'hello'] }),
          ),
        )
        const execBody = (yield* execRes.json) as { exec_id: string }

        const streamRes = yield* client.execute(
          HttpClientRequest.get(
            `/v1/sandboxes/${sandboxId}/exec/${execBody.exec_id}/stream`,
          ),
        )
        return yield* streamRes.text
      }),
    )

    // Parse SSE events
    const events = result
      .split('\n\n')
      .filter((block) => block.includes('data:'))
      .map((block) => {
        const dataLine = block.split('\n').find((l) => l.startsWith('data:'))
        return JSON.parse(dataLine!.slice(5).trim()) as { seq: number }
      })

    expect(events.length).toBeGreaterThan(0)
    // Verify sequential seq numbers
    for (let i = 1; i < events.length; i++) {
      expect(events[i].seq).toBe(events[i - 1].seq + 1)
    }
  })

  test('Last-Event-ID reconnection skips already-seen events', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        const execRes = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/exec`).pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: ['echo', 'hello'] }),
          ),
        )
        const execBody = (yield* execRes.json) as { exec_id: string }

        // Get all events
        const allRes = yield* client.execute(
          HttpClientRequest.get(
            `/v1/sandboxes/${sandboxId}/exec/${execBody.exec_id}/stream`,
          ),
        )
        const allBody = yield* allRes.text

        // Reconnect with high Last-Event-ID → no events
        const reconnectRes = yield* client.execute(
          HttpClientRequest.get(
            `/v1/sandboxes/${sandboxId}/exec/${execBody.exec_id}/stream`,
          ).pipe(HttpClientRequest.setHeader('last-event-id', '999')),
        )
        const reconnectBody = yield* reconnectRes.text

        return { allBody, reconnectBody }
      }),
    )

    expect(result.allBody.length).toBeGreaterThan(0)
    expect(result.reconnectBody).toBe('')
  })

  test('returns 404 for unknown exec', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get(
            `/v1/sandboxes/${sandboxId}/exec/ex_0000000000000000000000/stream`,
          ),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Exec status transitions
// ---------------------------------------------------------------------------

describe('Exec status transitions', () => {
  test('sync exec transitions: queued → running → done', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        const execRes = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/exec`).pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: ['echo'] }),
          ),
        )
        const execBody = (yield* execRes.json) as { exec_id: string }

        // After sync exec, status should be 'done'
        const getRes = yield* client.execute(
          HttpClientRequest.get(
            `/v1/sandboxes/${sandboxId}/exec/${execBody.exec_id}`,
          ),
        )
        const body = yield* getRes.json
        return body as Record<string, unknown>
      }),
    )

    expect(result.status).toBe('done')
    expect(result.exit_code).toBe(0)
    expect(result.duration_ms).toBeDefined()
    expect(result.resource_usage).toBeDefined()
    expect(result.started_at).toBeDefined()
    expect(result.ended_at).toBeDefined()
  })

  test('async exec stays queued until processed', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        const execRes = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/exec`).pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: ['long-task'], wait: false }),
          ),
        )
        const execBody = (yield* execRes.json) as { exec_id: string }

        const getRes = yield* client.execute(
          HttpClientRequest.get(
            `/v1/sandboxes/${sandboxId}/exec/${execBody.exec_id}`,
          ),
        )
        const body = yield* getRes.json
        return body as Record<string, unknown>
      }),
    )

    expect(result.status).toBe('queued')
    expect(result.exit_code).toBeNull()
    expect(result.started_at).toBeNull()
    expect(result.ended_at).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Quota enforcement — exec timeout
// ---------------------------------------------------------------------------

describe('POST /v1/sandboxes/:id/exec — quota enforcement', () => {
  test('rejects exec when timeout exceeds org maxExecTimeoutSeconds', async () => {
    const env = createTestEnv()
    env.quotaApi.setOrgQuota(TEST_ORG, { maxExecTimeoutSeconds: 60 })
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/exec`).pipe(
            HttpClientRequest.bodyUnsafeJson({
              cmd: ['make', 'build'],
              wait: false,
              timeout_seconds: 61,
            }),
          ),
        )
        const body = yield* response.json
        return { status: response.status, body: body as { error: string; message: string } }
      }),
    )

    expect(result.status).toBe(400)
    expect(result.body.error).toBe('validation_error')
    expect(result.body.message).toContain('60')
  })

  test('allows exec when timeout is within org maxExecTimeoutSeconds', async () => {
    const env = createTestEnv()
    env.quotaApi.setOrgQuota(TEST_ORG, { maxExecTimeoutSeconds: 60 })
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/exec`).pipe(
            HttpClientRequest.bodyUnsafeJson({
              cmd: ['echo', 'hello'],
              timeout_seconds: 60,
            }),
          ),
        )
        return { status: response.status }
      }),
    )

    expect(result.status).toBe(200)
  })
})
