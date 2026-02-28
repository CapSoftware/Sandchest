import { Effect } from 'effect'
import { describe, expect, test, beforeEach, afterAll } from 'bun:test'
import { createDrizzleIdempotencyRepo, makeIdempotencyRepoDrizzle } from './idempotency-cleanup.drizzle.js'
import type { IdempotencyRepoApi } from './idempotency-cleanup.js'
import { createDatabase, type Database } from '@sandchest/db/client'
import { sql } from 'drizzle-orm'

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

describe('module exports', () => {
  test('createDrizzleIdempotencyRepo is a function', () => {
    expect(typeof createDrizzleIdempotencyRepo).toBe('function')
  })

  test('makeIdempotencyRepoDrizzle is a function', () => {
    expect(typeof makeIdempotencyRepoDrizzle).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// Integration tests — requires DATABASE_URL
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL

describe.skipIf(!DATABASE_URL)('idempotency-cleanup.drizzle (integration)', () => {
  let db: Database
  let repo: IdempotencyRepoApi

  function run<A>(effect: Effect.Effect<A, never, never>): Promise<A> {
    return Effect.runPromise(effect)
  }

  const ORG_A = 'org_idem_test_a'
  const ORG_B = 'org_idem_test_b'

  beforeEach(async () => {
    db = createDatabase(DATABASE_URL!)
    repo = createDrizzleIdempotencyRepo(db)
    await db.execute(sql`DELETE FROM idempotency_keys WHERE org_id IN (${ORG_A}, ${ORG_B})`)
  })

  afterAll(async () => {
    // @ts-expect-error accessing pool for cleanup
    await db?._.pool?.end?.()
  })

  // -- deleteOlderThan -------------------------------------------------------

  describe('deleteOlderThan', () => {
    test('deletes keys older than cutoff', async () => {
      const old = new Date('2025-01-01T00:00:00.000Z')
      const recent = new Date('2025-06-01T00:00:00.000Z')
      const cutoff = new Date('2025-03-01T00:00:00.000Z')

      await db.execute(sql`INSERT INTO idempotency_keys (idem_key, org_id, created_at) VALUES
        (${'key_old_1'}, ${ORG_A}, ${old}),
        (${'key_recent_1'}, ${ORG_A}, ${recent})`)

      const deleted = await run(repo.deleteOlderThan(cutoff))
      expect(deleted).toBe(1)

      const [remaining] = await db.execute(
        sql`SELECT COUNT(*) as cnt FROM idempotency_keys WHERE org_id = ${ORG_A}`,
      )
      expect((remaining as unknown as Array<{ cnt: number }>)[0].cnt).toBe(1)
    })

    test('returns 0 when nothing to delete', async () => {
      const deleted = await run(repo.deleteOlderThan(new Date('2020-01-01T00:00:00.000Z')))
      expect(deleted).toBe(0)
    })
  })

  // -- deleteByOrgId ---------------------------------------------------------

  describe('deleteByOrgId', () => {
    test('deletes all keys for an org', async () => {
      const now = new Date()
      await db.execute(sql`INSERT INTO idempotency_keys (idem_key, org_id, created_at) VALUES
        (${'key_a1'}, ${ORG_A}, ${now}),
        (${'key_a2'}, ${ORG_A}, ${now}),
        (${'key_b1'}, ${ORG_B}, ${now})`)

      const deleted = await run(repo.deleteByOrgId(ORG_A))
      expect(deleted).toBe(2)

      const [remaining] = await db.execute(
        sql`SELECT COUNT(*) as cnt FROM idempotency_keys WHERE org_id = ${ORG_B}`,
      )
      expect((remaining as unknown as Array<{ cnt: number }>)[0].cnt).toBe(1)
    })

    test('returns 0 when no keys for org', async () => {
      const deleted = await run(repo.deleteByOrgId(ORG_A))
      expect(deleted).toBe(0)
    })
  })
})
