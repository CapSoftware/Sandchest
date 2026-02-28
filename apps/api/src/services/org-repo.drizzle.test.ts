import { Effect } from 'effect'
import { describe, expect, test, beforeAll, beforeEach, afterAll } from 'bun:test'
import { createDrizzleOrgRepo, makeOrgRepoDrizzle } from './org-repo.drizzle.js'
import type { OrgRepoApi } from './org-repo.js'
import { createDatabase, type Database } from '@sandchest/db/client'
import { sql } from 'drizzle-orm'

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

describe('module exports', () => {
  test('createDrizzleOrgRepo is a function', () => {
    expect(typeof createDrizzleOrgRepo).toBe('function')
  })

  test('makeOrgRepoDrizzle is a function', () => {
    expect(typeof makeOrgRepoDrizzle).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// Integration tests — requires DATABASE_URL
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL

describe.skipIf(!DATABASE_URL)('org-repo.drizzle (integration)', () => {
  let db: Database
  let repo: OrgRepoApi

  function run<A>(effect: Effect.Effect<A, never, never>): Promise<A> {
    return Effect.runPromise(effect)
  }

  const ORG_A = 'org_repo_test_a'
  const ORG_B = 'org_repo_test_b'

  beforeAll(() => {
    db = createDatabase(DATABASE_URL!, { connectionLimit: 2 })
    repo = createDrizzleOrgRepo(db)
  })

  beforeEach(async () => {
    // Clean up test data
    await db.execute(sql`DELETE FROM org_quotas WHERE org_id IN (${ORG_A}, ${ORG_B})`)
    await db.execute(sql`DELETE FROM org_usage WHERE org_id IN (${ORG_A}, ${ORG_B})`)
  })

  afterAll(async () => {
    // @ts-expect-error accessing pool for cleanup
    await db?._.pool?.end?.()
  })

  // -- deleteQuota -----------------------------------------------------------

  describe('deleteQuota', () => {
    test('deletes existing quota row', async () => {
      await db.execute(sql`INSERT INTO org_quotas (org_id) VALUES (${ORG_A})`)
      const deleted = await run(repo.deleteQuota(ORG_A))
      expect(deleted).toBe(1)
    })

    test('returns 0 when no quota row exists', async () => {
      const deleted = await run(repo.deleteQuota(ORG_A))
      expect(deleted).toBe(0)
    })
  })

  // -- deleteUsage -----------------------------------------------------------

  describe('deleteUsage', () => {
    test('deletes all usage rows for an org', async () => {
      const day1 = new Date('2025-01-01T00:00:00.000Z')
      const day2 = new Date('2025-01-02T00:00:00.000Z')
      await db.execute(sql`INSERT INTO org_usage (org_id, period_start, sandbox_minutes, exec_count, storage_bytes) VALUES
        (${ORG_A}, ${day1}, 10, 5, 1000),
        (${ORG_A}, ${day2}, 20, 10, 2000)`)

      const deleted = await run(repo.deleteUsage(ORG_A))
      expect(deleted).toBe(2)
    })

    test('returns 0 when no usage rows exist', async () => {
      const deleted = await run(repo.deleteUsage(ORG_A))
      expect(deleted).toBe(0)
    })

    test('does not affect other orgs', async () => {
      const day1 = new Date('2025-01-01T00:00:00.000Z')
      await db.execute(sql`INSERT INTO org_usage (org_id, period_start, sandbox_minutes, exec_count, storage_bytes) VALUES
        (${ORG_A}, ${day1}, 10, 5, 1000),
        (${ORG_B}, ${day1}, 99, 99, 9999)`)

      await run(repo.deleteUsage(ORG_A))

      const [remaining] = await db.execute(
        sql`SELECT COUNT(*) as cnt FROM org_usage WHERE org_id = ${ORG_B}`,
      )
      expect((remaining as unknown as Array<{ cnt: number }>)[0].cnt).toBe(1)
    })
  })
})
