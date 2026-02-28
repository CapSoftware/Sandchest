import { Effect } from 'effect'
import { describe, expect, test, beforeEach, afterAll } from 'bun:test'
import { generateUUIDv7 } from '@sandchest/contract'
import { createDrizzleSessionRepo, makeSessionRepoDrizzle } from './session-repo.drizzle.js'
import type { SessionRepoApi } from './session-repo.js'
import { createDatabase, type Database } from '@sandchest/db/client'
import { sql } from 'drizzle-orm'

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

describe('module exports', () => {
  test('createDrizzleSessionRepo is a function', () => {
    expect(typeof createDrizzleSessionRepo).toBe('function')
  })

  test('makeSessionRepoDrizzle is a function', () => {
    expect(typeof makeSessionRepoDrizzle).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// Integration tests — requires DATABASE_URL
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL

describe.skipIf(!DATABASE_URL)('session-repo.drizzle (integration)', () => {
  let db: Database
  let repo: SessionRepoApi

  function run<A>(effect: Effect.Effect<A, never, never>): Promise<A> {
    return Effect.runPromise(effect)
  }

  const ORG = 'org_session_drizzle_test'
  const SANDBOX_A = generateUUIDv7()
  const SANDBOX_B = generateUUIDv7()

  function makeSession(sandboxId: Uint8Array = SANDBOX_A, shell: string = '/bin/bash') {
    return {
      id: generateUUIDv7(),
      sandboxId,
      orgId: ORG,
      shell,
    }
  }

  beforeEach(async () => {
    db = createDatabase(DATABASE_URL!)
    repo = createDrizzleSessionRepo(db)
    await db.execute(sql`DELETE FROM sandbox_sessions`)
  })

  afterAll(async () => {
    // @ts-expect-error accessing pool for cleanup
    await db?._.pool?.end?.()
  })

  // -- create ---------------------------------------------------------------

  describe('create', () => {
    test('creates a session with status running', async () => {
      const params = makeSession()
      const row = await run(repo.create(params))
      expect(row.status).toBe('running')
      expect(row.shell).toBe('/bin/bash')
      expect(row.destroyedAt).toBeNull()
      expect(row.createdAt).toBeInstanceOf(Date)
      expect(row.updatedAt).toBeInstanceOf(Date)
    })

    test('stores custom shell', async () => {
      const params = makeSession(SANDBOX_A, '/bin/sh')
      const row = await run(repo.create(params))
      expect(row.shell).toBe('/bin/sh')
    })
  })

  // -- findById -------------------------------------------------------------

  describe('findById', () => {
    test('returns created session', async () => {
      const params = makeSession()
      await run(repo.create(params))
      const row = await run(repo.findById(params.id, SANDBOX_A, ORG))
      expect(row).not.toBeNull()
      expect(row!.status).toBe('running')
    })

    test('returns null for unknown id', async () => {
      const row = await run(repo.findById(generateUUIDv7(), SANDBOX_A, ORG))
      expect(row).toBeNull()
    })

    test('returns null when sandboxId does not match', async () => {
      const params = makeSession(SANDBOX_A)
      await run(repo.create(params))
      const row = await run(repo.findById(params.id, SANDBOX_B, ORG))
      expect(row).toBeNull()
    })

    test('returns null when orgId does not match', async () => {
      const params = makeSession()
      await run(repo.create(params))
      const row = await run(repo.findById(params.id, SANDBOX_A, 'org_wrong'))
      expect(row).toBeNull()
    })
  })

  // -- list -----------------------------------------------------------------

  describe('list', () => {
    test('returns empty list initially', async () => {
      const rows = await run(repo.list(SANDBOX_A, ORG))
      expect(rows).toEqual([])
    })

    test('returns sessions for the correct sandbox', async () => {
      await run(repo.create(makeSession(SANDBOX_A)))
      await run(repo.create(makeSession(SANDBOX_B)))

      const rowsA = await run(repo.list(SANDBOX_A, ORG))
      const rowsB = await run(repo.list(SANDBOX_B, ORG))
      expect(rowsA.length).toBe(1)
      expect(rowsB.length).toBe(1)
    })

    test('includes destroyed sessions', async () => {
      const params = makeSession()
      await run(repo.create(params))
      await run(repo.destroy(params.id, SANDBOX_A, ORG))

      const rows = await run(repo.list(SANDBOX_A, ORG))
      expect(rows.length).toBe(1)
      expect(rows[0].status).toBe('destroyed')
    })

    test('respects orgId scoping', async () => {
      await run(repo.create(makeSession()))
      const rows = await run(repo.list(SANDBOX_A, 'org_wrong'))
      expect(rows).toEqual([])
    })
  })

  // -- countActive ----------------------------------------------------------

  describe('countActive', () => {
    test('returns 0 initially', async () => {
      const count = await run(repo.countActive(SANDBOX_A))
      expect(count).toBe(0)
    })

    test('counts only running sessions', async () => {
      const p1 = makeSession()
      const p2 = makeSession()
      const p3 = makeSession()
      await run(repo.create(p1))
      await run(repo.create(p2))
      await run(repo.create(p3))
      await run(repo.destroy(p3.id, SANDBOX_A, ORG))

      const count = await run(repo.countActive(SANDBOX_A))
      expect(count).toBe(2)
    })

    test('scoped to sandbox', async () => {
      await run(repo.create(makeSession(SANDBOX_A)))
      await run(repo.create(makeSession(SANDBOX_B)))

      const countA = await run(repo.countActive(SANDBOX_A))
      const countB = await run(repo.countActive(SANDBOX_B))
      expect(countA).toBe(1)
      expect(countB).toBe(1)
    })
  })

  // -- destroy --------------------------------------------------------------

  describe('destroy', () => {
    test('marks session as destroyed', async () => {
      const params = makeSession()
      await run(repo.create(params))
      const destroyed = await run(repo.destroy(params.id, SANDBOX_A, ORG))
      expect(destroyed).not.toBeNull()
      expect(destroyed!.status).toBe('destroyed')
      expect(destroyed!.destroyedAt).toBeInstanceOf(Date)
    })

    test('returns null for unknown session', async () => {
      const result = await run(repo.destroy(generateUUIDv7(), SANDBOX_A, ORG))
      expect(result).toBeNull()
    })

    test('returns null when sandboxId does not match', async () => {
      const params = makeSession(SANDBOX_A)
      await run(repo.create(params))
      const result = await run(repo.destroy(params.id, SANDBOX_B, ORG))
      expect(result).toBeNull()
    })

    test('returns null when orgId does not match', async () => {
      const params = makeSession()
      await run(repo.create(params))
      const result = await run(repo.destroy(params.id, SANDBOX_A, 'org_wrong'))
      expect(result).toBeNull()
    })

    test('destroyed session decrements countActive', async () => {
      const p1 = makeSession()
      const p2 = makeSession()
      await run(repo.create(p1))
      await run(repo.create(p2))
      expect(await run(repo.countActive(SANDBOX_A))).toBe(2)

      await run(repo.destroy(p1.id, SANDBOX_A, ORG))
      expect(await run(repo.countActive(SANDBOX_A))).toBe(1)
    })

    test('destroyed session is still findable', async () => {
      const params = makeSession()
      await run(repo.create(params))
      await run(repo.destroy(params.id, SANDBOX_A, ORG))

      const row = await run(repo.findById(params.id, SANDBOX_A, ORG))
      expect(row).not.toBeNull()
      expect(row!.status).toBe('destroyed')
    })
  })

  // -- deleteByOrgId --------------------------------------------------------

  describe('deleteByOrgId', () => {
    test('hard-deletes all sessions for an org', async () => {
      await run(repo.create(makeSession()))
      await run(repo.create(makeSession()))

      const deleted = await run(repo.deleteByOrgId(ORG))
      expect(deleted).toBe(2)
    })

    test('returns 0 when org has no sessions', async () => {
      const deleted = await run(repo.deleteByOrgId(ORG))
      expect(deleted).toBe(0)
    })

    test('does not delete sessions from other orgs', async () => {
      await run(repo.create(makeSession()))
      const otherSession = { ...makeSession(), orgId: 'org_other' }
      await run(repo.create(otherSession))

      await run(repo.deleteByOrgId(ORG))

      const rows = await db.execute(sql`SELECT COUNT(*) as cnt FROM sandbox_sessions WHERE org_id = 'org_other'`)
      expect((rows[0] as { cnt: number }[])[0].cnt).toBe(1)
    })
  })
})
