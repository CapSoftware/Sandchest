import { Effect, Layer } from 'effect'
import { describe, expect, test, beforeEach } from 'bun:test'
import { createInMemoryRedisApi } from '../services/redis.memory.js'
import { createInMemorySandboxRepo } from '../services/sandbox-repo.memory.js'
import { createInMemoryArtifactRepo } from '../services/artifact-repo.memory.js'
import { createInMemoryObjectStorage } from '../services/object-storage.memory.js'
import { RedisService, type RedisApi } from '../services/redis.js'
import { SandboxRepo, type SandboxRepoApi } from '../services/sandbox-repo.js'
import { ArtifactRepo, type ArtifactRepoApi } from '../services/artifact-repo.js'
import { ObjectStorage, type ObjectStorageApi } from '../services/object-storage.js'
import { IdempotencyRepo, type IdempotencyRepoApi } from './idempotency-cleanup.js'
import { createTestableIdempotencyRepo } from './idempotency-cleanup.memory.js'
import { runWorkerTick, type WorkerConfig } from './runner.js'
import { ttlEnforcementWorker } from './ttl-enforcement.js'
import { idleShutdownWorker } from './idle-shutdown.js'
import { orphanReconciliationWorker } from './orphan-reconciliation.js'
import { queueTimeoutWorker } from './queue-timeout.js'
import { idempotencyCleanupWorker } from './idempotency-cleanup.js'
import { artifactRetentionWorker } from './artifact-retention.js'
import { orgHardDeleteWorker } from './org-hard-delete.js'
import { replayRetentionWorker, PURGED_SENTINEL } from './replay-retention.js'
import { generateUUIDv7, base62Encode, bytesToId, SANDBOX_PREFIX } from '@sandchest/contract'
import { QuotaService, type QuotaApi } from '../services/quota.js'
import { createInMemoryQuotaApi } from '../services/quota.memory.js'
import type { WorkerDeps } from './index.js'

let redis: RedisApi
let sandboxRepo: SandboxRepoApi
let artifactRepo: ArtifactRepoApi
let objectStorage: ObjectStorageApi
let idempotencyApi: IdempotencyRepoApi
let idempotencyStore: Map<string, { createdAt: Date }>
let quotaApi: QuotaApi & { setOrgQuota: (orgId: string, quota: Record<string, unknown>) => void }
let testLayer: Layer.Layer<WorkerDeps | RedisService>

function run<A>(effect: Effect.Effect<A, never, WorkerDeps | RedisService>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(testLayer)))
}

const SEED_IMAGE_ID = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0])
const SEED_PROFILE_ID = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])

beforeEach(() => {
  redis = createInMemoryRedisApi()
  sandboxRepo = createInMemorySandboxRepo()
  artifactRepo = createInMemoryArtifactRepo()
  objectStorage = createInMemoryObjectStorage()
  const testable = createTestableIdempotencyRepo()
  idempotencyApi = testable.api
  idempotencyStore = testable.store
  quotaApi = createInMemoryQuotaApi()

  testLayer = Layer.mergeAll(
    Layer.succeed(RedisService, redis),
    Layer.succeed(SandboxRepo, sandboxRepo),
    Layer.succeed(ArtifactRepo, artifactRepo),
    Layer.succeed(ObjectStorage, objectStorage),
    Layer.succeed(IdempotencyRepo, idempotencyApi),
    Layer.succeed(QuotaService, quotaApi),
  )
})

// ---------------------------------------------------------------------------
// Runner framework
// ---------------------------------------------------------------------------

