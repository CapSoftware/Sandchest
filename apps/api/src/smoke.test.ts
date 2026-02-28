import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
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
import { AuditLog } from './services/audit-log.js'
import { createInMemorySandboxRepo } from './services/sandbox-repo.memory.js'
import { createInMemoryExecRepo } from './services/exec-repo.memory.js'
import { createInMemorySessionRepo } from './services/session-repo.memory.js'
import { createInMemoryObjectStorage } from './services/object-storage.memory.js'
import { createInMemoryNodeClient } from './services/node-client.memory.js'
import { createInMemoryRedisApi } from './services/redis.memory.js'
import { createInMemoryArtifactRepo } from './services/artifact-repo.memory.js'
import { createInMemoryQuotaApi } from './services/quota.memory.js'
import { createInMemoryBillingApi } from './services/billing.memory.js'
import { createInMemoryAuditLog } from './services/audit-log.memory.js'
import { NodeRepo } from './services/node-repo.js'
import { createInMemoryNodeRepo } from './services/node-repo.memory.js'
import { MetricsRepo } from './services/metrics-repo.js'
import { createInMemoryMetricsRepo } from './services/metrics-repo.memory.js'
import { JsonLoggerLive } from './logger.js'
import { ShutdownControllerLive } from './shutdown.js'
import type { RedisApi, BufferedEvent } from './services/redis.js'
import type { ObjectStorageApi } from './services/object-storage.js'
import type { NodeClientApi } from './services/node-client.js'
import type { QuotaApi } from './services/quota.js'

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_ORG = 'test_org_smoke'
const TEST_USER = 'test_user_smoke'

// ---------------------------------------------------------------------------
// 10. Redis Operations Smoke Test
// ---------------------------------------------------------------------------

