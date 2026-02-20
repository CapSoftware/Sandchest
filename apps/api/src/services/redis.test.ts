import { Effect } from 'effect'
import { describe, expect, test, beforeEach } from 'bun:test'
import { createInMemoryRedisApi } from './redis.memory.js'
import type { RedisApi, BufferedEvent } from './redis.js'

let redis: RedisApi

beforeEach(() => {
  redis = createInMemoryRedisApi()
})

function run<A>(effect: Effect.Effect<A, never, never>): Promise<A> {
  return Effect.runPromise(effect)
}

// ---------------------------------------------------------------------------
// Slot leasing
// ---------------------------------------------------------------------------

describe('slot leasing', () => {
  test('acquireSlotLease returns true on success', async () => {
    const result = await run(redis.acquireSlotLease('node_1', 0, 'sb_abc', 60))
    expect(result).toBe(true)
  })

  test('acquireSlotLease on already-leased slot returns false', async () => {
    await run(redis.acquireSlotLease('node_1', 0, 'sb_abc', 60))
    const result = await run(redis.acquireSlotLease('node_1', 0, 'sb_def', 60))
    expect(result).toBe(false)
  })

  test('different slots on same node are independent', async () => {
    await run(redis.acquireSlotLease('node_1', 0, 'sb_abc', 60))
    const result = await run(redis.acquireSlotLease('node_1', 1, 'sb_def', 60))
    expect(result).toBe(true)
  })

  test('same slot on different nodes are independent', async () => {
    await run(redis.acquireSlotLease('node_1', 0, 'sb_abc', 60))
    const result = await run(redis.acquireSlotLease('node_2', 0, 'sb_def', 60))
    expect(result).toBe(true)
  })

  test('releaseSlotLease makes slot available again', async () => {
    await run(redis.acquireSlotLease('node_1', 0, 'sb_abc', 60))
    await run(redis.releaseSlotLease('node_1', 0))
    const result = await run(redis.acquireSlotLease('node_1', 0, 'sb_def', 60))
    expect(result).toBe(true)
  })

  test('renewSlotLease returns true for existing lease', async () => {
    await run(redis.acquireSlotLease('node_1', 0, 'sb_abc', 60))
    const result = await run(redis.renewSlotLease('node_1', 0, 120))
    expect(result).toBe(true)
  })

  test('renewSlotLease returns false for non-existent lease', async () => {
    const result = await run(redis.renewSlotLease('node_1', 0, 120))
    expect(result).toBe(false)
  })

  test('expired lease allows re-acquisition', async () => {
    // Use a very short TTL (0 seconds = immediate expiry)
    await run(redis.acquireSlotLease('node_1', 0, 'sb_abc', 0))
    // Wait a tick for expiry
    await new Promise((r) => setTimeout(r, 5))
    const result = await run(redis.acquireSlotLease('node_1', 0, 'sb_def', 60))
    expect(result).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe('rate limiting', () => {
  test('within limit allows request', async () => {
    const result = await run(redis.checkRateLimit('org_1', 'exec', 10, 60))
    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(9)
  })

  test('at limit rejects request', async () => {
    // Exhaust the limit
    for (let i = 0; i < 5; i++) {
      await run(redis.checkRateLimit('org_1', 'exec', 5, 60))
    }
    // Next request should be rejected
    const result = await run(redis.checkRateLimit('org_1', 'exec', 5, 60))
    expect(result.allowed).toBe(false)
    expect(result.remaining).toBe(0)
  })

  test('different org IDs have independent counters', async () => {
    for (let i = 0; i < 3; i++) {
      await run(redis.checkRateLimit('org_1', 'exec', 3, 60))
    }
    const result = await run(redis.checkRateLimit('org_2', 'exec', 3, 60))
    expect(result.allowed).toBe(true)
  })

  test('different categories have independent counters', async () => {
    for (let i = 0; i < 3; i++) {
      await run(redis.checkRateLimit('org_1', 'exec', 3, 60))
    }
    const result = await run(redis.checkRateLimit('org_1', 'read', 3, 60))
    expect(result.allowed).toBe(true)
  })

  test('resetAt is in the future', async () => {
    const now = Date.now()
    const result = await run(redis.checkRateLimit('org_1', 'exec', 10, 60))
    expect(result.resetAt).toBeGreaterThan(now)
  })
})

// ---------------------------------------------------------------------------
// Exec event buffering
// ---------------------------------------------------------------------------

describe('exec event buffering', () => {
  const event1: BufferedEvent = { seq: 1, ts: '2026-01-01T00:00:00Z', data: { type: 'stdout', chunk: 'hello' } }
  const event2: BufferedEvent = { seq: 2, ts: '2026-01-01T00:00:01Z', data: { type: 'stdout', chunk: 'world' } }
  const event3: BufferedEvent = { seq: 3, ts: '2026-01-01T00:00:02Z', data: { type: 'exit', code: 0 } }

  test('pushExecEvent and getExecEvents round-trip', async () => {
    await run(redis.pushExecEvent('ex_1', event1, 300))
    await run(redis.pushExecEvent('ex_1', event2, 300))
    const events = await run(redis.getExecEvents('ex_1', 0))
    expect(events).toEqual([event1, event2])
  })

  test('getExecEvents filters by afterSeq', async () => {
    await run(redis.pushExecEvent('ex_1', event1, 300))
    await run(redis.pushExecEvent('ex_1', event2, 300))
    await run(redis.pushExecEvent('ex_1', event3, 300))
    const events = await run(redis.getExecEvents('ex_1', 1))
    expect(events).toEqual([event2, event3])
  })

  test('getExecEvents returns empty for unknown exec', async () => {
    const events = await run(redis.getExecEvents('ex_unknown', 0))
    expect(events).toEqual([])
  })

  test('different exec IDs are independent', async () => {
    await run(redis.pushExecEvent('ex_1', event1, 300))
    await run(redis.pushExecEvent('ex_2', event2, 300))
    const events1 = await run(redis.getExecEvents('ex_1', 0))
    const events2 = await run(redis.getExecEvents('ex_2', 0))
    expect(events1).toEqual([event1])
    expect(events2).toEqual([event2])
  })
})

// ---------------------------------------------------------------------------
// Replay event buffering
// ---------------------------------------------------------------------------

describe('replay event buffering', () => {
  const event1: BufferedEvent = { seq: 1, ts: '2026-01-01T00:00:00Z', data: { type: 'sandbox_created' } }
  const event2: BufferedEvent = { seq: 2, ts: '2026-01-01T00:00:01Z', data: { type: 'exec_started' } }

  test('pushReplayEvent and getReplayEvents round-trip', async () => {
    await run(redis.pushReplayEvent('sb_1', event1, 600))
    await run(redis.pushReplayEvent('sb_1', event2, 600))
    const events = await run(redis.getReplayEvents('sb_1'))
    expect(events).toEqual([event1, event2])
  })

  test('getReplayEvents returns empty for unknown sandbox', async () => {
    const events = await run(redis.getReplayEvents('sb_unknown'))
    expect(events).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Ping
// ---------------------------------------------------------------------------

describe('ping', () => {
  test('returns true for in-memory implementation', async () => {
    const result = await run(redis.ping())
    expect(result).toBe(true)
  })
})
