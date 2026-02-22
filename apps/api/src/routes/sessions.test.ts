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
// Create session
// ---------------------------------------------------------------------------

describe('POST /v1/sandboxes/:id/sessions — create session', () => {
  test('creates a session with default shell', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/sessions`).pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(201)
    const body = result.body as Record<string, unknown>
    expect(body.session_id).toBeDefined()
    expect((body.session_id as string).startsWith('sess_')).toBe(true)
    expect(body.status).toBe('running')
  })

  test('creates a session with custom shell', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/sessions`).pipe(
            HttpClientRequest.bodyUnsafeJson({ shell: '/bin/sh' }),
          ),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(201)
  })

  test('enforces max 5 concurrent sessions', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    // Create 5 sessions
    for (let i = 0; i < 5; i++) {
      await env.runTest(
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient
          yield* client.execute(
            HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/sessions`).pipe(
              HttpClientRequest.bodyUnsafeJson({}),
            ),
          )
        }),
      )
    }

    // 6th should fail
    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/sessions`).pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(409)
  })

  test('returns 404 for unknown sandbox', async () => {
    const env = createTestEnv()

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post('/v1/sandboxes/sb_0000000000000000000000/sessions').pipe(
            HttpClientRequest.bodyUnsafeJson({}),
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
        const created = (yield* createRes.json) as { sandbox_id: string }
        return created.sandbox_id
      }),
    )

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/sessions`).pipe(
            HttpClientRequest.bodyUnsafeJson({}),
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
})

// ---------------------------------------------------------------------------
// Session exec
// ---------------------------------------------------------------------------

describe('POST /v1/sandboxes/:id/sessions/:sessionId/exec — session exec', () => {
  test('sync session exec returns result', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        // Create session
        const sessRes = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/sessions`).pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        const sessBody = (yield* sessRes.json) as { session_id: string }

        // Exec in session
        const execRes = yield* client.execute(
          HttpClientRequest.post(
            `/v1/sandboxes/${sandboxId}/sessions/${sessBody.session_id}/exec`,
          ).pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: 'pwd' }),
          ),
        )
        const body = yield* execRes.json
        return { status: execRes.status, body }
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
  })

  test('async session exec returns 202', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        const sessRes = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/sessions`).pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        const sessBody = (yield* sessRes.json) as { session_id: string }

        const execRes = yield* client.execute(
          HttpClientRequest.post(
            `/v1/sandboxes/${sandboxId}/sessions/${sessBody.session_id}/exec`,
          ).pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: 'sleep 10', wait: false }),
          ),
        )
        const body = yield* execRes.json
        return { status: execRes.status, body }
      }),
    )

    expect(result.status).toBe(202)
    const body = result.body as Record<string, unknown>
    expect(body.exec_id).toBeDefined()
    expect(body.status).toBe('queued')
  })

  test('rejects empty cmd', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        const sessRes = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/sessions`).pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        const sessBody = (yield* sessRes.json) as { session_id: string }

        const execRes = yield* client.execute(
          HttpClientRequest.post(
            `/v1/sandboxes/${sandboxId}/sessions/${sessBody.session_id}/exec`,
          ).pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: '' }),
          ),
        )
        const body = yield* execRes.json
        return { status: execRes.status, body }
      }),
    )

    expect(result.status).toBe(400)
  })

  test('returns 404 for unknown session', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(
            `/v1/sandboxes/${sandboxId}/sessions/sess_0000000000000000000000/exec`,
          ).pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: 'ls' }),
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
// Session input
// ---------------------------------------------------------------------------

describe('POST /v1/sandboxes/:id/sessions/:sessionId/input — session input', () => {
  test('sends input to session', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        const sessRes = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/sessions`).pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        const sessBody = (yield* sessRes.json) as { session_id: string }

        const inputRes = yield* client.execute(
          HttpClientRequest.post(
            `/v1/sandboxes/${sandboxId}/sessions/${sessBody.session_id}/input`,
          ).pipe(
            HttpClientRequest.bodyUnsafeJson({ data: "console.log('hello')\n" }),
          ),
        )
        const body = yield* inputRes.json
        return { status: inputRes.status, body }
      }),
    )

    expect(result.status).toBe(200)
    const body = result.body as Record<string, unknown>
    expect(body.ok).toBe(true)
  })

  test('rejects missing data', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        const sessRes = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/sessions`).pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        const sessBody = (yield* sessRes.json) as { session_id: string }

        const inputRes = yield* client.execute(
          HttpClientRequest.post(
            `/v1/sandboxes/${sandboxId}/sessions/${sessBody.session_id}/input`,
          ).pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        const body = yield* inputRes.json
        return { status: inputRes.status, body }
      }),
    )

    expect(result.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// List sessions
// ---------------------------------------------------------------------------

describe('GET /v1/sandboxes/:id/sessions — list sessions', () => {
  test('returns empty list when no sessions exist', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get(`/v1/sandboxes/${sandboxId}/sessions`),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(200)
    const body = result.body as { sessions: unknown[]; next_cursor: unknown }
    expect(body.sessions).toEqual([])
    expect(body.next_cursor).toBeNull()
  })

  test('returns created sessions', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        // Create two sessions
        yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/sessions`).pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/sessions`).pipe(
            HttpClientRequest.bodyUnsafeJson({ shell: '/bin/sh' }),
          ),
        )

        const response = yield* client.execute(
          HttpClientRequest.get(`/v1/sandboxes/${sandboxId}/sessions`),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(200)
    const body = result.body as { sessions: Array<Record<string, unknown>> }
    expect(body.sessions.length).toBe(2)
    expect(body.sessions[0].status).toBe('running')
    expect(body.sessions[0].session_id).toBeDefined()
    expect(body.sessions[0].shell).toBeDefined()
    expect(body.sessions[0].created_at).toBeDefined()
  })

  test('returns 404 for unknown sandbox', async () => {
    const env = createTestEnv()

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get('/v1/sandboxes/sb_0000000000000000000000/sessions'),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Destroy session
// ---------------------------------------------------------------------------

describe('DELETE /v1/sandboxes/:id/sessions/:sessionId — destroy session', () => {
  test('destroys an existing session', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        const sessRes = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/sessions`).pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        const sessBody = (yield* sessRes.json) as { session_id: string }

        const delRes = yield* client.execute(
          HttpClientRequest.del(
            `/v1/sandboxes/${sandboxId}/sessions/${sessBody.session_id}`,
          ),
        )
        const body = yield* delRes.json
        return { status: delRes.status, body }
      }),
    )

    expect(result.status).toBe(200)
    const body = result.body as Record<string, unknown>
    expect(body.ok).toBe(true)
  })

  test('destroyed session allows new session past max', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        // Create 5 sessions, keep track of the first
        const firstRes = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/sessions`).pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        const firstSess = (yield* firstRes.json) as { session_id: string }

        for (let i = 0; i < 4; i++) {
          yield* client.execute(
            HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/sessions`).pipe(
              HttpClientRequest.bodyUnsafeJson({}),
            ),
          )
        }

        // Destroy the first session
        yield* client.execute(
          HttpClientRequest.del(
            `/v1/sandboxes/${sandboxId}/sessions/${firstSess.session_id}`,
          ),
        )

        // Creating a 6th should now succeed (only 4 active)
        const newRes = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/sessions`).pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        return newRes.status
      }),
    )

    expect(result).toBe(201)
  })

  test('returns 404 for unknown session', async () => {
    const env = createTestEnv()
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.del(
            `/v1/sandboxes/${sandboxId}/sessions/sess_0000000000000000000000`,
          ),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(404)
  })
})
