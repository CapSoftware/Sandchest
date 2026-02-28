import { HttpClient, HttpClientRequest } from '@effect/platform'
import { NodeHttpServer } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { describe, expect, test } from 'bun:test'
import { AppLive } from './server.js'
import { AuthContext } from './context.js'
import { SandboxRepo } from './services/sandbox-repo.js'
import { ExecRepo } from './services/exec-repo.js'
import { SessionRepo } from './services/session-repo.js'
import { NodeClient } from './services/node-client.js'
import { RedisService } from './services/redis.js'
import { createInMemorySandboxRepo } from './services/sandbox-repo.memory.js'
import { createInMemoryExecRepo } from './services/exec-repo.memory.js'
import { createInMemorySessionRepo } from './services/session-repo.memory.js'
import { createInMemoryNodeClient } from './services/node-client.memory.js'
import { createInMemoryRedisApi } from './services/redis.memory.js'
import { ArtifactRepo } from './services/artifact-repo.js'
import { createInMemoryArtifactRepo } from './services/artifact-repo.memory.js'
import { QuotaMemory } from './services/quota.memory.js'
import { BillingMemory } from './services/billing.memory.js'
import { AuditLogMemory } from './services/audit-log.memory.js'
import { NodeRepo } from './services/node-repo.js'
import { createInMemoryNodeRepo } from './services/node-repo.memory.js'
import { MetricsRepo } from './services/metrics-repo.js'
import { createInMemoryMetricsRepo } from './services/metrics-repo.memory.js'
import { ShutdownControllerLive } from './shutdown.js'
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

  return { runTest, sandboxRepo }
}

// ---------------------------------------------------------------------------
// E2E: Full sandbox lifecycle
// ---------------------------------------------------------------------------

