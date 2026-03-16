import { Effect, Layer } from 'effect'
import { describe, expect, test, beforeEach } from 'bun:test'
import { createInMemoryRedisApi } from '../services/redis.memory.js'
import { createInMemorySandboxRepo } from '../services/sandbox-repo.memory.js'
import { createInMemoryBillingApi } from '../services/billing.memory.js'
import { RedisService, type RedisApi } from '../services/redis.js'
import { SandboxRepo, type SandboxRepoApi } from '../services/sandbox-repo.js'
import { BillingService } from '../services/billing.js'
import { NodeClientRegistry } from '../services/node-client-registry.js'
import { NodeClientRegistryMemory } from '../services/node-client-registry.memory.js'
import { NodeLookup } from '../services/scheduler.js'
import { createNodeLookupMemory } from '../services/node-lookup.live.js'
import { runWorkerTick } from './runner.js'
import { idleShutdownWorker } from './idle-shutdown.js'
import { generateUUIDv7 } from '@sandchest/contract'

const SEED_IMAGE_ID = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0])
const SEED_PROFILE_ID = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])

const IDLE_THRESHOLD_MS = 900_000 // 15 minutes

type TestDeps = SandboxRepo | NodeClientRegistry | BillingService | RedisService | NodeLookup

let redis: RedisApi
let sandboxRepo: SandboxRepoApi
let testLayer: Layer.Layer<TestDeps>

function run<A>(effect: Effect.Effect<A, never, TestDeps>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(testLayer)))
}

beforeEach(() => {
  redis = createInMemoryRedisApi()
  sandboxRepo = createInMemorySandboxRepo()
  const billingApi = createInMemoryBillingApi()

  testLayer = Layer.mergeAll(
    Layer.succeed(RedisService, redis),
    Layer.succeed(SandboxRepo, sandboxRepo),
    Layer.succeed(BillingService, billingApi),
    NodeClientRegistryMemory,
    createNodeLookupMemory([]),
  )
})

describe('idle-shutdown worker', () => {
  test('returns 0 for empty state', async () => {
    const count = await run(runWorkerTick(idleShutdownWorker, 'inst-1'))
    expect(count).toBe(0)
  })

  test('does not shut down recently active running sandboxes', async () => {
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
    await Effect.runPromise(sandboxRepo.assignNode(id, 'org_test', generateUUIDv7()))
    // lastActivityAt set to now by assignNode — not idle

    const count = await run(runWorkerTick(idleShutdownWorker, 'inst-1'))
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
        ttlSeconds: 3600,
        imageRef: 'sandchest://ubuntu-22.04',
      }),
    )
    // Leave as 'queued'

    const count = await run(runWorkerTick(idleShutdownWorker, 'inst-1'))
    expect(count).toBe(0)
  })

  test('shuts down sandboxes idle beyond 15 minutes', async () => {
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
    await Effect.runPromise(sandboxRepo.assignNode(id, 'org_test', generateUUIDv7()))

    // Backdate lastActivityAt to 16 minutes ago
    const row = await Effect.runPromise(sandboxRepo.findById(id, 'org_test'))
    ;(row as { lastActivityAt: Date }).lastActivityAt = new Date(Date.now() - IDLE_THRESHOLD_MS - 60_000)

    const count = await run(runWorkerTick(idleShutdownWorker, 'inst-1'))
    expect(count).toBe(1)

    const updated = await Effect.runPromise(sandboxRepo.findById(id, 'org_test'))
    expect(updated!.status).toBe('stopped')
    expect(updated!.failureReason).toBe('idle_timeout')
    expect(updated!.endedAt).toBeInstanceOf(Date)
  })

  test('touchLastActivity prevents idle shutdown', async () => {
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
    await Effect.runPromise(sandboxRepo.assignNode(id, 'org_test', generateUUIDv7()))

    // Backdate lastActivityAt to 16 minutes ago
    const row = await Effect.runPromise(sandboxRepo.findById(id, 'org_test'))
    ;(row as { lastActivityAt: Date }).lastActivityAt = new Date(Date.now() - IDLE_THRESHOLD_MS - 60_000)

    // Touch activity — brings it back to now
    await Effect.runPromise(sandboxRepo.touchLastActivity(id, 'org_test'))

    const count = await run(runWorkerTick(idleShutdownWorker, 'inst-1'))
    expect(count).toBe(0)

    const updated = await Effect.runPromise(sandboxRepo.findById(id, 'org_test'))
    expect(updated!.status).toBe('running')
  })

  test('shuts down multiple idle sandboxes in one tick', async () => {
    const ids = [generateUUIDv7(), generateUUIDv7()]
    for (const id of ids) {
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
      await Effect.runPromise(sandboxRepo.assignNode(id, 'org_test', generateUUIDv7()))
      const row = await Effect.runPromise(sandboxRepo.findById(id, 'org_test'))
      ;(row as { lastActivityAt: Date }).lastActivityAt = new Date(Date.now() - IDLE_THRESHOLD_MS - 60_000)
    }

    const count = await run(runWorkerTick(idleShutdownWorker, 'inst-1'))
    expect(count).toBe(2)

    for (const id of ids) {
      const row = await Effect.runPromise(sandboxRepo.findById(id, 'org_test'))
      expect(row!.status).toBe('stopped')
    }
  })

  test('releases slot when sandbox has a slotIndex', async () => {
    const nodeId = generateUUIDv7()
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
    await Effect.runPromise(sandboxRepo.assignNode(id, 'org_test', nodeId, 5))

    const row = await Effect.runPromise(sandboxRepo.findById(id, 'org_test'))
    ;(row as { lastActivityAt: Date }).lastActivityAt = new Date(Date.now() - IDLE_THRESHOLD_MS - 60_000)

    // Should not throw even when slot release is attempted
    const count = await run(runWorkerTick(idleShutdownWorker, 'inst-1'))
    expect(count).toBe(1)

    const updated = await Effect.runPromise(sandboxRepo.findById(id, 'org_test'))
    expect(updated!.status).toBe('stopped')
  })
})
