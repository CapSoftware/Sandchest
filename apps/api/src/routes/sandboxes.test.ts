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
import { idToBytes } from '@sandchest/contract'
import type { ReplayBundle } from '@sandchest/contract'

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
    Layer.provide(
      Layer.succeed(AuthContext, { userId: TEST_USER, orgId: TEST_ORG }),
    ),
  )

  function runTest<A>(effect: Effect.Effect<A, unknown, HttpClient.HttpClient>) {
    return effect.pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise)
  }

  return { runTest, sandboxRepo, execRepo, sessionRepo }
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
})