describe('E2E: sandbox lifecycle — create, exec, session, file, stop', () => {
  test('full lifecycle in a single sandbox', async () => {
    const env = createTestEnv()

    const result = await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        // --- 1. Create sandbox ---
        const createRes = yield* client.execute(
          HttpClientRequest.post('/v1/sandboxes').pipe(
            HttpClientRequest.bodyUnsafeJson({
              env: { NODE_ENV: 'test' },
              ttl_seconds: 3600,
            }),
          ),
        )
        const created = (yield* createRes.json) as {
          sandbox_id: string
          status: string
          replay_url: string
          created_at: string
        }

        expect(createRes.status).toBe(201)
        expect(created.sandbox_id.startsWith('sb_')).toBe(true)
        expect(created.status).toBe('running')
        expect(created.replay_url).toBeDefined()
        expect(created.created_at).toBeDefined()

        const sandboxId = created.sandbox_id

        // --- 2. Verify sandbox is retrievable and running ---
        const getRes = yield* client.execute(
          HttpClientRequest.get(`/v1/sandboxes/${sandboxId}`),
        )
        const sandbox = (yield* getRes.json) as {
          sandbox_id: string
          status: string
          env: Record<string, string>
          profile: string
          image: string
        }

        expect(getRes.status).toBe(200)
        expect(sandbox.sandbox_id).toBe(sandboxId)
        expect(sandbox.status).toBe('running')
        expect(sandbox.env).toEqual({ NODE_ENV: 'test' })
        expect(sandbox.profile).toBe('small')
        expect(sandbox.image).toBe('sandchest://ubuntu-22.04')

        // --- 4. Exec: sync command ---
        const syncExecRes = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/exec`).pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: ['echo', 'hello world'] }),
          ),
        )
        const syncExec = (yield* syncExecRes.json) as {
          exec_id: string
          status: string
          exit_code: number
          stdout: string
          stderr: string
          duration_ms: number
          resource_usage: { cpu_ms: number; peak_memory_bytes: number }
        }

        expect(syncExecRes.status).toBe(200)
        expect(syncExec.exec_id.startsWith('ex_')).toBe(true)
        expect(syncExec.status).toBe('done')
        expect(syncExec.exit_code).toBe(0)
        expect(syncExec.duration_ms).toBeGreaterThanOrEqual(0)
        expect(syncExec.resource_usage).toBeDefined()

        // --- 5. Exec: async command ---
        const asyncExecRes = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/exec`).pipe(
            HttpClientRequest.bodyUnsafeJson({
              cmd: ['sleep', '30'],
              wait: false,
            }),
          ),
        )
        const asyncExec = (yield* asyncExecRes.json) as {
          exec_id: string
          status: string
        }

        expect(asyncExecRes.status).toBe(202)
        expect(asyncExec.exec_id.startsWith('ex_')).toBe(true)
        expect(asyncExec.status).toBe('queued')

        // --- 6. Verify exec is retrievable ---
        const getExecRes = yield* client.execute(
          HttpClientRequest.get(
            `/v1/sandboxes/${sandboxId}/exec/${syncExec.exec_id}`,
          ),
        )
        const execDetail = (yield* getExecRes.json) as {
          exec_id: string
          sandbox_id: string
          status: string
          cmd: string[]
        }

        expect(getExecRes.status).toBe(200)
        expect(execDetail.exec_id).toBe(syncExec.exec_id)
        expect(execDetail.sandbox_id).toBe(sandboxId)
        expect(execDetail.status).toBe('done')
        expect(execDetail.cmd).toEqual(['echo', 'hello world'])

        // --- 7. List execs ---
        const listExecsRes = yield* client.execute(
          HttpClientRequest.get(`/v1/sandboxes/${sandboxId}/execs`),
        )
        const execsList = (yield* listExecsRes.json) as {
          execs: Array<{ exec_id: string }>
        }

        expect(listExecsRes.status).toBe(200)
        expect(execsList.execs.length).toBe(2)

        // --- 8. Stream exec output (SSE) ---
        const streamRes = yield* client.execute(
          HttpClientRequest.get(
            `/v1/sandboxes/${sandboxId}/exec/${syncExec.exec_id}/stream`,
          ),
        )
        const streamBody = yield* streamRes.text

        expect(streamRes.status).toBe(200)
        expect(streamRes.headers['content-type']).toContain('text/event-stream')
        expect(streamBody).toContain('data:')
        expect(streamBody).toContain('"t":"exit"')

        // --- 9. Create session ---
        const createSessRes = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/sessions`).pipe(
            HttpClientRequest.bodyUnsafeJson({ shell: '/bin/bash' }),
          ),
        )
        const session = (yield* createSessRes.json) as {
          session_id: string
          status: string
        }

        expect(createSessRes.status).toBe(201)
        expect(session.session_id.startsWith('sess_')).toBe(true)
        expect(session.status).toBe('running')

        // --- 10. Exec in session ---
        const sessExecRes = yield* client.execute(
          HttpClientRequest.post(
            `/v1/sandboxes/${sandboxId}/sessions/${session.session_id}/exec`,
          ).pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: 'ls -la /tmp' }),
          ),
        )
        const sessExec = (yield* sessExecRes.json) as {
          exec_id: string
          status: string
          exit_code: number
        }

        expect(sessExecRes.status).toBe(200)
        expect(sessExec.exec_id.startsWith('ex_')).toBe(true)
        expect(sessExec.status).toBe('done')
        expect(sessExec.exit_code).toBe(0)

        // --- 11. Send input to session ---
        const inputRes = yield* client.execute(
          HttpClientRequest.post(
            `/v1/sandboxes/${sandboxId}/sessions/${session.session_id}/input`,
          ).pipe(
            HttpClientRequest.bodyUnsafeJson({ data: 'echo test\n' }),
          ),
        )
        const inputBody = (yield* inputRes.json) as { ok: boolean }

        expect(inputRes.status).toBe(200)
        expect(inputBody.ok).toBe(true)

        // --- 12. List sessions ---
        const listSessRes = yield* client.execute(
          HttpClientRequest.get(`/v1/sandboxes/${sandboxId}/sessions`),
        )
        const sessList = (yield* listSessRes.json) as {
          sessions: Array<{ session_id: string; status: string; shell: string }>
          next_cursor: string | null
        }

        expect(listSessRes.status).toBe(200)
        expect(sessList.sessions.length).toBe(1)
        expect(sessList.sessions[0].session_id).toBe(session.session_id)
        expect(sessList.sessions[0].status).toBe('running')
        expect(sessList.sessions[0].shell).toBe('/bin/bash')
        expect(sessList.next_cursor).toBeNull()

        // --- 13. Destroy session ---
        const destroySessRes = yield* client.execute(
          HttpClientRequest.del(
            `/v1/sandboxes/${sandboxId}/sessions/${session.session_id}`,
          ),
        )
        const destroyBody = (yield* destroySessRes.json) as { ok: boolean }

        expect(destroySessRes.status).toBe(200)
        expect(destroyBody.ok).toBe(true)

        // Verify session is marked destroyed in list
        const listAfterDestroy = yield* client.execute(
          HttpClientRequest.get(`/v1/sandboxes/${sandboxId}/sessions`),
        )
        const sessListAfter = (yield* listAfterDestroy.json) as {
          sessions: Array<{ session_id: string; status: string }>
        }
        expect(sessListAfter.sessions.length).toBe(1)
        expect(sessListAfter.sessions[0].session_id).toBe(session.session_id)
        expect(sessListAfter.sessions[0].status).toBe('destroyed')

        // --- 14. Upload file ---
        const fileContent = 'hello from sandchest e2e test'
        const uploadRes = yield* client.execute(
          HttpClientRequest.put(
            `/v1/sandboxes/${sandboxId}/files?path=/work/e2e-test.txt`,
          ).pipe(
            HttpClientRequest.bodyUint8Array(
              new TextEncoder().encode(fileContent),
              'application/octet-stream',
            ),
          ),
        )
        const uploadBody = (yield* uploadRes.json) as {
          path: string
          bytes_written: number
          batch: boolean
        }

        expect(uploadRes.status).toBe(200)
        expect(uploadBody.path).toBe('/work/e2e-test.txt')
        expect(uploadBody.bytes_written).toBe(fileContent.length)
        expect(uploadBody.batch).toBe(false)

        // --- 15. Download file ---
        const downloadRes = yield* client.execute(
          HttpClientRequest.get(
            `/v1/sandboxes/${sandboxId}/files?path=/work/e2e-test.txt`,
          ),
        )
        const downloaded = new TextDecoder().decode(
          yield* downloadRes.arrayBuffer,
        )

        expect(downloadRes.status).toBe(200)
        expect(downloadRes.headers['content-type']).toContain(
          'application/octet-stream',
        )
        expect(downloaded).toBe(fileContent)

        // --- 16. List files ---
        const listFilesRes = yield* client.execute(
          HttpClientRequest.get(
            `/v1/sandboxes/${sandboxId}/files?path=/work&list=true`,
          ),
        )
        const filesList = (yield* listFilesRes.json) as {
          files: Array<{ name: string; path: string; type: string }>
          next_cursor: string | null
        }

        expect(listFilesRes.status).toBe(200)
        expect(filesList.files).toBeArray()
        expect(filesList.next_cursor).toBeNull()

        // --- 17. Delete file ---
        const deleteFileRes = yield* client.execute(
          HttpClientRequest.del(
            `/v1/sandboxes/${sandboxId}/files?path=/work/e2e-test.txt`,
          ),
        )
        const deleteFileBody = (yield* deleteFileRes.json) as { ok: boolean }

        expect(deleteFileRes.status).toBe(200)
        expect(deleteFileBody.ok).toBe(true)

        // --- 18. Stop sandbox ---
        const stopRes = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/stop`),
        )
        const stopped = (yield* stopRes.json) as {
          sandbox_id: string
          status: string
        }

        expect(stopRes.status).toBe(202)
        expect(stopped.sandbox_id).toBe(sandboxId)
        expect(stopped.status).toBe('stopping')

        // --- 19. Verify sandbox is stopped ---
        const finalRes = yield* client.execute(
          HttpClientRequest.get(`/v1/sandboxes/${sandboxId}`),
        )
        const finalSandbox = (yield* finalRes.json) as { status: string }
        expect(finalSandbox.status).toBe('stopping')

        // --- 20. Operations fail on stopped sandbox ---
        const execOnStopped = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/exec`).pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: ['echo', 'fail'] }),
          ),
        )
        expect(execOnStopped.status).toBe(409)

        const sessOnStopped = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/sessions`).pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        expect(sessOnStopped.status).toBe(409)

        const fileOnStopped = yield* client.execute(
          HttpClientRequest.put(
            `/v1/sandboxes/${sandboxId}/files?path=/work/nope.txt`,
          ).pipe(
            HttpClientRequest.bodyUint8Array(
              new TextEncoder().encode('nope'),
              'application/octet-stream',
            ),
          ),
        )
        expect(fileOnStopped.status).toBe(409)

        return { sandboxId }
      }),
    )

    expect(result.sandboxId).toBeDefined()
  })

  test('sandbox appears in list and disappears after delete', async () => {
    const env = createTestEnv()

    await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        // Create sandbox
        const createRes = yield* client.execute(
          HttpClientRequest.post('/v1/sandboxes').pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        const created = (yield* createRes.json) as { sandbox_id: string }
        const sandboxId = created.sandbox_id

        // Should appear in list
        const listRes = yield* client.execute(
          HttpClientRequest.get('/v1/sandboxes'),
        )
        const list = (yield* listRes.json) as {
          sandboxes: Array<{ sandbox_id: string }>
        }
        expect(list.sandboxes.some((s) => s.sandbox_id === sandboxId)).toBe(true)

        // Delete
        const delRes = yield* client.execute(
          HttpClientRequest.del(`/v1/sandboxes/${sandboxId}`),
        )
        const deleted = (yield* delRes.json) as { status: string }
        expect(delRes.status).toBe(200)
        expect(deleted.status).toBe('deleted')

        // Should not appear in list
        const listAfter = yield* client.execute(
          HttpClientRequest.get('/v1/sandboxes'),
        )
        const listAfterBody = (yield* listAfter.json) as {
          sandboxes: Array<{ sandbox_id: string }>
        }
        expect(
          listAfterBody.sandboxes.some((s) => s.sandbox_id === sandboxId),
        ).toBe(false)
      }),
    )
  })

  test('multiple execs on same sandbox maintain separate state', async () => {
    const env = createTestEnv()

    await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        // Create and transition to running
        const createRes = yield* client.execute(
          HttpClientRequest.post('/v1/sandboxes').pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        const created = (yield* createRes.json) as { sandbox_id: string }
        const sandboxId = created.sandbox_id
        yield* env.sandboxRepo.updateStatus(
          idToBytes(sandboxId),
          TEST_ORG,
          'running',
        )

        // Run three sync execs
        const exec1Res = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/exec`).pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: ['echo', 'first'] }),
          ),
        )
        const exec1 = (yield* exec1Res.json) as { exec_id: string }

        const exec2Res = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/exec`).pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: ['echo', 'second'] }),
          ),
        )
        const exec2 = (yield* exec2Res.json) as { exec_id: string }

        const exec3Res = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/exec`).pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: 'echo third' }),
          ),
        )
        const exec3 = (yield* exec3Res.json) as { exec_id: string }

        // All have unique IDs
        const ids = [exec1.exec_id, exec2.exec_id, exec3.exec_id]
        expect(new Set(ids).size).toBe(3)

        // List should contain all three
        const listRes = yield* client.execute(
          HttpClientRequest.get(`/v1/sandboxes/${sandboxId}/execs`),
        )
        const list = (yield* listRes.json) as {
          execs: Array<{ exec_id: string }>
        }
        expect(list.execs.length).toBe(3)

        // Each exec should be individually retrievable
        for (const id of ids) {
          const res = yield* client.execute(
            HttpClientRequest.get(`/v1/sandboxes/${sandboxId}/exec/${id}`),
          )
          expect(res.status).toBe(200)
        }
      }),
    )
  })

  test('session exec links to session and appears in exec list', async () => {
    const env = createTestEnv()

    await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        // Create running sandbox
        const createRes = yield* client.execute(
          HttpClientRequest.post('/v1/sandboxes').pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        const created = (yield* createRes.json) as { sandbox_id: string }
        const sandboxId = created.sandbox_id
        yield* env.sandboxRepo.updateStatus(
          idToBytes(sandboxId),
          TEST_ORG,
          'running',
        )

        // Create session
        const sessRes = yield* client.execute(
          HttpClientRequest.post(`/v1/sandboxes/${sandboxId}/sessions`).pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        const session = (yield* sessRes.json) as { session_id: string }

        // Exec in session
        const execRes = yield* client.execute(
          HttpClientRequest.post(
            `/v1/sandboxes/${sandboxId}/sessions/${session.session_id}/exec`,
          ).pipe(
            HttpClientRequest.bodyUnsafeJson({ cmd: 'whoami' }),
          ),
        )
        const exec = (yield* execRes.json) as { exec_id: string }

        // Exec should appear in the sandbox's exec list
        const listRes = yield* client.execute(
          HttpClientRequest.get(`/v1/sandboxes/${sandboxId}/execs`),
        )
        const list = (yield* listRes.json) as {
          execs: Array<{ exec_id: string; session_id: string | null }>
        }
        expect(list.execs.length).toBe(1)
        expect(list.execs[0].exec_id).toBe(exec.exec_id)
        expect(list.execs[0].session_id).toBe(session.session_id)
      }),
    )
  })

  test('file upload, download, and delete round-trip with binary data', async () => {
    const env = createTestEnv()

    await env.runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        // Create running sandbox
        const createRes = yield* client.execute(
          HttpClientRequest.post('/v1/sandboxes').pipe(
            HttpClientRequest.bodyUnsafeJson({}),
          ),
        )
        const created = (yield* createRes.json) as { sandbox_id: string }
        const sandboxId = created.sandbox_id
        yield* env.sandboxRepo.updateStatus(
          idToBytes(sandboxId),
          TEST_ORG,
          'running',
        )

        // Upload binary data
        const binaryData = new Uint8Array([0, 1, 2, 255, 254, 253, 128, 127])
        const uploadRes = yield* client.execute(
          HttpClientRequest.put(
            `/v1/sandboxes/${sandboxId}/files?path=/data/binary.bin`,
          ).pipe(
            HttpClientRequest.bodyUint8Array(binaryData, 'application/octet-stream'),
          ),
        )
        const upload = (yield* uploadRes.json) as { bytes_written: number }
        expect(upload.bytes_written).toBe(8)

        // Download and verify exact match
        const downloadRes = yield* client.execute(
          HttpClientRequest.get(
            `/v1/sandboxes/${sandboxId}/files?path=/data/binary.bin`,
          ),
        )
        const downloadedBuf = yield* downloadRes.arrayBuffer
        const downloaded = new Uint8Array(downloadedBuf)
        expect(downloaded).toEqual(binaryData)

        // Delete
        const delRes = yield* client.execute(
          HttpClientRequest.del(
            `/v1/sandboxes/${sandboxId}/files?path=/data/binary.bin`,
          ),
        )
        expect(delRes.status).toBe(200)
      }),
    )
  })
})
