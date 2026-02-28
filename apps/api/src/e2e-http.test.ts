import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Effect, Layer, Scope, Exit } from 'effect'
import { HttpMiddleware, HttpServer, HttpServerRequest } from '@effect/platform'
import { NodeHttpServer } from '@effect/platform-node'
import { ApiRouter } from './server.js'
import { AuthContext } from './context.js'
import { withRequestId } from './middleware.js'
import { withRateLimit } from './middleware/rate-limit.js'
import { withSecurityHeaders } from './middleware/security-headers.js'
import { SandboxRepo } from './services/sandbox-repo.js'
import { ExecRepo } from './services/exec-repo.js'
import { SessionRepo } from './services/session-repo.js'
import { ObjectStorage } from './services/object-storage.js'
import { NodeClient } from './services/node-client.js'
import { ArtifactRepo } from './services/artifact-repo.js'
import { RedisService } from './services/redis.js'
import { QuotaService } from './services/quota.js'
import { BillingService } from './services/billing.js'
import { createInMemorySandboxRepo } from './services/sandbox-repo.memory.js'
import { createInMemoryExecRepo } from './services/exec-repo.memory.js'
import { createInMemorySessionRepo } from './services/session-repo.memory.js'
import { createInMemoryObjectStorage } from './services/object-storage.memory.js'
import { createInMemoryNodeClient } from './services/node-client.memory.js'
import { createInMemoryRedisApi } from './services/redis.memory.js'
import { createInMemoryArtifactRepo } from './services/artifact-repo.memory.js'
import { createInMemoryQuotaApi } from './services/quota.memory.js'
import { createInMemoryBillingApi } from './services/billing.memory.js'
import { AuditLog } from './services/audit-log.js'
import { createInMemoryAuditLog } from './services/audit-log.memory.js'
import { NodeRepo } from './services/node-repo.js'
import { createInMemoryNodeRepo } from './services/node-repo.memory.js'
import { MetricsRepo } from './services/metrics-repo.js'
import { createInMemoryMetricsRepo } from './services/metrics-repo.memory.js'
import { JsonLoggerLive } from './logger.js'
import { ShutdownControllerLive } from './shutdown.js'
import { idToBytes } from '@sandchest/contract'
import type { SandboxRepoApi } from './services/sandbox-repo.js'
import type { QuotaApi } from './services/quota.js'

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_ORG = 'test_org_http_e2e'
const TEST_USER = 'test_user_http_e2e'

// ---------------------------------------------------------------------------
// Test auth middleware — bypasses BetterAuth
// ---------------------------------------------------------------------------

const withTestAuth = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (
      request.url.startsWith('/health') ||
      request.url.startsWith('/readyz') ||
      request.url.startsWith('/api/auth') ||
      request.url.startsWith('/v1/public/') ||
      request.url.startsWith('/v1/internal/')
    ) {
      return yield* Effect.provideService(app, AuthContext, { userId: '', orgId: '', scopes: null })
    }
    return yield* Effect.provideService(app, AuthContext, {
      userId: TEST_USER,
      orgId: TEST_ORG,
      scopes: null,
    })
  }),
)

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let scope: Scope.CloseableScope
let baseUrl: string
let sandboxRepo: SandboxRepoApi

beforeAll(async () => {
  const nodeServer = createServer()
  sandboxRepo = createInMemorySandboxRepo()
  const quotaApi = createInMemoryQuotaApi() as QuotaApi & { setOrgQuota: (orgId: string, quota: Record<string, number>) => void }
  quotaApi.setOrgQuota(TEST_ORG, { maxConcurrentSandboxes: 100 })
  const billingApi = createInMemoryBillingApi()

  const TestApp = ApiRouter.pipe(
    withRateLimit,
    withTestAuth,
    withRequestId,
    withSecurityHeaders,
    HttpServer.serve(),
  )

  const services = Layer.mergeAll(
    Layer.succeed(SandboxRepo, sandboxRepo),
    Layer.succeed(ExecRepo, createInMemoryExecRepo()),
    Layer.succeed(SessionRepo, createInMemorySessionRepo()),
    Layer.succeed(ObjectStorage, createInMemoryObjectStorage()),
    Layer.succeed(NodeClient, createInMemoryNodeClient()),
    Layer.succeed(ArtifactRepo, createInMemoryArtifactRepo()),
    Layer.succeed(RedisService, createInMemoryRedisApi()),
    Layer.succeed(QuotaService, quotaApi),
    Layer.succeed(BillingService, billingApi),
    Layer.succeed(AuditLog, createInMemoryAuditLog()),
    Layer.succeed(NodeRepo, createInMemoryNodeRepo()),
    Layer.succeed(MetricsRepo, createInMemoryMetricsRepo()),
  )

  const FullLayer = TestApp.pipe(
    Layer.provide(services),
    Layer.provide(ShutdownControllerLive),
    Layer.provide(NodeHttpServer.layer(() => nodeServer, { port: 0 })),
    Layer.provide(JsonLoggerLive),
  )

  scope = Effect.runSync(Scope.make())
  await Effect.runPromise(Layer.buildWithScope(FullLayer, scope))

  const addr = nodeServer.address() as AddressInfo
  baseUrl = `http://localhost:${addr.port}`
})

