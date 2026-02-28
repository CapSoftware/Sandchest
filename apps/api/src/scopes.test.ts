import { HttpClient, HttpClientRequest } from '@effect/platform'
import { NodeHttpServer } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { describe, expect, test } from 'bun:test'
import { AppLive } from './server.js'
import { AuthContext } from './context.js'
import { SandboxRepo } from './services/sandbox-repo.js'
import { ExecRepo } from './services/exec-repo.js'
import { SessionRepo } from './services/session-repo.js'
import { ObjectStorage } from './services/object-storage.js'
import { NodeClient } from './services/node-client.js'
import { RedisService } from './services/redis.js'
import { createInMemorySandboxRepo } from './services/sandbox-repo.memory.js'
import { createInMemoryExecRepo } from './services/exec-repo.memory.js'
import { createInMemorySessionRepo } from './services/session-repo.memory.js'
import { createInMemoryObjectStorage } from './services/object-storage.memory.js'
import { createInMemoryNodeClient } from './services/node-client.memory.js'
import { createInMemoryRedisApi } from './services/redis.memory.js'
import { ArtifactRepo } from './services/artifact-repo.js'
import { createInMemoryArtifactRepo } from './services/artifact-repo.memory.js'
import { QuotaService } from './services/quota.js'
import { createInMemoryQuotaApi } from './services/quota.memory.js'
import { BillingService } from './services/billing.js'
import { createInMemoryBillingApi } from './services/billing.memory.js'
import { AuditLogMemory } from './services/audit-log.memory.js'
import { NodeRepo } from './services/node-repo.js'
import { createInMemoryNodeRepo } from './services/node-repo.memory.js'
import { MetricsRepo } from './services/metrics-repo.js'
import { createInMemoryMetricsRepo } from './services/metrics-repo.memory.js'
import { ShutdownControllerLive } from './shutdown.js'
import { idToBytes } from '@sandchest/contract'
import type { ApiKeyScope } from '@sandchest/contract'

const TEST_ORG = 'org_scope_test'
const TEST_USER = 'user_scope_test'

function createTestEnv(scopes: readonly ApiKeyScope[] | null) {
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
      Layer.succeed(AuthContext, { userId: TEST_USER, orgId: TEST_ORG, scopes }),
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
// Full access (null scopes) — backward compatibility
// ---------------------------------------------------------------------------

describe('scope enforcement — null scopes (full access)', () => {
  test('null scopes allow sandbox creation', async () => {
    const env = createTestEnv(null)
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

  test('null scopes allow listing sandboxes', async () => {
    const env = createTestEnv(null)
    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get('/v1/sandboxes'),
        )
        return { status: response.status }
      }),
    )
    expect(result.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Scoped API key — sandbox operations
// ---------------------------------------------------------------------------

describe('scope enforcement — sandbox scopes', () => {
  test('sandbox:read allows GET /v1/sandboxes', async () => {
    const env = createTestEnv(['sandbox:read'])
    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get('/v1/sandboxes'),
        )
        return { status: response.status }
      }),
    )
    expect(result.status).toBe(200)
  })

  test('sandbox:read alone rejects POST /v1/sandboxes', async () => {
    const env = createTestEnv(['sandbox:read'])
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
    expect(result.body.error).toBe('forbidden')
    expect(result.body.message).toContain('sandbox:create')
  })

  test('sandbox:create allows POST /v1/sandboxes', async () => {
    const env = createTestEnv(['sandbox:create'])
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

  test('sandbox:write allows POST /v1/sandboxes/:id/stop', async () => {
    // Need both sandbox:create (to create a sandbox) and sandbox:write (to stop it)
    const env = createTestEnv(['sandbox:create', 'sandbox:write'])
    const sandboxId = await createRunningSandbox(env)

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
  })

  test('missing sandbox:write rejects DELETE /v1/sandboxes/:id', async () => {
    const env = createTestEnv(['sandbox:create', 'sandbox:read'])
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.del(`/v1/sandboxes/${sandboxId}`),
        )
        const body = yield* response.json
        return { status: response.status, body: body as { error: string; message: string } }
      }),
    )
    expect(result.status).toBe(403)
    expect(result.body.message).toContain('sandbox:write')
  })
})

