import { Effect } from 'effect'
import { describe, expect, test, beforeAll, beforeEach, afterAll } from 'bun:test'
import { createDrizzleAuditLog, makeAuditLogDrizzle } from './audit-log.drizzle.js'
import type { AuditLogApi } from './audit-log.js'
import { createDatabase, type Database } from '@sandchest/db/client'
import { sql } from 'drizzle-orm'

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

describe('module exports', () => {
  test('createDrizzleAuditLog is a function', () => {
    expect(typeof createDrizzleAuditLog).toBe('function')
  })

  test('makeAuditLogDrizzle is a function', () => {
    expect(typeof makeAuditLogDrizzle).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// Integration tests — requires DATABASE_URL
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL

describe.skipIf(!DATABASE_URL)('audit-log.drizzle (integration)', () => {
  let db: Database
  let api: AuditLogApi

  function run<A>(effect: Effect.Effect<A, never, never>): Promise<A> {
    return Effect.runPromise(effect)
  }

  const ORG_A = 'org_audit_test_a'
  const ORG_B = 'org_audit_test_b'

  beforeAll(() => {
    db = createDatabase(DATABASE_URL!, { connectionLimit: 2 })
    api = createDrizzleAuditLog(db)
  })

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM audit_logs WHERE org_id IN (${ORG_A}, ${ORG_B})`)
  })

  afterAll(async () => {
    // @ts-expect-error accessing pool for cleanup
    await db?._.pool?.end?.()
  })

  // -- append ----------------------------------------------------------------

  describe('append', () => {
    test('inserts an audit log entry', async () => {
      await run(api.append({
        orgId: ORG_A,
        actorId: 'user_1',
        action: 'sandbox.create',
        resourceType: 'sandbox',
        resourceId: 'sb_test123',
        metadata: { image: 'ubuntu-22.04' },
      }))

      const entries = await run(api.list(ORG_A))
      expect(entries.length).toBe(1)
      expect(entries[0].orgId).toBe(ORG_A)
      expect(entries[0].actorId).toBe('user_1')
      expect(entries[0].action).toBe('sandbox.create')
      expect(entries[0].resourceType).toBe('sandbox')
      expect(entries[0].resourceId).toBe('sb_test123')
      expect(entries[0].metadata).toEqual({ image: 'ubuntu-22.04' })
      expect(entries[0].createdAt).toBeInstanceOf(Date)
      expect(entries[0].id).toBeInstanceOf(Uint8Array)
    })

    test('handles null metadata', async () => {
      await run(api.append({
        orgId: ORG_A,
        actorId: 'user_1',
        action: 'sandbox.delete',
        resourceType: 'sandbox',
        resourceId: 'sb_test456',
      }))

      const entries = await run(api.list(ORG_A))
      expect(entries.length).toBe(1)
      expect(entries[0].metadata).toBeNull()
    })
  })

  // -- list ------------------------------------------------------------------

  describe('list', () => {
    test('returns entries newest first', async () => {
      await run(api.append({
        orgId: ORG_A,
        actorId: 'user_1',
        action: 'sandbox.create',
        resourceType: 'sandbox',
        resourceId: 'sb_1',
      }))

      await new Promise((r) => setTimeout(r, 10))

      await run(api.append({
        orgId: ORG_A,
        actorId: 'user_1',
        action: 'sandbox.delete',
        resourceType: 'sandbox',
        resourceId: 'sb_2',
      }))

      const entries = await run(api.list(ORG_A))
      expect(entries.length).toBe(2)
      expect(entries[0].action).toBe('sandbox.delete')
      expect(entries[1].action).toBe('sandbox.create')
    })

    test('filters by action', async () => {
      await run(api.append({
        orgId: ORG_A,
        actorId: 'user_1',
        action: 'sandbox.create',
        resourceType: 'sandbox',
        resourceId: 'sb_1',
      }))
      await run(api.append({
        orgId: ORG_A,
        actorId: 'user_1',
        action: 'sandbox.delete',
        resourceType: 'sandbox',
        resourceId: 'sb_2',
      }))

      const createEntries = await run(api.list(ORG_A, { action: 'sandbox.create' }))
      expect(createEntries.length).toBe(1)
      expect(createEntries[0].resourceId).toBe('sb_1')
    })

    test('respects limit', async () => {
      for (let i = 0; i < 5; i++) {
        await run(api.append({
          orgId: ORG_A,
          actorId: 'user_1',
          action: 'sandbox.create',
          resourceType: 'sandbox',
          resourceId: `sb_${i}`,
        }))
      }

      const limited = await run(api.list(ORG_A, { limit: 3 }))
      expect(limited.length).toBe(3)
    })

    test('defaults to 50 entries', async () => {
      const entries = await run(api.list(ORG_A))
      expect(entries).toEqual([])
    })

    test('entries are isolated by orgId', async () => {
      await run(api.append({
        orgId: ORG_A,
        actorId: 'user_1',
        action: 'sandbox.create',
        resourceType: 'sandbox',
        resourceId: 'sb_1',
      }))

      const entriesB = await run(api.list(ORG_B))
      expect(entriesB.length).toBe(0)
    })
  })
})
