import { Effect, Either, Layer } from 'effect'
import { describe, expect, test } from 'bun:test'
import { schedule, releaseSlot, renewSlot, NodeLookup, type SchedulerNode } from './scheduler.js'
import { RedisService } from './redis.js'
import { createInMemoryRedisApi } from './redis.memory.js'

function makeNodeLookup(nodes: SchedulerNode[]) {
  return Layer.succeed(NodeLookup, {
    getOnlineNodes: () => Effect.succeed(nodes),
  })
}

function runEither<A, E>(
  effect: Effect.Effect<A, E, RedisService | NodeLookup>,
  nodes: SchedulerNode[],
) {
  return effect.pipe(
    Effect.either,
    Effect.provide(Layer.sync(RedisService, createInMemoryRedisApi)),
    Effect.provide(makeNodeLookup(nodes)),
    Effect.runPromise,
  )
}

function runRedis<A>(effect: Effect.Effect<A, never, RedisService>) {
  return effect.pipe(
    Effect.provide(Layer.sync(RedisService, createInMemoryRedisApi)),
    Effect.runPromise,
  )
}

// ---------------------------------------------------------------------------
// Node selection
// ---------------------------------------------------------------------------

describe('scheduler — node selection', () => {
  test('one online node with capacity assigns to that node', async () => {
    const nodes: SchedulerNode[] = [
      { id: 'node_1', slotsTotal: 4, status: 'online' },
    ]
    const result = await runEither(schedule('sb_test1'), nodes)
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right.nodeId).toBe('node_1')
      expect(result.right.slot).toBe(0)
    }
  })

  test('multiple online nodes assigns to first with available slots', async () => {
    const nodes: SchedulerNode[] = [
      { id: 'node_1', slotsTotal: 4, status: 'online' },
      { id: 'node_2', slotsTotal: 4, status: 'online' },
    ]
    const result = await runEither(schedule('sb_test2'), nodes)
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right.nodeId).toBe('node_1')
    }
  })

  test('no online nodes fails with NoCapacity', async () => {
    const nodes: SchedulerNode[] = []
    const result = await runEither(schedule('sb_test3'), nodes)
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe('NoCapacityError')
      expect(result.left.message).toContain('No online nodes')
    }
  })

  test('all nodes at capacity fails with NoCapacity', async () => {
    const nodes: SchedulerNode[] = [
      { id: 'node_1', slotsTotal: 1, status: 'online' },
    ]

    const redisApi = createInMemoryRedisApi()
    const redisLayer = Layer.succeed(RedisService, redisApi)
    const nodeLookup = makeNodeLookup(nodes)

    // Fill the only slot
    await schedule('sb_fill').pipe(
      Effect.provide(redisLayer),
      Effect.provide(nodeLookup),
      Effect.runPromise,
    )

    // Now try to schedule another — should fail
    const result = await schedule('sb_overflow').pipe(
      Effect.either,
      Effect.provide(redisLayer),
      Effect.provide(nodeLookup),
      Effect.runPromise,
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe('NoCapacityError')
      expect(result.left.message).toContain('at capacity')
    }
  })
})

// ---------------------------------------------------------------------------
// Slot leasing through scheduler
// ---------------------------------------------------------------------------

describe('scheduler — slot leasing', () => {
  test('concurrent schedules get different slots', async () => {
    const nodes: SchedulerNode[] = [
      { id: 'node_1', slotsTotal: 4, status: 'online' },
    ]
    const redisApi = createInMemoryRedisApi()
    const redisLayer = Layer.succeed(RedisService, redisApi)
    const nodeLookup = makeNodeLookup(nodes)

    const r1 = await schedule('sb_1').pipe(
      Effect.provide(redisLayer),
      Effect.provide(nodeLookup),
      Effect.runPromise,
    )
    const r2 = await schedule('sb_2').pipe(
      Effect.provide(redisLayer),
      Effect.provide(nodeLookup),
      Effect.runPromise,
    )

    expect(r1.nodeId).toBe('node_1')
    expect(r2.nodeId).toBe('node_1')
    expect(r1.slot).not.toBe(r2.slot)
  })

  test('released slot can be re-acquired', async () => {
    const nodes: SchedulerNode[] = [
      { id: 'node_1', slotsTotal: 1, status: 'online' },
    ]
    const redisApi = createInMemoryRedisApi()
    const redisLayer = Layer.succeed(RedisService, redisApi)
    const nodeLookup = makeNodeLookup(nodes)

    const r1 = await schedule('sb_1').pipe(
      Effect.provide(redisLayer),
      Effect.provide(nodeLookup),
      Effect.runPromise,
    )

    await releaseSlot(r1.nodeId, r1.slot).pipe(
      Effect.provide(redisLayer),
      Effect.runPromise,
    )

    const r2 = await schedule('sb_2').pipe(
      Effect.provide(redisLayer),
      Effect.provide(nodeLookup),
      Effect.runPromise,
    )

    expect(r2.nodeId).toBe('node_1')
    expect(r2.slot).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Slot renewal
// ---------------------------------------------------------------------------

describe('scheduler — slot renewal', () => {
  test('renewSlot returns true for active lease', async () => {
    const redisApi = createInMemoryRedisApi()
    const redisLayer = Layer.succeed(RedisService, redisApi)

    await Effect.runPromise(
      redisApi.acquireSlotLease('node_1', 0, 'sb_1', 60),
    )

    const renewed = await renewSlot('node_1', 0).pipe(
      Effect.provide(redisLayer),
      Effect.runPromise,
    )
    expect(renewed).toBe(true)
  })

  test('renewSlot returns false for non-existent lease', async () => {
    const result = await runRedis(renewSlot('node_1', 99))
    expect(result).toBe(false)
  })
})
