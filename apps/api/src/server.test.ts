import { HttpClient, HttpClientRequest } from '@effect/platform'
import { NodeHttpServer } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { describe, expect, test } from 'bun:test'
import { AppLive } from './server.js'
import { AuthContext } from './context.js'
import { SandboxRepoMemory } from './services/sandbox-repo.memory.js'
import { ExecRepoMemory } from './services/exec-repo.memory.js'
import { NodeClientMemory } from './services/node-client.memory.js'
import { RedisMemory } from './services/redis.memory.js'

const TEST_ORG = 'org_test_123'
const TEST_USER = 'user_test_456'

const TestAuthLayer = Layer.succeed(AuthContext, {
  userId: TEST_USER,
  orgId: TEST_ORG,
})

const TestLayer = AppLive.pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(SandboxRepoMemory),
  Layer.provide(ExecRepoMemory),
  Layer.provide(NodeClientMemory),
  Layer.provide(RedisMemory),
  Layer.provide(TestAuthLayer),
)

function runTest<A>(effect: Effect.Effect<A, unknown, HttpClient.HttpClient>) {
  return effect.pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise)
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

describe('Health endpoint', () => {
  test('GET /health returns 200 with status ok', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(HttpClientRequest.get('/health'))
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(200)
    expect(result.body).toEqual({ status: 'ok' })
  })

  test('GET /health includes X-Request-Id header', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(HttpClientRequest.get('/health'))
        return response.headers['x-request-id']
      }),
    )

    expect(result).toBeDefined()
    expect(typeof result).toBe('string')
    expect(result!.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Request ID propagation
// ---------------------------------------------------------------------------

describe('Request ID propagation', () => {
  test('echoes back provided X-Request-Id', async () => {
    const customId = 'req_test_12345'
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get('/health').pipe(
            HttpClientRequest.setHeader('x-request-id', customId),
          ),
        )
        return response.headers['x-request-id']
      }),
    )

    expect(result).toBe(customId)
  })
})

// ---------------------------------------------------------------------------
// Create sandbox
// ---------------------------------------------------------------------------

describe('POST /v1/sandboxes — create sandbox', () => {
  test('creates a sandbox with defaults', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post('/v1/sandboxes').pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(201)
    const body = result.body as Record<string, unknown>
    expect(body.sandbox_id).toBeDefined()
    expect((body.sandbox_id as string).startsWith('sb_')).toBe(true)
    expect(body.status).toBe('queued')
    expect(body.queue_position).toBe(0)
    expect(body.estimated_ready_seconds).toBe(2)
    expect(body.replay_url).toBeDefined()
    expect(body.created_at).toBeDefined()
  })

  test('creates a sandbox with custom profile and env', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post('/v1/sandboxes').pipe(
            HttpClientRequest.bodyUnsafeJson({
              profile: 'medium',
              env: { NODE_ENV: 'test' },
              ttl_seconds: 1800,
            }),
          ),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(201)
    const body = result.body as Record<string, unknown>
    expect(body.status).toBe('queued')
  })

  test('rejects invalid profile', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post('/v1/sandboxes').pipe(
            HttpClientRequest.bodyUnsafeJson({ profile: 'xlarge' }),
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

  test('rejects invalid ttl_seconds', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post('/v1/sandboxes').pipe(
            HttpClientRequest.bodyUnsafeJson({ ttl_seconds: 0 }),
          ),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(400)
  })

  test('rejects unknown image', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post('/v1/sandboxes').pipe(
            HttpClientRequest.bodyUnsafeJson({ image: 'nonexistent-image' }),
          ),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(400)
    const body = result.body as Record<string, unknown>
    expect(body.error).toBe('validation_error')
    expect((body.message as string)).toContain('nonexistent-image')
  })
})

// ---------------------------------------------------------------------------
// Get sandbox
// ---------------------------------------------------------------------------