afterAll(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void))
})

/** Create a sandbox via HTTP (auto-transitions to running via node daemon). */
async function createRunningSandbox(): Promise<string> {
  const res = await fetch(`${baseUrl}/v1/sandboxes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  const data = (await res.json()) as { sandbox_id: string }
  return data.sandbox_id
}

// ---------------------------------------------------------------------------
// Health endpoints — real HTTP
// ---------------------------------------------------------------------------

describe('HTTP E2E: health', () => {
  test('GET /health returns 200', async () => {
    const res = await fetch(`${baseUrl}/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string }
    expect(body.status).toBe('ok')
  })

  test('GET /healthz returns 200', async () => {
    const res = await fetch(`${baseUrl}/healthz`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string }
    expect(body.status).toBe('ok')
  })

  test('GET /readyz checks Redis', async () => {
    const res = await fetch(`${baseUrl}/readyz`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; checks: { redis: string } }
    expect(body.status).toBe('ok')
    expect(body.checks.redis).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// Middleware pipeline headers — real HTTP
// ---------------------------------------------------------------------------

describe('HTTP E2E: middleware pipeline', () => {
  test('responses include x-request-id', async () => {
    const res = await fetch(`${baseUrl}/health`)
    expect(res.headers.get('x-request-id')).toBeTruthy()
  })

  test('propagates incoming x-request-id', async () => {
    const id = 'test-req-abc-123'
    const res = await fetch(`${baseUrl}/health`, {
      headers: { 'x-request-id': id },
    })
    expect(res.headers.get('x-request-id')).toBe(id)
  })

  test('includes HSTS header', async () => {
    const res = await fetch(`${baseUrl}/health`)
    const hsts = res.headers.get('strict-transport-security')
    expect(hsts).toContain('max-age=')
    expect(hsts).toContain('includeSubDomains')
  })

  test('CORS headers for allowed origin', async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { origin: 'https://sandchest.com' },
    })
    expect(res.headers.get('access-control-allow-origin')).toBe('https://sandchest.com')
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    expect(res.headers.get('access-control-expose-headers')).toContain('X-Request-Id')
  })

  test('CORS headers for localhost', async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { origin: 'http://localhost:3000' },
    })
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000')
  })

  test('no CORS headers for disallowed origin', async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { origin: 'https://evil.example.com' },
    })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  test('OPTIONS preflight returns 204 with CORS', async () => {
    const res = await fetch(`${baseUrl}/v1/sandboxes`, {
      method: 'OPTIONS',
      headers: { origin: 'https://sandchest.com' },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://sandchest.com')
    expect(res.headers.get('access-control-allow-methods')).toContain('GET')
  })

  test('rate limit headers on sandbox API calls', async () => {
    const id = await createRunningSandbox()
    const res = await fetch(`${baseUrl}/v1/sandboxes/${id}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-ratelimit-limit')).toBeTruthy()
    expect(res.headers.get('x-ratelimit-remaining')).toBeTruthy()
    expect(res.headers.get('x-ratelimit-reset')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Sandbox CRUD — real HTTP
// ---------------------------------------------------------------------------

describe('HTTP E2E: sandbox CRUD', () => {
  test('create sandbox returns 201 with sandbox_id', async () => {
    const res = await fetch(`${baseUrl}/v1/sandboxes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ env: { FOO: 'bar' } }),
    })
    expect(res.status).toBe(201)

    const body = (await res.json()) as {
      sandbox_id: string
      status: string
      replay_url: string
      created_at: string
    }
    expect(body.sandbox_id).toMatch(/^sb_/)
    expect(body.status).toBe('running')
    expect(body.replay_url).toContain(body.sandbox_id)
    expect(body.created_at).toBeTruthy()
    expect(res.headers.get('x-replay-access')).toBe('public')
  })

  test('get sandbox returns full details', async () => {
    const id = await createRunningSandbox()
    const res = await fetch(`${baseUrl}/v1/sandboxes/${id}`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      sandbox_id: string
      status: string
      image: string
      profile: string
    }
    expect(body.sandbox_id).toBe(id)
    expect(body.status).toBe('running')
    expect(body.image).toContain('ubuntu')
    expect(body.profile).toBe('small')
  })

  test('list sandboxes returns array', async () => {
    await createRunningSandbox()
    const res = await fetch(`${baseUrl}/v1/sandboxes`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      sandboxes: Array<{ sandbox_id: string }>
      next_cursor: string | null
    }
    expect(body.sandboxes.length).toBeGreaterThan(0)
  })

  test('stop sandbox returns 202', async () => {
    const id = await createRunningSandbox()
    const res = await fetch(`${baseUrl}/v1/sandboxes/${id}/stop`, { method: 'POST' })
    expect(res.status).toBe(202)

    const body = (await res.json()) as { sandbox_id: string; status: string }
    expect(body.sandbox_id).toBe(id)
    expect(body.status).toBe('stopping')
  })

  test('delete sandbox returns 200', async () => {
    const id = await createRunningSandbox()
    const res = await fetch(`${baseUrl}/v1/sandboxes/${id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)

    const body = (await res.json()) as { sandbox_id: string; status: string }
    expect(body.status).toBe('deleted')
  })

  test('get non-existent sandbox returns 404', async () => {
    const res = await fetch(`${baseUrl}/v1/sandboxes/sb_000000000000000000000000`)
    expect(res.status).toBe(404)

    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBeDefined()
    expect(body.message).toBeDefined()
  })

  test('invalid profile returns 400', async () => {
    const res = await fetch(`${baseUrl}/v1/sandboxes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'gigantic' }),
    })
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Exec — real HTTP
// ---------------------------------------------------------------------------

