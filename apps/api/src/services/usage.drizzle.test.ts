import { Effect } from 'effect'
import { describe, expect, test, beforeAll, beforeEach, afterAll } from 'bun:test'
import { createDrizzleUsageApi, makeUsageDrizzle } from './usage.drizzle.js'
import type { UsageApi } from './usage.js'
import { createDatabase, type Database } from '@sandchest/db/client'
import { sql } from 'drizzle-orm'

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

describe('module exports', () => {
  test('createDrizzleUsageApi is a function', () => {
    expect(typeof createDrizzleUsageApi).toBe('function')
  })

  test('makeUsageDrizzle is a function', () => {
    expect(typeof makeUsageDrizzle).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// Integration tests — requires DATABASE_URL
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL

describe.skipIf(!DATABASE_URL)('usage.drizzle (integration)', () => {
  let db: Database
  let api: UsageApi

  function run<A>(effect: Effect.Effect<A, never, never>): Promise<A> {
    return Effect.runPromise(effect)
  }

  const ORG_A = 'org_usage_test_a'
  const ORG_B = 'org_usage_test_b'

  beforeAll(() => {
    db = createDatabase(DATABASE_URL!, { connectionLimit: 2 })
    api = createDrizzleUsageApi(db)
  })

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM org_usage WHERE org_id IN (${ORG_A}, ${ORG_B})`)
  })

  afterAll(async () => {
    // @ts-expect-error accessing pool for cleanup
    await db?._.pool?.end?.()
  })

  // -- recordSandboxMinutes --------------------------------------------------

  describe('recordSandboxMinutes', () => {
    test('inserts and increments sandbox minutes', async () => {
      await run(api.recordSandboxMinutes(ORG_A, 5))
      await run(api.recordSandboxMinutes(ORG_A, 3))
      const usage = await run(api.getCurrentPeriodUsage(ORG_A))
      expect(usage.sandboxMinutes).toBe(8)
      expect(usage.execCount).toBe(0)
      expect(usage.storageBytes).toBe(0)
    })

    test('tracks orgs independently', async () => {
      await run(api.recordSandboxMinutes(ORG_A, 10))
      await run(api.recordSandboxMinutes(ORG_B, 20))
      const usageA = await run(api.getCurrentPeriodUsage(ORG_A))
      const usageB = await run(api.getCurrentPeriodUsage(ORG_B))
      expect(usageA.sandboxMinutes).toBe(10)
      expect(usageB.sandboxMinutes).toBe(20)
    })
  })

  // -- recordExec ------------------------------------------------------------

  describe('recordExec', () => {
    test('increments exec count by 1 when no count given', async () => {
      await run(api.recordExec(ORG_A))
      await run(api.recordExec(ORG_A))
      await run(api.recordExec(ORG_A))
      const usage = await run(api.getCurrentPeriodUsage(ORG_A))
      expect(usage.execCount).toBe(3)
    })

    test('increments exec count by specified amount', async () => {
      await run(api.recordExec(ORG_A, 5))
      const usage = await run(api.getCurrentPeriodUsage(ORG_A))
      expect(usage.execCount).toBe(5)
    })
  })

  // -- recordStorageBytes ----------------------------------------------------

  describe('recordStorageBytes', () => {
    test('increments storage bytes', async () => {
      await run(api.recordStorageBytes(ORG_A, 1024))
      await run(api.recordStorageBytes(ORG_A, 2048))
      const usage = await run(api.getCurrentPeriodUsage(ORG_A))
      expect(usage.storageBytes).toBe(3072)
    })

    test('supports negative values for deletions', async () => {
      await run(api.recordStorageBytes(ORG_A, 5000))
      await run(api.recordStorageBytes(ORG_A, -2000))
      const usage = await run(api.getCurrentPeriodUsage(ORG_A))
      expect(usage.storageBytes).toBe(3000)
    })
  })

  // -- getCurrentPeriodUsage -------------------------------------------------

  describe('getCurrentPeriodUsage', () => {
    test('returns zeros for org with no usage', async () => {
      const usage = await run(api.getCurrentPeriodUsage(ORG_A))
      expect(usage).toEqual({ sandboxMinutes: 0, execCount: 0, storageBytes: 0 })
    })

    test('returns combined metrics for current period', async () => {
      await run(api.recordSandboxMinutes(ORG_A, 15))
      await run(api.recordExec(ORG_A, 7))
      await run(api.recordStorageBytes(ORG_A, 4096))
      const usage = await run(api.getCurrentPeriodUsage(ORG_A))
      expect(usage).toEqual({ sandboxMinutes: 15, execCount: 7, storageBytes: 4096 })
    })
  })

  // -- getUsage --------------------------------------------------------------

  describe('getUsage', () => {
    test('sums usage across date range', async () => {
      const day1 = new Date('2025-01-01T00:00:00.000Z')
      const day2 = new Date('2025-01-02T00:00:00.000Z')
      const day3 = new Date('2025-01-03T00:00:00.000Z')

      await db.execute(sql`INSERT INTO org_usage (org_id, period_start, sandbox_minutes, exec_count, storage_bytes) VALUES
        (${ORG_A}, ${day1}, 10, 5, 1000),
        (${ORG_A}, ${day2}, 20, 10, 2000),
        (${ORG_A}, ${day3}, 30, 15, 3000)`)

      // Range [day1, day3) should include day1 and day2 only
      const usage = await run(api.getUsage(ORG_A, day1, day3))
      expect(usage.sandboxMinutes).toBe(30)
      expect(usage.execCount).toBe(15)
      expect(usage.storageBytes).toBe(3000)
    })

    test('returns zeros for empty range', async () => {
      const from = new Date('2025-06-01T00:00:00.000Z')
      const to = new Date('2025-06-30T00:00:00.000Z')
      const usage = await run(api.getUsage(ORG_A, from, to))
      expect(usage).toEqual({ sandboxMinutes: 0, execCount: 0, storageBytes: 0 })
    })

    test('excludes other orgs from range query', async () => {
      const day1 = new Date('2025-01-01T00:00:00.000Z')
      await db.execute(sql`INSERT INTO org_usage (org_id, period_start, sandbox_minutes, exec_count, storage_bytes) VALUES
        (${ORG_A}, ${day1}, 10, 5, 1000),
        (${ORG_B}, ${day1}, 99, 99, 9999)`)

      const usage = await run(api.getUsage(ORG_A, day1, new Date('2025-01-02T00:00:00.000Z')))
      expect(usage.sandboxMinutes).toBe(10)
      expect(usage.execCount).toBe(5)
    })
  })

  // -- getUsageByPeriod ------------------------------------------------------

  describe('getUsageByPeriod', () => {
    test('returns sorted daily periods', async () => {
      const day1 = new Date('2025-01-01T00:00:00.000Z')
      const day2 = new Date('2025-01-02T00:00:00.000Z')
      const day3 = new Date('2025-01-03T00:00:00.000Z')

      await db.execute(sql`INSERT INTO org_usage (org_id, period_start, sandbox_minutes, exec_count, storage_bytes) VALUES
        (${ORG_A}, ${day3}, 30, 15, 3000),
        (${ORG_A}, ${day1}, 10, 5, 1000),
        (${ORG_A}, ${day2}, 20, 10, 2000)`)

      const from = new Date('2025-01-01T00:00:00.000Z')
      const to = new Date('2025-01-04T00:00:00.000Z')
      const periods = await run(api.getUsageByPeriod(ORG_A, from, to))

      expect(periods).toHaveLength(3)
      expect(periods[0].sandboxMinutes).toBe(10)
      expect(periods[1].sandboxMinutes).toBe(20)
      expect(periods[2].sandboxMinutes).toBe(30)
    })

    test('returns empty array for no data', async () => {
      const from = new Date('2025-06-01T00:00:00.000Z')
      const to = new Date('2025-06-30T00:00:00.000Z')
      const periods = await run(api.getUsageByPeriod(ORG_A, from, to))
      expect(periods).toEqual([])
    })
  })
})
