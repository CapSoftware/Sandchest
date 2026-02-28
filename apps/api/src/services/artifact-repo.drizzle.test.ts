import { Effect } from 'effect'
import { describe, expect, test, beforeAll, beforeEach, afterAll } from 'bun:test'
import { generateUUIDv7, bytesToId, ARTIFACT_PREFIX } from '@sandchest/contract'
import { createDrizzleArtifactRepo, makeArtifactRepoDrizzle } from './artifact-repo.drizzle.js'
import type { ArtifactRepoApi } from './artifact-repo.js'
import { createDatabase, type Database } from '@sandchest/db/client'
import { sql } from 'drizzle-orm'

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

describe('module exports', () => {
  test('createDrizzleArtifactRepo is a function', () => {
    expect(typeof createDrizzleArtifactRepo).toBe('function')
  })

  test('makeArtifactRepoDrizzle is a function', () => {
    expect(typeof makeArtifactRepoDrizzle).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// Integration tests — requires DATABASE_URL
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL

describe.skipIf(!DATABASE_URL)('artifact-repo.drizzle (integration)', () => {
  let db: Database
  let repo: ArtifactRepoApi

  function run<A>(effect: Effect.Effect<A, never, never>): Promise<A> {
    return Effect.runPromise(effect)
  }

  const ORG = 'org_artifact_drizzle_test'
  const SANDBOX_A = generateUUIDv7()
  const SANDBOX_B = generateUUIDv7()

  function makeArtifact(sandboxId: Uint8Array = SANDBOX_A, opts: { execId?: Uint8Array; name?: string; retentionUntil?: Date } = {}) {
    return {
      id: generateUUIDv7(),
      sandboxId,
      orgId: ORG,
      execId: opts.execId,
      name: opts.name ?? 'output.txt',
      mime: 'text/plain',
      bytes: 1024,
      sha256: 'a'.repeat(64),
      ref: 'r2://bucket/path/output.txt',
      retentionUntil: opts.retentionUntil,
    }
  }

  beforeAll(() => {
    db = createDatabase(DATABASE_URL!, { connectionLimit: 2 })
    repo = createDrizzleArtifactRepo(db)
  })

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM artifacts`)
  })

  afterAll(async () => {
    // @ts-expect-error accessing pool for cleanup
    await db?._.pool?.end?.()
  })

  // -- create ---------------------------------------------------------------

  describe('create', () => {
    test('creates an artifact and returns the row', async () => {
      const params = makeArtifact()
      const row = await run(repo.create(params))
      expect(row.name).toBe('output.txt')
      expect(row.mime).toBe('text/plain')
      expect(row.bytes).toBe(1024)
      expect(row.sha256).toBe('a'.repeat(64))
      expect(row.ref).toBe('r2://bucket/path/output.txt')
      expect(row.execId).toBeNull()
      expect(row.retentionUntil).toBeNull()
      expect(row.createdAt).toBeInstanceOf(Date)
    })

    test('stores execId when provided', async () => {
      const execId = generateUUIDv7()
      const params = makeArtifact(SANDBOX_A, { execId })
      const row = await run(repo.create(params))
      expect(row.execId).toBeInstanceOf(Uint8Array)
    })

    test('stores retentionUntil when provided', async () => {
      const retentionUntil = new Date(Date.now() + 86400000)
      const params = makeArtifact(SANDBOX_A, { retentionUntil })
      const row = await run(repo.create(params))
      expect(row.retentionUntil).toBeInstanceOf(Date)
    })
  })

  // -- findById -------------------------------------------------------------

  describe('findById', () => {
    test('returns created artifact', async () => {
      const params = makeArtifact()
      await run(repo.create(params))
      const row = await run(repo.findById(params.id, SANDBOX_A, ORG))
      expect(row).not.toBeNull()
      expect(row!.name).toBe('output.txt')
    })

    test('returns null for unknown id', async () => {
      const row = await run(repo.findById(generateUUIDv7(), SANDBOX_A, ORG))
      expect(row).toBeNull()
    })

    test('returns null when sandboxId does not match', async () => {
      const params = makeArtifact(SANDBOX_A)
      await run(repo.create(params))
      const row = await run(repo.findById(params.id, SANDBOX_B, ORG))
      expect(row).toBeNull()
    })

    test('returns null when orgId does not match', async () => {
      const params = makeArtifact()
      await run(repo.create(params))
      const row = await run(repo.findById(params.id, SANDBOX_A, 'org_wrong'))
      expect(row).toBeNull()
    })
  })

  // -- count ----------------------------------------------------------------

  describe('count', () => {
    test('returns 0 initially', async () => {
      const count = await run(repo.count(SANDBOX_A, ORG))
      expect(count).toBe(0)
    })

    test('counts artifacts for the correct sandbox and org', async () => {
      await run(repo.create(makeArtifact(SANDBOX_A)))
      await run(repo.create(makeArtifact(SANDBOX_A)))
      await run(repo.create(makeArtifact(SANDBOX_B)))

      const countA = await run(repo.count(SANDBOX_A, ORG))
      const countB = await run(repo.count(SANDBOX_B, ORG))
      expect(countA).toBe(2)
      expect(countB).toBe(1)
    })
  })

  // -- list -----------------------------------------------------------------

  describe('list', () => {
    test('returns empty list initially', async () => {
      const result = await run(repo.list(SANDBOX_A, ORG, {}))
      expect(result.rows).toEqual([])
      expect(result.nextCursor).toBeNull()
    })

    test('returns artifacts for the correct sandbox', async () => {
      await run(repo.create(makeArtifact(SANDBOX_A)))
      await run(repo.create(makeArtifact(SANDBOX_B)))

      const result = await run(repo.list(SANDBOX_A, ORG, {}))
      expect(result.rows.length).toBe(1)
    })

    test('cursor pagination', async () => {
      for (let i = 0; i < 5; i++) {
        await run(repo.create(makeArtifact(SANDBOX_A, { name: `file-${i}.txt` })))
      }

      const page1 = await run(repo.list(SANDBOX_A, ORG, { limit: 2 }))
      expect(page1.rows.length).toBe(2)
      expect(page1.nextCursor).not.toBeNull()

      const page2 = await run(repo.list(SANDBOX_A, ORG, { limit: 2, cursor: page1.nextCursor! }))
      expect(page2.rows.length).toBe(2)

      const page3 = await run(repo.list(SANDBOX_A, ORG, { limit: 2, cursor: page2.nextCursor! }))
      expect(page3.rows.length).toBe(1)
      expect(page3.nextCursor).toBeNull()

      const allIds = [...page1.rows, ...page2.rows, ...page3.rows].map((r) =>
        bytesToId(ARTIFACT_PREFIX, r.id),
      )
      expect(new Set(allIds).size).toBe(5)
    })

    test('respects orgId scoping', async () => {
      await run(repo.create(makeArtifact()))
      const result = await run(repo.list(SANDBOX_A, 'org_wrong', {}))
      expect(result.rows).toEqual([])
    })
  })

  // -- findExpiredRetention -------------------------------------------------

  describe('findExpiredRetention', () => {
    test('returns artifacts past retention date', async () => {
      const past = new Date(Date.now() - 86400000)
      const future = new Date(Date.now() + 86400000)
      await run(repo.create(makeArtifact(SANDBOX_A, { retentionUntil: past })))
      await run(repo.create(makeArtifact(SANDBOX_A, { retentionUntil: future })))
      await run(repo.create(makeArtifact(SANDBOX_A)))

      const expired = await run(repo.findExpiredRetention(new Date()))
      expect(expired.length).toBe(1)
    })
  })

  // -- deleteByIds ----------------------------------------------------------

  describe('deleteByIds', () => {
    test('deletes specified artifacts', async () => {
      const p1 = makeArtifact()
      const p2 = makeArtifact()
      await run(repo.create(p1))
      await run(repo.create(p2))

      const deleted = await run(repo.deleteByIds([p1.id]))
      expect(deleted).toBe(1)

      const remaining = await run(repo.count(SANDBOX_A, ORG))
      expect(remaining).toBe(1)
    })

    test('returns 0 for empty array', async () => {
      const deleted = await run(repo.deleteByIds([]))
      expect(deleted).toBe(0)
    })
  })

  // -- findByOrgId ----------------------------------------------------------

  describe('findByOrgId', () => {
    test('returns all artifacts for an org', async () => {
      await run(repo.create(makeArtifact(SANDBOX_A)))
      await run(repo.create(makeArtifact(SANDBOX_B)))

      const rows = await run(repo.findByOrgId(ORG))
      expect(rows.length).toBe(2)
    })

    test('returns empty for unknown org', async () => {
      await run(repo.create(makeArtifact()))
      const rows = await run(repo.findByOrgId('org_unknown'))
      expect(rows).toEqual([])
    })
  })

  // -- deleteByOrgId --------------------------------------------------------

  describe('deleteByOrgId', () => {
    test('hard-deletes all artifacts for an org', async () => {
      await run(repo.create(makeArtifact()))
      await run(repo.create(makeArtifact()))

      const deleted = await run(repo.deleteByOrgId(ORG))
      expect(deleted).toBe(2)
    })

    test('returns 0 when org has no artifacts', async () => {
      const deleted = await run(repo.deleteByOrgId(ORG))
      expect(deleted).toBe(0)
    })

    test('does not delete artifacts from other orgs', async () => {
      await run(repo.create(makeArtifact()))
      const otherArtifact = { ...makeArtifact(), orgId: 'org_other' }
      await run(repo.create(otherArtifact))

      await run(repo.deleteByOrgId(ORG))

      const rows = await db.execute(sql`SELECT COUNT(*) as cnt FROM artifacts WHERE org_id = 'org_other'`)
      expect((rows[0] as { cnt: number }[])[0].cnt).toBe(1)
    })
  })
})