// ---------------------------------------------------------------------------
// Scoped API key — exec operations
// ---------------------------------------------------------------------------

describe('scope enforcement — exec scopes', () => {
  test('exec:create allows POST /v1/sandboxes/:id/exec', async () => {
    const env = createTestEnv(['sandbox:create', 'exec:create'])
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/exec`).pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: 'echo hello' }),
          ),
        )
        return { status: response.status }
      }),
    )
    expect(result.status).toBe(200)
  })

  test('missing exec:create rejects POST /v1/sandboxes/:id/exec', async () => {
    const env = createTestEnv(['sandbox:create', 'exec:read'])
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/exec`).pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: 'echo hello' }),
          ),
        )
        const body = yield* response.json
        return { status: response.status, body: body as { error: string; message: string } }
      }),
    )
    expect(result.status).toBe(403)
    expect(result.body.message).toContain('exec:create')
  })
})

// ---------------------------------------------------------------------------
// Scoped API key — file operations
// ---------------------------------------------------------------------------

describe('scope enforcement — file scopes', () => {
  test('missing file:read rejects GET /v1/sandboxes/:id/files', async () => {
    const env = createTestEnv(['sandbox:create', 'file:write'])
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get(`/v1/sandboxes/${sandboxId}/files?path=/tmp&list=true`),
        )
        const body = yield* response.json
        return { status: response.status, body: body as { error: string; message: string } }
      }),
    )
    expect(result.status).toBe(403)
    expect(result.body.message).toContain('file:read')
  })
})

// ---------------------------------------------------------------------------
// Scoped API key — session operations
// ---------------------------------------------------------------------------

describe('scope enforcement — session scopes', () => {
  test('session:create allows POST /v1/sandboxes/:id/sessions', async () => {
    const env = createTestEnv(['sandbox:create', 'session:create'])
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/sessions`).pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        return { status: response.status }
      }),
    )
    expect(result.status).toBe(201)
  })

  test('missing session:create rejects POST /v1/sandboxes/:id/sessions', async () => {
    const env = createTestEnv(['sandbox:create', 'session:read'])
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
        return { status: response.status, body: body as { error: string; message: string } }
      }),
    )
    expect(result.status).toBe(403)
    expect(result.body.message).toContain('session:create')
  })
})

// ---------------------------------------------------------------------------
// Scoped API key — artifact operations
// ---------------------------------------------------------------------------

describe('scope enforcement — artifact scopes', () => {
  test('missing artifact:write rejects POST /v1/sandboxes/:id/artifacts', async () => {
    const env = createTestEnv(['sandbox:create', 'artifact:read'])
    const sandboxId = await createRunningSandbox(env)

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/artifacts`).pipe(
            HttpClientRequest.bodyUnsafeJson({ paths: ['/tmp/out.txt'] }),
          ),
        )
        const body = yield* response.json
        return { status: response.status, body: body as { error: string; message: string } }
      }),
    )
    expect(result.status).toBe(403)
    expect(result.body.message).toContain('artifact:write')
  })
})

// ---------------------------------------------------------------------------
// Empty scopes array — should deny everything
// ---------------------------------------------------------------------------

describe('scope enforcement — empty scopes array', () => {
  test('empty scopes array rejects all operations', async () => {
    const env = createTestEnv([])
    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get('/v1/sandboxes'),
        )
        const body = yield* response.json
        return { status: response.status, body: body as { error: string } }
      }),
    )
    expect(result.status).toBe(403)
    expect(result.body.error).toBe('forbidden')
  })
})