describe('worker runner', () => {
  test('acquires leader lock and runs handler', async () => {
    let ran = false
    const worker: WorkerConfig<RedisService> = {
      name: 'test-worker',
      intervalMs: 1000,
      handler: Effect.sync(() => {
        ran = true
        return 42
      }),
    }

    const result = await run(runWorkerTick(worker, 'instance-1'))
    expect(result).toBe(42)
    expect(ran).toBe(true)
  })

  test('returns -1 when not leader', async () => {
    const worker: WorkerConfig<RedisService> = {
      name: 'test-worker',
      intervalMs: 1000,
      handler: Effect.succeed(1),
    }

    await run(runWorkerTick(worker, 'instance-1'))
    const result = await run(runWorkerTick(worker, 'instance-2'))
    expect(result).toBe(-1)
  })

  test('same instance can re-acquire its own lock', async () => {
    const worker: WorkerConfig<RedisService> = {
      name: 'test-worker',
      intervalMs: 1000,
      handler: Effect.succeed(1),
    }

    const r1 = await run(runWorkerTick(worker, 'instance-1'))
    const r2 = await run(runWorkerTick(worker, 'instance-1'))
    expect(r1).toBe(1)
    expect(r2).toBe(1)
  })

  test('different workers have independent locks', async () => {
    const worker1: WorkerConfig<RedisService> = {
      name: 'worker-a',
      intervalMs: 1000,
      handler: Effect.succeed(1),
    }
    const worker2: WorkerConfig<RedisService> = {
      name: 'worker-b',
      intervalMs: 1000,
      handler: Effect.succeed(2),
    }

    const r1 = await run(runWorkerTick(worker1, 'instance-1'))
    const r2 = await run(runWorkerTick(worker2, 'instance-2'))
    expect(r1).toBe(1)
    expect(r2).toBe(2)
  })

  test('error in handler does not propagate (caught by runner)', async () => {
    const worker: WorkerConfig<RedisService> = {
      name: 'fail-worker',
      intervalMs: 1000,
      handler: Effect.die(new Error('boom')),
    }

    const tick = runWorkerTick(worker, 'inst-1').pipe(
      Effect.catchAllCause(() => Effect.succeed(-1)),
    )
    const result = await run(tick)
    expect(result).toBe(-1)
  })
})

// ---------------------------------------------------------------------------
// TTL enforcement worker
// ---------------------------------------------------------------------------

