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
import { vmTeardownWorker } from './vm-teardown.js'
import { generateUUIDv7 } from '@sandchest/contract'

const SEED_IMAGE_ID = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0])
const SEED_PROFILE_ID = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])

/** Grace period the worker uses before forcibly destroying (30 seconds). */
const STOPPING_GRACE_SECONDS = 30

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

describe('vm-teardown worker', () => {
  test('returns 0 with no sandboxes', async () => {
    const count = await run(runWorkerTick(vmTeardownWorker, 'inst-1'))
    expect(count).toBe(0)
  })

  test('does not destroy recently stopping sandboxes within grace period', async () => {
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
    await Effect.runPromise(sandboxRepo.updateStatus(id, 'org_test', 'stopping'))
    // updatedAt is now — within grace period

    const count = await run(runWorkerTick(vmTeardownWorker, 'inst-1'))
    expect(count).toBe(0)
  })

  test('ignores non-stopping sandboxes', async () => {
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

    const count = await run(runWorkerTick(vmTeardownWorker, 'inst-1'))
    expect(count).toBe(0)
  })

  test('forcibly destroys sandboxes stuck in stopping beyond grace period', async () => {
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
    await Effect.runPromise(sandboxRepo.assignNode(id, 'org_test', nodeId))
    await Effect.runPromise(sandboxRepo.updateStatus(id, 'org_test', 'stopping'))

    // Backdate updatedAt to beyond grace period
    const row = await Effect.runPromise(sandboxRepo.findById(id, 'org_test'))
    ;(row as { updatedAt: Date }).updatedAt = new Date(
      Date.now() - (STOPPING_GRACE_SECONDS + 10) * 1000,
    )

    const count = await run(runWorkerTick(vmTeardownWorker, 'inst-1'))
    expect(count).toBe(1)

    const updated = await Effect.runPromise(sandboxRepo.findById(id, 'org_test'))
    expect(updated!.status).toBe('stopped')
    expect(updated!.endedAt).toBeInstanceOf(Date)
  })

  test('tears down multiple stuck sandboxes in one tick', async () => {
    const nodeId = generateUUIDv7()
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
      await Effect.runPromise(sandboxRepo.assignNode(id, 'org_test', nodeId))
      await Effect.runPromise(sandboxRepo.updateStatus(id, 'org_test', 'stopping'))
      const row = await Effect.runPromise(sandboxRepo.findById(id, 'org_test'))
      ;(row as { updatedAt: Date }).updatedAt = new Date(
        Date.now() - (STOPPING_GRACE_SECONDS + 10) * 1000,
      )
    }

    const count = await run(runWorkerTick(vmTeardownWorker, 'inst-1'))
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
    await Effect.runPromise(sandboxRepo.assignNode(id, 'org_test', nodeId, 7))
    await Effect.runPromise(sandboxRepo.updateStatus(id, 'org_test', 'stopping'))

    const row = await Effect.runPromise(sandboxRepo.findById(id, 'org_test'))
    ;(row as { updatedAt: Date }).updatedAt = new Date(
      Date.now() - (STOPPING_GRACE_SECONDS + 10) * 1000,
    )

    // Should not throw even when slot release is attempted
    const count = await run(runWorkerTick(vmTeardownWorker, 'inst-1'))
    expect(count).toBe(1)

    const updated = await Effect.runPromise(sandboxRepo.findById(id, 'org_test'))
    expect(updated!.status).toBe('stopped')
  })
})
