import { Effect } from 'effect'
import { describe, expect, test, beforeAll, beforeEach, afterAll } from 'bun:test'
import { generateUUIDv7 } from '@sandchest/contract'
import { createDrizzleMetricsRepo, makeMetricsRepoDrizzle } from './metrics-repo.drizzle.js'
import type { MetricsRepoApi, MetricsInput } from './metrics-repo.js'
import { createDatabase, type Database } from '@sandchest/db/client'
import { sql } from 'drizzle-orm'

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

describe('module exports', () => {
  test('createDrizzleMetricsRepo is a function', () => {
    expect(typeof createDrizzleMetricsRepo).toBe('function')
  })

  test('makeMetricsRepoDrizzle is a function', () => {
    expect(typeof makeMetricsRepoDrizzle).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// Integration tests — requires DATABASE_URL
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL

describe.skipIf(!DATABASE_URL)('metrics-repo.drizzle (integration)', () => {
  let db: Database
  let repo: MetricsRepoApi

  function run<A>(effect: Effect.Effect<A, never, never>): Promise<A> {
    return Effect.runPromise(effect)
  }

  const NODE_A = generateUUIDv7()
  const NODE_B = generateUUIDv7()

  function makeMetrics(nodeId: Uint8Array = NODE_A): MetricsInput {
    return {
      nodeId,
      cpuPercent: 42.5,
      memoryUsedBytes: 1073741824n,
      memoryTotalBytes: 4294967296n,
      diskUsedBytes: 10737418240n,
      diskTotalBytes: 107374182400n,
      networkRxBytes: 1048576n,
      networkTxBytes: 2097152n,
      loadAvg1: 1.5,
      loadAvg5: 1.2,
      loadAvg15: 0.8,
    }
  }

  beforeAll(() => {
    db = createDatabase(DATABASE_URL!, { connectionLimit: 2 })
    repo = createDrizzleMetricsRepo(db)
  })

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM node_metrics`)
  })

  afterAll(async () => {
    // @ts-expect-error accessing pool for cleanup
    await db?._.pool?.end?.()
  })

  // -- insert ---------------------------------------------------------------

  describe('insert', () => {
    test('inserts a metrics row', async () => {
      await run(repo.insert(makeMetrics()))
      const rows = await run(repo.getRecent(NODE_A, 10))
      expect(rows.length).toBe(1)
      expect(rows[0].cpuPercent).toBeCloseTo(42.5, 1)
      expect(rows[0].memoryUsedBytes).toBe(1073741824n)
      expect(rows[0].memoryTotalBytes).toBe(4294967296n)
      expect(rows[0].diskUsedBytes).toBe(10737418240n)
      expect(rows[0].diskTotalBytes).toBe(107374182400n)
      expect(rows[0].networkRxBytes).toBe(1048576n)
      expect(rows[0].networkTxBytes).toBe(2097152n)
      expect(rows[0].loadAvg1).toBeCloseTo(1.5, 1)
      expect(rows[0].loadAvg5).toBeCloseTo(1.2, 1)
      expect(rows[0].loadAvg15).toBeCloseTo(0.8, 1)
      expect(rows[0].createdAt).toBeInstanceOf(Date)
    })
  })

  // -- getRecent ------------------------------------------------------------

  describe('getRecent', () => {
    test('returns empty for unknown node', async () => {
      const rows = await run(repo.getRecent(generateUUIDv7(), 10))
      expect(rows).toEqual([])
    })

    test('returns most recent first', async () => {
      await run(repo.insert(makeMetrics()))
      await new Promise((r) => setTimeout(r, 10))
      await run(repo.insert({ ...makeMetrics(), cpuPercent: 90.0 }))

      const rows = await run(repo.getRecent(NODE_A, 10))
      expect(rows.length).toBe(2)
      expect(rows[0].cpuPercent).toBeCloseTo(90.0, 1)
    })

    test('respects limit', async () => {
      for (let i = 0; i < 5; i++) {
        await run(repo.insert(makeMetrics()))
      }

      const rows = await run(repo.getRecent(NODE_A, 3))
      expect(rows.length).toBe(3)
    })

    test('scoped to node', async () => {
      await run(repo.insert(makeMetrics(NODE_A)))
      await run(repo.insert(makeMetrics(NODE_B)))

      const rowsA = await run(repo.getRecent(NODE_A, 10))
      const rowsB = await run(repo.getRecent(NODE_B, 10))
      expect(rowsA.length).toBe(1)
      expect(rowsB.length).toBe(1)
    })
  })

  // -- deleteOlderThan ------------------------------------------------------

  describe('deleteOlderThan', () => {
    test('deletes metrics older than cutoff', async () => {
      await run(repo.insert(makeMetrics()))
      await new Promise((r) => setTimeout(r, 50))

      const cutoff = new Date()
      await new Promise((r) => setTimeout(r, 50))
      await run(repo.insert(makeMetrics()))

      const deleted = await run(repo.deleteOlderThan(cutoff))
      expect(deleted).toBe(1)

      const remaining = await run(repo.getRecent(NODE_A, 10))
      expect(remaining.length).toBe(1)
    })

    test('returns 0 when nothing to delete', async () => {
      const deleted = await run(repo.deleteOlderThan(new Date()))
      expect(deleted).toBe(0)
    })
  })
})
