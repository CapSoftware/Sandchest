import { Effect } from 'effect'
import { describe, expect, test, beforeAll, beforeEach, afterAll } from 'bun:test'
import { createDrizzleQuotaApi, makeQuotaDrizzle } from './quota.drizzle.js'
import { DEFAULT_QUOTA, type QuotaApi } from './quota.js'
import { createDatabase, type Database } from '@sandchest/db/client'
import { sql } from 'drizzle-orm'

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

describe('module exports', () => {
  test('createDrizzleQuotaApi is a function', () => {
    expect(typeof createDrizzleQuotaApi).toBe('function')
  })

  test('makeQuotaDrizzle is a function', () => {
    expect(typeof makeQuotaDrizzle).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// Integration tests — requires DATABASE_URL
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL

describe.skipIf(!DATABASE_URL)('quota.drizzle (integration)', () => {
  let db: Database
  let api: QuotaApi

  function run<A>(effect: Effect.Effect<A, never, never>): Promise<A> {
    return Effect.runPromise(effect)
  }

  const ORG_A = 'org_quota_test_a'
  const ORG_B = 'org_quota_test_b'

  beforeAll(() => {
    db = createDatabase(DATABASE_URL!, { connectionLimit: 2 })
    api = createDrizzleQuotaApi(db)
  })

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM org_quotas WHERE org_id IN (${ORG_A}, ${ORG_B})`)
  })

  afterAll(async () => {
    // @ts-expect-error accessing pool for cleanup
    await db?._.pool?.end?.()
  })

  // -- getOrgQuota -----------------------------------------------------------

  describe('getOrgQuota', () => {
    test('returns defaults when no row exists', async () => {
      const quota = await run(api.getOrgQuota(ORG_A))
      expect(quota).toEqual(DEFAULT_QUOTA)
    })

    test('returns custom values when row exists', async () => {
      await db.execute(
        sql`INSERT INTO org_quotas (org_id, max_concurrent_sandboxes, max_ttl_seconds) VALUES (${ORG_A}, 50, 7200)`,
      )

      const quota = await run(api.getOrgQuota(ORG_A))
      expect(quota.maxConcurrentSandboxes).toBe(50)
      expect(quota.maxTtlSeconds).toBe(7200)
      // Non-overridden fields stay at DB defaults
      expect(quota.maxExecTimeoutSeconds).toBe(DEFAULT_QUOTA.maxExecTimeoutSeconds)
    })

    test('different orgs have independent quotas', async () => {
      await db.execute(
        sql`INSERT INTO org_quotas (org_id, max_concurrent_sandboxes) VALUES (${ORG_A}, 100)`,
      )

      const quotaA = await run(api.getOrgQuota(ORG_A))
      const quotaB = await run(api.getOrgQuota(ORG_B))
      expect(quotaA.maxConcurrentSandboxes).toBe(100)
      expect(quotaB).toEqual(DEFAULT_QUOTA)
    })

    test('returns all quota fields correctly', async () => {
      await db.execute(sql`INSERT INTO org_quotas (
        org_id, max_concurrent_sandboxes, max_ttl_seconds, max_exec_timeout_seconds,
        artifact_retention_days, rate_sandbox_create_per_min, rate_exec_per_min,
        rate_read_per_min, idle_timeout_seconds, max_fork_depth, max_forks_per_sandbox,
        replay_retention_days
      ) VALUES (
        ${ORG_A}, 25, 3600, 1800, 60, 15, 60, 300, 450, 3, 5, 14
      )`)

      const quota = await run(api.getOrgQuota(ORG_A))
      expect(quota.maxConcurrentSandboxes).toBe(25)
      expect(quota.maxTtlSeconds).toBe(3600)
      expect(quota.maxExecTimeoutSeconds).toBe(1800)
      expect(quota.artifactRetentionDays).toBe(60)
      expect(quota.rateSandboxCreatePerMin).toBe(15)
      expect(quota.rateExecPerMin).toBe(60)
      expect(quota.rateReadPerMin).toBe(300)
      expect(quota.idleTimeoutSeconds).toBe(450)
      expect(quota.maxForkDepth).toBe(3)
      expect(quota.maxForksPerSandbox).toBe(5)
      expect(quota.replayRetentionDays).toBe(14)
    })
  })
})