describe('smoke: Redis operations', () => {
  let redis: RedisApi

  beforeEach(() => {
    redis = createInMemoryRedisApi()
  })

  function run<A>(effect: Effect.Effect<A, never, never>): Promise<A> {
    return Effect.runPromise(effect)
  }

  test('ping returns true', async () => {
    expect(await run(redis.ping())).toBe(true)
  })

  test('slot lease acquire/release cycle', async () => {
    expect(await run(redis.acquireSlotLease('n1', 0, 'sb_1', 60))).toBe(true)
    expect(await run(redis.acquireSlotLease('n1', 0, 'sb_2', 60))).toBe(false)
    await run(redis.releaseSlotLease('n1', 0))
    expect(await run(redis.acquireSlotLease('n1', 0, 'sb_2', 60))).toBe(true)
  })

  test('rate limiter enforces limits', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await run(redis.checkRateLimit('org', 'create', 3, 60))
      expect(r.allowed).toBe(true)
    }
    const denied = await run(redis.checkRateLimit('org', 'create', 3, 60))
    expect(denied.allowed).toBe(false)
  })

  test('event buffering round-trip', async () => {
    const event: BufferedEvent = { seq: 1, ts: '2026-01-01T00:00:00Z', data: { type: 'stdout' } }
    await run(redis.pushExecEvent('ex_1', event, 300))
    const events = await run(redis.getExecEvents('ex_1', 0))
    expect(events).toEqual([event])
  })

  test('node heartbeat register and check', async () => {
    expect(await run(redis.hasNodeHeartbeat('node_1'))).toBe(false)
    await run(redis.registerNodeHeartbeat('node_1', 60))
    expect(await run(redis.hasNodeHeartbeat('node_1'))).toBe(true)
  })

  test('leader election acquires lock', async () => {
    expect(await run(redis.acquireLeaderLock('ttl', 'inst_1', 5000))).toBe(true)
    expect(await run(redis.acquireLeaderLock('ttl', 'inst_2', 5000))).toBe(false)
    expect(await run(redis.acquireLeaderLock('ttl', 'inst_1', 5000))).toBe(true)
  })

  test('artifact paths add and retrieve', async () => {
    await run(redis.addArtifactPaths('sb_1', ['/tmp/a.txt', '/tmp/b.txt']))
    const paths = await run(redis.getArtifactPaths('sb_1'))
    expect(paths).toContain('/tmp/a.txt')
    expect(paths).toContain('/tmp/b.txt')
    expect(await run(redis.countArtifactPaths('sb_1'))).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 11. S3 Object Storage Smoke Test
// ---------------------------------------------------------------------------

describe('smoke: S3 object storage operations', () => {
  let storage: ObjectStorageApi

  beforeEach(() => {
    storage = createInMemoryObjectStorage()
  })

  function run<A>(effect: Effect.Effect<A, never, never>): Promise<A> {
    return Effect.runPromise(effect)
  }

  test('put and get object round-trip', async () => {
    await run(storage.putObject('artifacts/test.txt', 'hello world'))
    const content = await run(storage.getObject('artifacts/test.txt'))
    expect(content).toBe('hello world')
  })

  test('get non-existent object returns null', async () => {
    const content = await run(storage.getObject('missing/key'))
    expect(content).toBeNull()
  })

  test('delete removes object', async () => {
    await run(storage.putObject('tmp/upload.bin', 'data'))
    await run(storage.deleteObject('tmp/upload.bin'))
    const content = await run(storage.getObject('tmp/upload.bin'))
    expect(content).toBeNull()
  })

  test('presigned URL contains key and expiration', async () => {
    const url = await run(storage.getPresignedUrl('events/log.json', 3600))
    expect(url).toContain('events/log.json')
    expect(url).toContain('3600')
  })

  test('put overwrites existing object', async () => {
    await run(storage.putObject('key', 'v1'))
    await run(storage.putObject('key', 'v2'))
    const content = await run(storage.getObject('key'))
    expect(content).toBe('v2')
  })

  test('binary data round-trip via Uint8Array', async () => {
    const data = new Uint8Array([72, 101, 108, 108, 111])
    await run(storage.putObject('bin/data', data))
    const content = await run(storage.getObject('bin/data'))
    expect(content).toBe('Hello')
  })
})

// ---------------------------------------------------------------------------
// 12. Node Client (gRPC Stub) Smoke Test
// ---------------------------------------------------------------------------

describe('smoke: node client gRPC operations', () => {
  let nodeClient: NodeClientApi

  beforeEach(() => {
    nodeClient = createInMemoryNodeClient()
  })

  function run<A>(effect: Effect.Effect<A, never, never>): Promise<A> {
    return Effect.runPromise(effect)
  }

  const sandboxId = new Uint8Array(16)

  test('exec returns successful result', async () => {
    const result = await run(
      nodeClient.exec({
        sandboxId,
        execId: 'ex_1',
        cmd: ['echo', 'hello'],
        cwd: '/work',
        env: {},
        timeoutSeconds: 30,
      }),
    )
    expect(result.exitCode).toBe(0)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.cpuMs).toBeGreaterThanOrEqual(0)
    expect(result.peakMemoryBytes).toBeGreaterThanOrEqual(0)
  })

  test('session lifecycle: create, exec, input, destroy', async () => {
    await run(
      nodeClient.createSession({
        sandboxId,
        sessionId: 'sess_1',
        shell: '/bin/bash',
        env: {},
      }),
    )

    const execResult = await run(
      nodeClient.sessionExec({
        sandboxId,
        sessionId: 'sess_1',
        cmd: 'ls',
        timeoutSeconds: 10,
      }),
    )
    expect(execResult.exitCode).toBe(0)

    await run(
      nodeClient.sessionInput({
        sandboxId,
        sessionId: 'sess_1',
        data: 'echo test\n',
      }),
    )

    await run(
      nodeClient.destroySession({
        sandboxId,
        sessionId: 'sess_1',
      }),
    )
  })

  test('file operations: put, get, list, delete', async () => {
    const data = new TextEncoder().encode('file content')

    const { bytesWritten } = await run(
      nodeClient.putFile({ sandboxId, path: '/work/test.txt', data }),
    )
    expect(bytesWritten).toBe(data.length)

    const retrieved = await run(
      nodeClient.getFile({ sandboxId, path: '/work/test.txt' }),
    )
    expect(new TextDecoder().decode(retrieved)).toBe('file content')

    const files = await run(
      nodeClient.listFiles({ sandboxId, path: '/work' }),
    )
    expect(files.length).toBeGreaterThan(0)

    await run(nodeClient.deleteFile({ sandboxId, path: '/work/test.txt' }))
  })

  test('fork sandbox completes without error', async () => {
    await run(
      nodeClient.forkSandbox({
        sourceSandboxId: sandboxId,
        newSandboxId: new Uint8Array(16).fill(1),
      }),
    )
  })

  test('collect artifacts returns results for existing files', async () => {
    const data = new TextEncoder().encode('artifact data')
    await run(nodeClient.putFile({ sandboxId, path: '/work/output.txt', data }))

    const artifacts = await run(
      nodeClient.collectArtifacts({
        sandboxId,
        paths: ['/work/output.txt'],
      }),
    )
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0].name).toBe('output.txt')
    expect(artifacts[0].bytes).toBe(data.length)
  })
})