describe('GET /v1/sandboxes/:id — get sandbox', () => {
  test('returns sandbox details after creation', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        // Create a sandbox first
        const createRes = yield* client.execute(
          HttpClientRequest.post('/v1/sandboxes').pipe(
            HttpClientRequest.bodyUnsafeJson({ env: { CI: '1' } }),
          ),
        )
        const created = (yield* createRes.json) as { sandbox_id: string }

        // Get it back
        const getRes = yield* client.execute(
          HttpClientRequest.get(`/v1/sandboxes/${created.sandbox_id}`),
        )
        const body = yield* getRes.json
        return { status: getRes.status, body }
      }),
    )

    expect(result.status).toBe(200)
    const body = result.body as Record<string, unknown>
    expect(body.sandbox_id).toBeDefined()
    expect(body.status).toBe('queued')
    expect(body.profile).toBe('small')
    expect(body.image).toBe('sandchest://ubuntu-22.04')
    expect(body.env).toEqual({ CI: '1' })
    expect(body.forked_from).toBeNull()
    expect(body.fork_count).toBe(0)
    expect(body.failure_reason).toBeNull()
  })

  test('returns 404 for unknown sandbox', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get('/v1/sandboxes/sb_0000000000000000000000'),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(404)
    const body = result.body as Record<string, unknown>
    expect(body.error).toBe('not_found')
  })

  test('returns 400 for invalid sandbox ID', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get('/v1/sandboxes/invalid'),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// List sandboxes
// ---------------------------------------------------------------------------

describe('GET /v1/sandboxes — list sandboxes', () => {
  test('returns empty list when no sandboxes exist', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get('/v1/sandboxes'),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(200)
    const body = result.body as { sandboxes: unknown[]; next_cursor: unknown }
    expect(body.sandboxes).toBeArray()
    expect(body.next_cursor).toBeNull()
  })

  test('returns created sandboxes', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        // Create two sandboxes
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

        // List them
        const response = yield* client.execute(
          HttpClientRequest.get('/v1/sandboxes'),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(200)
    const body = result.body as { sandboxes: unknown[] }
    expect(body.sandboxes.length).toBeGreaterThanOrEqual(2)
  })

  test('filters by status', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        // Create a sandbox (status: queued)
        yield* client.execute(
          HttpClientRequest.post('/v1/sandboxes').pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )

        // Filter for running (should return empty)
        const response = yield* client.execute(
          HttpClientRequest.get('/v1/sandboxes?status=running'),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(200)
    const body = result.body as { sandboxes: unknown[] }
    expect(body.sandboxes).toEqual([])
  })

  test('rejects invalid limit', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get('/v1/sandboxes?limit=999'),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Stop sandbox
// ---------------------------------------------------------------------------

describe('POST /v1/sandboxes/:id/stop — stop sandbox', () => {
  test('transitions sandbox to stopping', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        // Create a sandbox
        const createRes = yield* client.execute(
          HttpClientRequest.post('/v1/sandboxes').pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        const created = (yield* createRes.json) as { sandbox_id: string }

        // Stop it
        const stopRes = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${created.sandbox_id}/stop`),
        )
        const body = yield* stopRes.json
        return { status: stopRes.status, body }
      }),
    )

    expect(result.status).toBe(202)
    const body = result.body as Record<string, unknown>
    expect(body.sandbox_id).toBeDefined()
    expect(body.status).toBe('stopping')
  })

  test('stopping already-stopping sandbox returns 202', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        // Create and stop
        const createRes = yield* client.execute(
          HttpClientRequest.post('/v1/sandboxes').pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        const created = (yield* createRes.json) as { sandbox_id: string }
        yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${created.sandbox_id}/stop`),
        )

        // Stop again
        const stopRes = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${created.sandbox_id}/stop`),
        )
        const body = yield* stopRes.json
        return { status: stopRes.status, body }
      }),
    )

    expect(result.status).toBe(202)
  })

  test('returns 404 for unknown sandbox', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post('/v1/sandboxes/sb_0000000000000000000000/stop'),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Delete sandbox
// ---------------------------------------------------------------------------

describe('DELETE /v1/sandboxes/:id — delete sandbox', () => {
  test('soft-deletes a sandbox', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        // Create
        const createRes = yield* client.execute(
          HttpClientRequest.post('/v1/sandboxes').pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        const created = (yield* createRes.json) as { sandbox_id: string }

        // Delete
        const delRes = yield* client.execute(
          HttpClientRequest.del(`/v1/sandboxes/${created.sandbox_id}`),
        )
        const body = yield* delRes.json
        return { status: delRes.status, body, sandboxId: created.sandbox_id }
      }),
    )

    expect(result.status).toBe(200)
    const body = result.body as Record<string, unknown>
    expect(body.sandbox_id).toBe(result.sandboxId)
    expect(body.status).toBe('deleted')
  })

  test('deleting already-deleted sandbox is idempotent', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        // Create and delete
        const createRes = yield* client.execute(
          HttpClientRequest.post('/v1/sandboxes').pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        const created = (yield* createRes.json) as { sandbox_id: string }
        yield* client.execute(
          HttpClientRequest.del(`/v1/sandboxes/${created.sandbox_id}`),
        )

        // Delete again
        const delRes = yield* client.execute(
          HttpClientRequest.del(`/v1/sandboxes/${created.sandbox_id}`),
        )
        const body = yield* delRes.json
        return { status: delRes.status, body }
      }),
    )

    expect(result.status).toBe(200)
    const body = result.body as Record<string, unknown>
    expect(body.status).toBe('deleted')
  })

  test('deleted sandbox does not appear in list', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        // Create and delete
        const createRes = yield* client.execute(
          HttpClientRequest.post('/v1/sandboxes').pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        const created = (yield* createRes.json) as { sandbox_id: string }
        yield* client.execute(
          HttpClientRequest.del(`/v1/sandboxes/${created.sandbox_id}`),
        )

        // List (should not include deleted)
        const listRes = yield* client.execute(
          HttpClientRequest.get('/v1/sandboxes'),
        )
        const body = yield* listRes.json
        return { body, deletedId: created.sandbox_id }
      }),
    )

    const body = result.body as { sandboxes: Array<{ sandbox_id: string }> }
    const ids = body.sandboxes.map((s) => s.sandbox_id)
    expect(ids).not.toContain(result.deletedId)
  })

  test('returns 404 for unknown sandbox', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.del('/v1/sandboxes/sb_0000000000000000000000'),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Route stubs (remaining endpoints)
// ---------------------------------------------------------------------------

describe('Route stubs', () => {
  test('POST /v1/sandboxes/:id/sessions returns 501', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post('/v1/sandboxes/sb_test123/sessions'),
        )
        return response.status
      }),
    )

    expect(result).toBe(501)
  })
})

// ---------------------------------------------------------------------------
// Error response format
// ---------------------------------------------------------------------------

describe('Error response format', () => {
  test('error responses include standard envelope fields', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get('/v1/sandboxes/sb_0000000000000000000000'),
        )
        const body = (yield* response.json) as Record<string, unknown>
        return body
      }),
    )

    expect(result).toHaveProperty('error')
    expect(result).toHaveProperty('message')
    expect(result).toHaveProperty('request_id')
    expect(result).toHaveProperty('retry_after')
  })
})