describe('ttl-enforcement', () => {
  test('does not stop sandboxes within TTL', async () => {
    const id = generateUUIDv7()
    await Effect.runPromise(
      sandboxRepo.create({
        id,
        orgId: 'org_test',
        imageId: SEED_IMAGE_ID,
        profileId: SEED_PROFILE_ID,
        profileName: 'small',
        env: null,
        ttlSeconds: 9999,
        imageRef: 'sandchest://ubuntu-22.04',
      }),
    )
    await Effect.runPromise(sandboxRepo.updateStatus(id, 'org_test', 'running'))

    const count = await run(runWorkerTick(ttlEnforcementWorker, 'inst-1'))
    expect(count).toBe(0)
  })

  test('ignores non-running sandboxes', async () => {
    const id = generateUUIDv7()
    await Effect.runPromise(
      sandboxRepo.create({
        id,
        orgId: 'org_test',
        imageId: SEED_IMAGE_ID,
        profileId: SEED_PROFILE_ID,
        profileName: 'small',
        env: null,
        ttlSeconds: 0,
        imageRef: 'sandchest://ubuntu-22.04',
      }),
    )
    // Leave as 'queued'
    const count = await run(runWorkerTick(ttlEnforcementWorker, 'inst-1'))
    expect(count).toBe(0)
  })

  test('returns 0 with no sandboxes', async () => {
    const count = await run(runWorkerTick(ttlEnforcementWorker, 'inst-1'))
    expect(count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Queue timeout worker
// ---------------------------------------------------------------------------

describe('queue-timeout', () => {
  test('does not fail recently queued sandboxes', async () => {
    const id = generateUUIDv7()
    await Effect.runPromise(
      sandboxRepo.create({
        id,
        orgId: 'org_test',
        imageId: SEED_IMAGE_ID,
        profileId: SEED_PROFILE_ID,
        profileName: 'small',
        env: null,
        ttlSeconds: 3600,
        imageRef: 'sandchest://ubuntu-22.04',
      }),
    )

    const count = await run(runWorkerTick(queueTimeoutWorker, 'inst-1'))
    expect(count).toBe(0)
  })

  test('does not affect running sandboxes', async () => {
    const id = generateUUIDv7()
    await Effect.runPromise(
      sandboxRepo.create({
        id,
        orgId: 'org_test',
        imageId: SEED_IMAGE_ID,
        profileId: SEED_PROFILE_ID,
        profileName: 'small',
        env: null,
        ttlSeconds: 3600,
        imageRef: 'sandchest://ubuntu-22.04',
      }),
    )
    await Effect.runPromise(sandboxRepo.updateStatus(id, 'org_test', 'running'))

    const count = await run(runWorkerTick(queueTimeoutWorker, 'inst-1'))
    expect(count).toBe(0)
  })

  test('returns 0 with no sandboxes', async () => {
    const count = await run(runWorkerTick(queueTimeoutWorker, 'inst-1'))
    expect(count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Orphan reconciliation worker
// ---------------------------------------------------------------------------

describe('orphan-reconciliation', () => {
  test('returns 0 when no running sandboxes', async () => {
    const count = await run(runWorkerTick(orphanReconciliationWorker, 'inst-1'))
    expect(count).toBe(0)
  })

  test('returns 0 when no sandboxes have node assignments', async () => {
    const id = generateUUIDv7()
    await Effect.runPromise(
      sandboxRepo.create({
        id,
        orgId: 'org_test',
        imageId: SEED_IMAGE_ID,
        profileId: SEED_PROFILE_ID,
        profileName: 'small',
        env: null,
        ttlSeconds: 3600,
        imageRef: 'sandchest://ubuntu-22.04',
      }),
    )
    await Effect.runPromise(sandboxRepo.updateStatus(id, 'org_test', 'running'))

    // nodeId is null → getActiveNodeIds returns []
    const count = await run(runWorkerTick(orphanReconciliationWorker, 'inst-1'))
    expect(count).toBe(0)
  })

  test('returns 0 when node has active heartbeat', async () => {
    const nodeId = generateUUIDv7()
    const sandboxId = generateUUIDv7()

    await Effect.runPromise(
      sandboxRepo.create({
        id: sandboxId,
        orgId: 'org_test',
        imageId: SEED_IMAGE_ID,
        profileId: SEED_PROFILE_ID,
        profileName: 'small',
        env: null,
        ttlSeconds: 3600,
        imageRef: 'sandchest://ubuntu-22.04',
      }),
    )
    await Effect.runPromise(sandboxRepo.assignNode(sandboxId, 'org_test', nodeId))

    // Register heartbeat for this node
    const nodeIdStr = base62Encode(nodeId)
    await Effect.runPromise(redis.registerNodeHeartbeat(nodeIdStr, 60))

    const count = await run(runWorkerTick(orphanReconciliationWorker, 'inst-1'))
    expect(count).toBe(0)

    // Sandbox should still be running
    const sandbox = await Effect.runPromise(sandboxRepo.findById(sandboxId, 'org_test'))
    expect(sandbox?.status).toBe('running')
  })

  test('marks sandboxes as failed when node heartbeat is missing', async () => {
    const nodeId = generateUUIDv7()
    const sandboxId = generateUUIDv7()

    await Effect.runPromise(
      sandboxRepo.create({
        id: sandboxId,
        orgId: 'org_test',
        imageId: SEED_IMAGE_ID,
        profileId: SEED_PROFILE_ID,
        profileName: 'small',
        env: null,
        ttlSeconds: 3600,
        imageRef: 'sandchest://ubuntu-22.04',
      }),
    )
    await Effect.runPromise(sandboxRepo.assignNode(sandboxId, 'org_test', nodeId))

    // No heartbeat registered → node is considered offline
    const count = await run(runWorkerTick(orphanReconciliationWorker, 'inst-1'))
    expect(count).toBe(1)

    const sandbox = await Effect.runPromise(sandboxRepo.findById(sandboxId, 'org_test'))
    expect(sandbox?.status).toBe('failed')
    expect(sandbox?.failureReason).toBe('node_lost')
    expect(sandbox?.endedAt).toBeDefined()
  })

  test('marks multiple sandboxes on same offline node', async () => {
    const nodeId = generateUUIDv7()
    const sandbox1 = generateUUIDv7()
    const sandbox2 = generateUUIDv7()

    for (const id of [sandbox1, sandbox2]) {
      await Effect.runPromise(
        sandboxRepo.create({
          id,
          orgId: 'org_test',
          imageId: SEED_IMAGE_ID,
          profileId: SEED_PROFILE_ID,
          profileName: 'small',
          env: null,
          ttlSeconds: 3600,
          imageRef: 'sandchest://ubuntu-22.04',
        }),
      )
      await Effect.runPromise(sandboxRepo.assignNode(id, 'org_test', nodeId))
    }

    const count = await run(runWorkerTick(orphanReconciliationWorker, 'inst-1'))
    expect(count).toBe(2)

    const s1 = await Effect.runPromise(sandboxRepo.findById(sandbox1, 'org_test'))
    const s2 = await Effect.runPromise(sandboxRepo.findById(sandbox2, 'org_test'))
    expect(s1?.status).toBe('failed')
    expect(s2?.status).toBe('failed')
  })

  test('only marks sandboxes on offline nodes, not online ones', async () => {
    const onlineNodeId = generateUUIDv7()
    const offlineNodeId = generateUUIDv7()
    const onlineSandbox = generateUUIDv7()
    const offlineSandbox = generateUUIDv7()

    // Create sandboxes on two different nodes
    for (const [id, nodeId] of [[onlineSandbox, onlineNodeId], [offlineSandbox, offlineNodeId]] as const) {
      await Effect.runPromise(
        sandboxRepo.create({
          id,
          orgId: 'org_test',
          imageId: SEED_IMAGE_ID,
          profileId: SEED_PROFILE_ID,
          profileName: 'small',
          env: null,
          ttlSeconds: 3600,
          imageRef: 'sandchest://ubuntu-22.04',
        }),
      )
      await Effect.runPromise(sandboxRepo.assignNode(id, 'org_test', nodeId))
    }

    // Only register heartbeat for the online node
    await Effect.runPromise(redis.registerNodeHeartbeat(base62Encode(onlineNodeId), 60))

    const count = await run(runWorkerTick(orphanReconciliationWorker, 'inst-1'))
    expect(count).toBe(1)

    const online = await Effect.runPromise(sandboxRepo.findById(onlineSandbox, 'org_test'))
    const offline = await Effect.runPromise(sandboxRepo.findById(offlineSandbox, 'org_test'))
    expect(online?.status).toBe('running')
    expect(offline?.status).toBe('failed')
    expect(offline?.failureReason).toBe('node_lost')
  })
})

// ---------------------------------------------------------------------------
// Idle shutdown worker
// ---------------------------------------------------------------------------

describe('idle-shutdown', () => {
  test('returns 0 for empty state', async () => {
    const count = await run(runWorkerTick(idleShutdownWorker, 'inst-1'))
    expect(count).toBe(0)
  })

  test('does not shut down recently created running sandboxes', async () => {
    const id = generateUUIDv7()
    await Effect.runPromise(
      sandboxRepo.create({
        id,
        orgId: 'org_test',
        imageId: SEED_IMAGE_ID,
        profileId: SEED_PROFILE_ID,
        profileName: 'small',
        env: null,
        ttlSeconds: 3600,
        imageRef: 'sandchest://ubuntu-22.04',
      }),
    )
    await Effect.runPromise(sandboxRepo.updateStatus(id, 'org_test', 'running'))

    const count = await run(runWorkerTick(idleShutdownWorker, 'inst-1'))
    expect(count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Idempotency cleanup worker
// ---------------------------------------------------------------------------

describe('idempotency-cleanup', () => {
  test('returns 0 when no keys exist', async () => {
    const count = await run(runWorkerTick(idempotencyCleanupWorker, 'inst-1'))
    expect(count).toBe(0)
  })

  test('deletes keys older than 24 hours', async () => {
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000)
    idempotencyStore.set('key-old-1', { createdAt: oldDate })
    idempotencyStore.set('key-old-2', { createdAt: oldDate })
    idempotencyStore.set('key-new', { createdAt: new Date() })

    const count = await run(runWorkerTick(idempotencyCleanupWorker, 'inst-1'))
    expect(count).toBe(2)
    expect(idempotencyStore.size).toBe(1)
    expect(idempotencyStore.has('key-new')).toBe(true)
  })

  test('does not delete recent keys', async () => {
    idempotencyStore.set('key-1', { createdAt: new Date() })
    idempotencyStore.set('key-2', { createdAt: new Date() })

    const count = await run(runWorkerTick(idempotencyCleanupWorker, 'inst-1'))
    expect(count).toBe(0)
    expect(idempotencyStore.size).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Artifact retention worker
// ---------------------------------------------------------------------------

describe('artifact-retention', () => {
  test('returns 0 when no expired artifacts', async () => {
    const count = await run(runWorkerTick(artifactRetentionWorker, 'inst-1'))
    expect(count).toBe(0)
  })

  test('deletes expired artifacts and their storage objects', async () => {
    const sandboxId = generateUUIDv7()
    const artId = generateUUIDv7()
    const storageRef = `artifacts/test-expired`

    await Effect.runPromise(objectStorage.putObject(storageRef, 'data'))

    const pastDate = new Date(Date.now() - 1000)
    await Effect.runPromise(
      artifactRepo.create({
        id: artId,
        sandboxId,
        orgId: 'org_test',
        name: 'test.txt',
        mime: 'text/plain',
        bytes: 4,
        sha256: 'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
        ref: storageRef,
        retentionUntil: pastDate,
      }),
    )

    const count = await run(runWorkerTick(artifactRetentionWorker, 'inst-1'))
    expect(count).toBe(1)

    const obj = await Effect.runPromise(objectStorage.getObject(storageRef))
    expect(obj).toBeNull()
  })

  test('does not delete artifacts with future retention', async () => {
    const sandboxId = generateUUIDv7()
    const artId = generateUUIDv7()

    await Effect.runPromise(
      artifactRepo.create({
        id: artId,
        sandboxId,
        orgId: 'org_test',
        name: 'test.txt',
        mime: 'text/plain',
        bytes: 4,
        sha256: 'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
        ref: 'ref',
        retentionUntil: new Date(Date.now() + 86400000),
      }),
    )

    const count = await run(runWorkerTick(artifactRetentionWorker, 'inst-1'))
    expect(count).toBe(0)
  })

  test('does not delete artifacts with no retention date', async () => {
    const sandboxId = generateUUIDv7()
    const artId = generateUUIDv7()

    await Effect.runPromise(
      artifactRepo.create({
        id: artId,
        sandboxId,
        orgId: 'org_test',
        name: 'test.txt',
        mime: 'text/plain',
        bytes: 4,
        sha256: 'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
        ref: 'ref',
      }),
    )

    const count = await run(runWorkerTick(artifactRetentionWorker, 'inst-1'))
    expect(count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Org hard-delete worker
// ---------------------------------------------------------------------------

describe('org-hard-delete', () => {
  test('returns 0 (stub)', async () => {
    const count = await run(runWorkerTick(orgHardDeleteWorker, 'inst-1'))
    expect(count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Replay retention worker
// ---------------------------------------------------------------------------

describe('replay-retention', () => {
  async function createStoppedSandbox(orgId: string, endedAt: Date) {
    const id = generateUUIDv7()
    await Effect.runPromise(
      sandboxRepo.create({
        id,
        orgId,
        imageId: SEED_IMAGE_ID,
        profileId: SEED_PROFILE_ID,
        profileName: 'small',
        env: null,
        ttlSeconds: 3600,
        imageRef: 'sandchest://ubuntu-22.04',
      }),
    )
    await Effect.runPromise(
      sandboxRepo.updateStatus(id, orgId, 'stopped', { endedAt }),
    )
    return id
  }

  test('returns 0 when no sandboxes exist', async () => {
    const count = await run(runWorkerTick(replayRetentionWorker, 'inst-1'))
    expect(count).toBe(0)
  })

  test('sets replay_expires_at on terminal sandboxes missing it', async () => {
    const endedAt = new Date(Date.now() - 1000)
    const id = await createStoppedSandbox('org_test', endedAt)

    const count = await run(runWorkerTick(replayRetentionWorker, 'inst-1'))
    expect(count).toBe(1)

    const row = await Effect.runPromise(sandboxRepo.findById(id, 'org_test'))
    expect(row?.replayExpiresAt).not.toBeNull()
    // Default retention is 30 days
    const expectedExpiry = endedAt.getTime() + 30 * 86_400_000
    expect(row!.replayExpiresAt!.getTime()).toBe(expectedExpiry)
  })

  test('uses org-specific retention days', async () => {
    quotaApi.setOrgQuota('org_custom', { replayRetentionDays: 7 })
    const endedAt = new Date(Date.now() - 1000)
    const id = await createStoppedSandbox('org_custom', endedAt)

    await run(runWorkerTick(replayRetentionWorker, 'inst-1'))

    const row = await Effect.runPromise(sandboxRepo.findById(id, 'org_custom'))
    const expectedExpiry = endedAt.getTime() + 7 * 86_400_000
    expect(row!.replayExpiresAt!.getTime()).toBe(expectedExpiry)
  })

  test('does not set expiry on running sandboxes', async () => {
    const id = generateUUIDv7()
    await Effect.runPromise(
      sandboxRepo.create({
        id,
        orgId: 'org_test',
        imageId: SEED_IMAGE_ID,
        profileId: SEED_PROFILE_ID,
        profileName: 'small',
        env: null,
        ttlSeconds: 3600,
        imageRef: 'sandchest://ubuntu-22.04',
      }),
    )
    await Effect.runPromise(sandboxRepo.updateStatus(id, 'org_test', 'running'))

    const count = await run(runWorkerTick(replayRetentionWorker, 'inst-1'))
    expect(count).toBe(0)

    const row = await Effect.runPromise(sandboxRepo.findById(id, 'org_test'))
    expect(row?.replayExpiresAt).toBeNull()
  })

  test('does not re-process sandboxes that already have expiry set', async () => {
    const endedAt = new Date(Date.now() - 1000)
    await createStoppedSandbox('org_test', endedAt)

    // First run sets expiry
    await run(runWorkerTick(replayRetentionWorker, 'inst-1'))

    // Second run should not re-process (already has expiry)
    const count = await run(runWorkerTick(replayRetentionWorker, 'inst-1'))
    expect(count).toBe(0)
  })

  test('purges expired replays and deletes events from storage', async () => {
    const id = generateUUIDv7()
    await Effect.runPromise(
      sandboxRepo.create({
        id,
        orgId: 'org_test',
        imageId: SEED_IMAGE_ID,
        profileId: SEED_PROFILE_ID,
        profileName: 'small',
        env: null,
        ttlSeconds: 3600,
        imageRef: 'sandchest://ubuntu-22.04',
      }),
    )
    const endedAt = new Date(Date.now() - 31 * 86_400_000) // 31 days ago
    await Effect.runPromise(
      sandboxRepo.updateStatus(id, 'org_test', 'stopped', { endedAt }),
    )

    // Put events in storage
    const sandboxIdStr = bytesToId(SANDBOX_PREFIX, id)
    const eventsKey = `org_test/${sandboxIdStr}/events.jsonl`
    await Effect.runPromise(objectStorage.putObject(eventsKey, 'event data'))

    // Single run handles both: sets expiry (past) then immediately purges
    const count = await run(runWorkerTick(replayRetentionWorker, 'inst-1'))
    expect(count).toBe(2) // 1 expiry set + 1 purge

    // Events should be deleted from storage
    const events = await Effect.runPromise(objectStorage.getObject(eventsKey))
    expect(events).toBeNull()

    // replay_expires_at should be set to sentinel
    const row = await Effect.runPromise(sandboxRepo.findById(id, 'org_test'))
    expect(row!.replayExpiresAt!.getTime()).toBe(PURGED_SENTINEL.getTime())
  })

  test('does not purge replays that have not expired yet', async () => {
    const endedAt = new Date() // Just ended
    const id = await createStoppedSandbox('org_test', endedAt)

    // Set expiry (endedAt + 30 days = 30 days from now)
    await run(runWorkerTick(replayRetentionWorker, 'inst-1'))

    const row = await Effect.runPromise(sandboxRepo.findById(id, 'org_test'))
    expect(row!.replayExpiresAt!.getTime()).toBeGreaterThan(Date.now())

    // Second run should not purge
    const count = await run(runWorkerTick(replayRetentionWorker, 'inst-1'))
    expect(count).toBe(0)
  })

  test('does not re-purge already purged replays', async () => {
    const id = generateUUIDv7()
    await Effect.runPromise(
      sandboxRepo.create({
        id,
        orgId: 'org_test',
        imageId: SEED_IMAGE_ID,
        profileId: SEED_PROFILE_ID,
        profileName: 'small',
        env: null,
        ttlSeconds: 3600,
        imageRef: 'sandchest://ubuntu-22.04',
      }),
    )
    const endedAt = new Date(Date.now() - 31 * 86_400_000)
    await Effect.runPromise(
      sandboxRepo.updateStatus(id, 'org_test', 'stopped', { endedAt }),
    )

    // First run: sets expiry
    await run(runWorkerTick(replayRetentionWorker, 'inst-1'))
    // Second run: purges
    await run(runWorkerTick(replayRetentionWorker, 'inst-1'))

    // Third run: should not re-process (sentinel blocks re-set and re-purge)
    const count = await run(runWorkerTick(replayRetentionWorker, 'inst-1'))
    expect(count).toBe(0)
  })

  test('handles multiple orgs with different retention periods', async () => {
    quotaApi.setOrgQuota('org_short', { replayRetentionDays: 1 })
    // org_long uses default 30 days

    const endedAt = new Date(Date.now() - 2 * 86_400_000) // 2 days ago

    const shortId = await createStoppedSandbox('org_short', endedAt)
    const longId = await createStoppedSandbox('org_long', endedAt)

    // Single run: sets both expiries + purges the already-expired short one
    const count = await run(runWorkerTick(replayRetentionWorker, 'inst-1'))
    expect(count).toBe(3) // 2 expiries set + 1 purge

    const shortRow = await Effect.runPromise(sandboxRepo.findById(shortId, 'org_short'))
    const longRow = await Effect.runPromise(sandboxRepo.findById(longId, 'org_long'))

    // org_short: purged (sentinel)
    expect(shortRow!.replayExpiresAt!.getTime()).toBe(PURGED_SENTINEL.getTime())
    // org_long: endedAt + 30 days = 28 days from now (not expired)
    expect(longRow!.replayExpiresAt!.getTime()).toBeGreaterThan(Date.now())
  })
})