// ---------------------------------------------------------------------------
// 13. API Health Endpoints — Full HTTP Stack
// ---------------------------------------------------------------------------

describe('smoke: API health endpoints (full HTTP stack)', () => {
  let scope: Scope.CloseableScope
  let baseUrl: string

  const withTestAuth = HttpMiddleware.make((app) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (
        request.url.startsWith('/health') ||
        request.url.startsWith('/readyz')
      ) {
        return yield* Effect.provideService(app, AuthContext, {
          userId: '',
          orgId: '',
          scopes: null,
        })
      }
      return yield* Effect.provideService(app, AuthContext, {
        userId: TEST_USER,
        orgId: TEST_ORG,
        scopes: null,
      })
    }),
  )

  beforeAll(async () => {
    const nodeServer = createServer()
    const quotaApi = createInMemoryQuotaApi() as QuotaApi & {
      setOrgQuota: (orgId: string, quota: Record<string, number>) => void
    }
    quotaApi.setOrgQuota(TEST_ORG, { maxConcurrentSandboxes: 100 })

    const TestApp = ApiRouter.pipe(
      withRateLimit,
      withTestAuth,
      withRequestId,
      withSecurityHeaders,
      HttpServer.serve(),
    )

    const services = Layer.mergeAll(
      Layer.succeed(SandboxRepo, createInMemorySandboxRepo()),
      Layer.succeed(ExecRepo, createInMemoryExecRepo()),
      Layer.succeed(SessionRepo, createInMemorySessionRepo()),
      Layer.succeed(ObjectStorage, createInMemoryObjectStorage()),
      Layer.succeed(NodeClient, createInMemoryNodeClient()),
      Layer.succeed(ArtifactRepo, createInMemoryArtifactRepo()),
      Layer.succeed(RedisService, createInMemoryRedisApi()),
      Layer.succeed(QuotaService, quotaApi),
      Layer.succeed(BillingService, createInMemoryBillingApi()),
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

  test('GET /health returns 200 ok', async () => {
    const res = await fetch(`${baseUrl}/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string }
    expect(body.status).toBe('ok')
  })

  test('GET /healthz returns 200 ok (ALB target)', async () => {
    const res = await fetch(`${baseUrl}/healthz`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string }
    expect(body.status).toBe('ok')
  })

  test('GET /readyz returns 200 with component checks', async () => {
    const res = await fetch(`${baseUrl}/readyz`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      status: string
      checks: { redis: string; shutdown: string }
    }
    expect(body.status).toBe('ok')
    expect(body.checks.redis).toBe('ok')
    expect(body.checks.shutdown).toBe('ok')
  })

  test('health endpoints include security headers', async () => {
    const res = await fetch(`${baseUrl}/health`)
    expect(res.headers.get('strict-transport-security')).toContain('max-age=')
    expect(res.headers.get('x-request-id')).toBeTruthy()
  })

  test('health endpoints respond quickly', async () => {
    const start = performance.now()
    await fetch(`${baseUrl}/healthz`)
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(1000)
  })
})