describe('HTTP E2E: exec', () => {
  test('exec on running sandbox returns result', async () => {
    const id = await createRunningSandbox()
    const res = await fetch(`${baseUrl}/v1/sandboxes/${id}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: ['echo', 'hello'] }),
    })
    expect(res.status).toBe(200)

    const body = (await res.json()) as { exec_id: string; status: string }
    expect(body.exec_id).toMatch(/^ex_/)
  })

  test('exec on stopped sandbox returns 409', async () => {
    const id = await createRunningSandbox()
    await fetch(`${baseUrl}/v1/sandboxes/${id}/stop`, { method: 'POST' })

    const res = await fetch(`${baseUrl}/v1/sandboxes/${id}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'echo fail' }),
    })
    expect(res.status).toBe(409)
  })
})

// ---------------------------------------------------------------------------
// Fork — real HTTP
// ---------------------------------------------------------------------------

describe('HTTP E2E: fork', () => {
  test('fork creates new sandbox linked to parent', async () => {
    const parentId = await createRunningSandbox()
    const res = await fetch(`${baseUrl}/v1/sandboxes/${parentId}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(201)

    const body = (await res.json()) as {
      sandbox_id: string
      forked_from: string
      status: string
    }
    expect(body.sandbox_id).toMatch(/^sb_/)
    expect(body.forked_from).toBe(parentId)
    expect(body.status).toBe('running')
  })
})

// ---------------------------------------------------------------------------
// Replay — real HTTP
// ---------------------------------------------------------------------------

describe('HTTP E2E: replay', () => {
  test('replay bundle includes version and fork tree', async () => {
    const id = await createRunningSandbox()
    const res = await fetch(`${baseUrl}/v1/sandboxes/${id}/replay`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      version: number
      sandbox_id: string
      status: string
      fork_tree: { sandbox_id: string; children: unknown[] }
      events_url: string
    }
    expect(body.version).toBe(1)
    expect(body.sandbox_id).toBe(id)
    expect(body.status).toBe('in_progress')
    expect(body.fork_tree.sandbox_id).toBe(id)
    expect(body.events_url).toBeTruthy()
  })

  test('replay response includes x-replay-access header', async () => {
    const id = await createRunningSandbox()
    const res = await fetch(`${baseUrl}/v1/sandboxes/${id}/replay`)
    expect(res.headers.get('x-replay-access')).toBe('public')
  })
})

// ---------------------------------------------------------------------------
// Full lifecycle — real HTTP
// ---------------------------------------------------------------------------

describe('HTTP E2E: full lifecycle', () => {
  test('create → exec → fork → stop → delete', async () => {
    // 1. Create
    const createRes = await fetch(`${baseUrl}/v1/sandboxes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ env: { TEST: '1' } }),
    })
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()) as { sandbox_id: string }
    const id = created.sandbox_id

    // Transition to running
    await Effect.runPromise(
      sandboxRepo.updateStatus(idToBytes(id), TEST_ORG, 'running'),
    )

    // 2. Exec
    const execRes = await fetch(`${baseUrl}/v1/sandboxes/${id}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: ['echo', 'lifecycle'] }),
    })
    expect(execRes.status).toBe(200)

    // 3. Fork
    const forkRes = await fetch(`${baseUrl}/v1/sandboxes/${id}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(forkRes.status).toBe(201)
    const forked = (await forkRes.json()) as { sandbox_id: string }

    // 4. Stop original
    const stopRes = await fetch(`${baseUrl}/v1/sandboxes/${id}/stop`, { method: 'POST' })
    expect(stopRes.status).toBe(202)

    // 5. Stop fork
    const stopForkRes = await fetch(`${baseUrl}/v1/sandboxes/${forked.sandbox_id}/stop`, {
      method: 'POST',
    })
    expect(stopForkRes.status).toBe(202)

    // 6. Delete original
    const deleteRes = await fetch(`${baseUrl}/v1/sandboxes/${id}`, { method: 'DELETE' })
    expect(deleteRes.status).toBe(200)
    const deleted = (await deleteRes.json()) as { status: string }
    expect(deleted.status).toBe('deleted')
  })
})
