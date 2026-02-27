import { Effect } from 'effect'
import { describe, expect, test, beforeEach, afterAll } from 'bun:test'
import { generateUUIDv7, bytesToId, SANDBOX_PREFIX } from '@sandchest/contract'
import { createDrizzleSandboxRepo, makeSandboxRepoDrizzle } from './sandbox-repo.drizzle.js'
import type { SandboxRepoApi } from './sandbox-repo.js'
import { createDatabase, type Database } from '@sandchest/db/client'
import { sql } from 'drizzle-orm'
import { seed } from '@sandchest/db/seed'

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

describe('module exports', () => {
  test('createDrizzleSandboxRepo is a function', () => {
    expect(typeof createDrizzleSandboxRepo).toBe('function')
  })

  test('makeSandboxRepoDrizzle is a function', () => {
    expect(typeof makeSandboxRepoDrizzle).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// Integration tests — requires DATABASE_URL
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL

describe.skipIf(!DATABASE_URL)('sandbox-repo.drizzle (integration)', () => {
  let db: Database
  let repo: SandboxRepoApi

  function run<A>(effect: Effect.Effect<A, never, never>): Promise<A> {
    return Effect.runPromise(effect)
  }

  const ORG_A = 'org_alpha'
  const ORG_B = 'org_beta'

  function makeSandbox(orgId: string = ORG_A) {
    const id = generateUUIDv7()
    return {
      id,
      orgId,
      imageId: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0]),
      profileId: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
      profileName: 'small' as const,
      env: null,
      ttlSeconds: 3600,
      imageRef: 'sandchest://ubuntu-22.04/base',
    }
  }

  beforeEach(async () => {
    db = createDatabase(DATABASE_URL!)
    repo = createDrizzleSandboxRepo(db)
    // Seed reference data (idempotent)
    await seed(db)
    // Truncate sandboxes between tests
    await db.execute(sql`DELETE FROM sandboxes`)
  })

  afterAll(async () => {
    // @ts-expect-error accessing pool for cleanup
    await db?._.pool?.end?.()
  })

  // -- resolveImage -----------------------------------------------------------

  describe('resolveImage', () => {
    test('resolves ubuntu-22.04', async () => {
      const result = await run(repo.resolveImage('ubuntu-22.04'))
      expect(result).not.toBeNull()
      expect(result!.ref).toBe('sandchest://ubuntu-22.04/base')
      expect(result!.id).toBeInstanceOf(Uint8Array)
    })

    test('resolves ubuntu-22.04/base', async () => {
      const result = await run(repo.resolveImage('ubuntu-22.04/base'))
      expect(result).not.toBeNull()
      expect(result!.ref).toBe('sandchest://ubuntu-22.04/base')
    })

    test('returns null for unknown image', async () => {
      const result = await run(repo.resolveImage('debian-12'))
      expect(result).toBeNull()
    })
  })

  // -- resolveProfile ---------------------------------------------------------

  describe('resolveProfile', () => {
    test('resolves small', async () => {
      const result = await run(repo.resolveProfile('small'))
      expect(result).not.toBeNull()
      expect(result!.id).toBeInstanceOf(Uint8Array)
    })

    test('resolves medium', async () => {
      const result = await run(repo.resolveProfile('medium'))
      expect(result).not.toBeNull()
    })

    test('resolves large', async () => {
      const result = await run(repo.resolveProfile('large'))
      expect(result).not.toBeNull()
    })

    test('each profile has a unique id', async () => {
      const small = await run(repo.resolveProfile('small'))
      const medium = await run(repo.resolveProfile('medium'))
      const large = await run(repo.resolveProfile('large'))
      const ids = [small!.id, medium!.id, large!.id].map((id) => Array.from(id).join(','))
      expect(new Set(ids).size).toBe(3)
    })
  })

  // -- create -----------------------------------------------------------------

  describe('create', () => {
    test('creates a sandbox with status queued', async () => {
      const params = makeSandbox()
      const row = await run(repo.create(params))
      expect(row.status).toBe('queued')
      expect(row.orgId).toBe(ORG_A)
      expect(row.profileName).toBe('small')
      expect(row.forkedFrom).toBeNull()
      expect(row.forkCount).toBe(0)
      expect(row.failureReason).toBeNull()
      expect(row.startedAt).toBeNull()
      expect(row.endedAt).toBeNull()
      expect(row.createdAt).toBeInstanceOf(Date)
      expect(row.updatedAt).toBeInstanceOf(Date)
    })

    test('stores env when provided', async () => {
      const params = { ...makeSandbox(), env: { NODE_ENV: 'test' } }
      const row = await run(repo.create(params))
      expect(row.env).toEqual({ NODE_ENV: 'test' })
    })

    test('stores null env', async () => {
      const params = makeSandbox()
      const row = await run(repo.create(params))
      expect(row.env).toBeNull()
    })
  })

  // -- findById ---------------------------------------------------------------

  describe('findById', () => {
    test('returns created sandbox', async () => {
      const params = makeSandbox()
      await run(repo.create(params))
      const row = await run(repo.findById(params.id, ORG_A))
      expect(row).not.toBeNull()
      expect(row!.orgId).toBe(ORG_A)
    })

    test('returns null for unknown id', async () => {
      const row = await run(repo.findById(generateUUIDv7(), ORG_A))
      expect(row).toBeNull()
    })

    test('returns null when orgId does not match', async () => {
      const params = makeSandbox(ORG_A)
      await run(repo.create(params))
      const row = await run(repo.findById(params.id, ORG_B))
      expect(row).toBeNull()
    })
  })

  // -- list -------------------------------------------------------------------

  describe('list', () => {
    test('returns empty list initially', async () => {
      const result = await run(repo.list(ORG_A, {}))
      expect(result.rows).toEqual([])
      expect(result.nextCursor).toBeNull()
    })

    test('returns sandboxes for the correct org', async () => {
      await run(repo.create(makeSandbox(ORG_A)))
      await run(repo.create(makeSandbox(ORG_B)))

      const resultA = await run(repo.list(ORG_A, {}))
      const resultB = await run(repo.list(ORG_B, {}))
      expect(resultA.rows.length).toBe(1)
      expect(resultB.rows.length).toBe(1)
      expect(resultA.rows[0].orgId).toBe(ORG_A)
      expect(resultB.rows[0].orgId).toBe(ORG_B)
    })

    test('excludes deleted sandboxes', async () => {
      const params = makeSandbox()
      await run(repo.create(params))
      await run(repo.softDelete(params.id, ORG_A))

      const result = await run(repo.list(ORG_A, {}))
      expect(result.rows).toEqual([])
    })

    test('filters by status', async () => {
      const p1 = makeSandbox()
      const p2 = makeSandbox()
      await run(repo.create(p1))
      await run(repo.create(p2))
      await run(repo.updateStatus(p1.id, ORG_A, 'running'))

      const running = await run(repo.list(ORG_A, { status: 'running' }))
      const queued = await run(repo.list(ORG_A, { status: 'queued' }))
      expect(running.rows.length).toBe(1)
      expect(queued.rows.length).toBe(1)
    })

    test('respects limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await run(repo.create(makeSandbox()))
      }

      const result = await run(repo.list(ORG_A, { limit: 3 }))
      expect(result.rows.length).toBe(3)
      expect(result.nextCursor).not.toBeNull()
    })

    test('cursor pagination walks through all results', async () => {
      for (let i = 0; i < 5; i++) {
        await run(repo.create(makeSandbox()))
      }

      const page1 = await run(repo.list(ORG_A, { limit: 2 }))
      expect(page1.rows.length).toBe(2)
      expect(page1.nextCursor).not.toBeNull()

      const page2 = await run(repo.list(ORG_A, { limit: 2, cursor: page1.nextCursor! }))
      expect(page2.rows.length).toBe(2)
      expect(page2.nextCursor).not.toBeNull()

      const page3 = await run(repo.list(ORG_A, { limit: 2, cursor: page2.nextCursor! }))
      expect(page3.rows.length).toBe(1)
      expect(page3.nextCursor).toBeNull()

      // Verify no duplicates
      const allIds = [...page1.rows, ...page2.rows, ...page3.rows].map((r) =>
        bytesToId(SANDBOX_PREFIX, r.id),
      )
      expect(new Set(allIds).size).toBe(5)
    })

    test('limit capped at 200', async () => {
      const result = await run(repo.list(ORG_A, { limit: 999 }))
      expect(result.rows).toEqual([])
    })
  })

  // -- updateStatus -----------------------------------------------------------

  describe('updateStatus', () => {
    test('updates status field', async () => {
      const params = makeSandbox()
      await run(repo.create(params))
      const updated = await run(repo.updateStatus(params.id, ORG_A, 'running'))
      expect(updated).not.toBeNull()
      expect(updated!.status).toBe('running')
    })

    test('returns null for unknown sandbox', async () => {
      const result = await run(repo.updateStatus(generateUUIDv7(), ORG_A, 'running'))
      expect(result).toBeNull()
    })

    test('returns null when orgId does not match', async () => {
      const params = makeSandbox(ORG_A)
      await run(repo.create(params))
      const result = await run(repo.updateStatus(params.id, ORG_B, 'running'))
      expect(result).toBeNull()
    })

    test('applies extra.endedAt', async () => {
      const params = makeSandbox()
      await run(repo.create(params))
      const endedAt = new Date()
      const updated = await run(repo.updateStatus(params.id, ORG_A, 'stopped', { endedAt }))
      expect(updated!.endedAt).toBeInstanceOf(Date)
    })

    test('applies extra.failureReason', async () => {
      const params = makeSandbox()
      await run(repo.create(params))
      const updated = await run(
        repo.updateStatus(params.id, ORG_A, 'failed', { failureReason: 'provision_failed' }),
      )
      expect(updated!.failureReason).toBe('provision_failed')
    })

    test('persists updated status on subsequent findById', async () => {
      const params = makeSandbox()
      await run(repo.create(params))
      await run(repo.updateStatus(params.id, ORG_A, 'running'))
      const row = await run(repo.findById(params.id, ORG_A))
      expect(row!.status).toBe('running')
    })
  })

  // -- softDelete -------------------------------------------------------------

  describe('softDelete', () => {
    test('sets status to deleted', async () => {
      const params = makeSandbox()
      await run(repo.create(params))
      const deleted = await run(repo.softDelete(params.id, ORG_A))
      expect(deleted).not.toBeNull()
      expect(deleted!.status).toBe('deleted')
    })

    test('sets endedAt when not already set', async () => {
      const params = makeSandbox()
      await run(repo.create(params))
      const deleted = await run(repo.softDelete(params.id, ORG_A))
      expect(deleted!.endedAt).toBeInstanceOf(Date)
    })

    test('returns null for unknown sandbox', async () => {
      const result = await run(repo.softDelete(generateUUIDv7(), ORG_A))
      expect(result).toBeNull()
    })

    test('returns null when orgId does not match', async () => {
      const params = makeSandbox(ORG_A)
      await run(repo.create(params))
      const result = await run(repo.softDelete(params.id, ORG_B))
      expect(result).toBeNull()
    })

    test('sandbox is still findable after soft-delete', async () => {
      const params = makeSandbox()
      await run(repo.create(params))
      await run(repo.softDelete(params.id, ORG_A))
      const row = await run(repo.findById(params.id, ORG_A))
      expect(row).not.toBeNull()
      expect(row!.status).toBe('deleted')
    })
  })

  // -- createFork -------------------------------------------------------------

  describe('createFork', () => {
    test('creates a fork with correct parent reference', async () => {
      const parent = makeSandbox()
      await run(repo.create(parent))
      await run(repo.assignNode(parent.id, ORG_A, generateUUIDv7()))

      const forkId = generateUUIDv7()
      const parentRunning = (await run(repo.findById(parent.id, ORG_A)))!
      const fork = await run(
        repo.createFork({
          id: forkId,
          orgId: ORG_A,
          source: parentRunning,
          env: { TEST: 'value' },
          ttlSeconds: 1800,
        }),
      )

      expect(fork.status).toBe('running')
      expect(fork.forkDepth).toBe(1)
      expect(fork.forkCount).toBe(0)
      expect(fork.env).toEqual({ TEST: 'value' })
      expect(fork.imageRef).toBe(parentRunning.imageRef)
      expect(fork.profileName).toBe(parentRunning.profileName)
      expect(fork.startedAt).toBeInstanceOf(Date)
    })

    test('fork depth increments from parent', async () => {
      const p1 = makeSandbox()
      await run(repo.create(p1))
      await run(repo.assignNode(p1.id, ORG_A, generateUUIDv7()))
      const p1Row = (await run(repo.findById(p1.id, ORG_A)))!

      const f1Id = generateUUIDv7()
      const f1 = await run(
        repo.createFork({ id: f1Id, orgId: ORG_A, source: p1Row, env: null, ttlSeconds: 3600 }),
      )
      expect(f1.forkDepth).toBe(1)

      const f2Id = generateUUIDv7()
      const f2 = await run(
        repo.createFork({ id: f2Id, orgId: ORG_A, source: f1, env: null, ttlSeconds: 3600 }),
      )
      expect(f2.forkDepth).toBe(2)
    })
  })

  // -- incrementForkCount -----------------------------------------------------

  describe('incrementForkCount', () => {
    test('increments fork count by 1', async () => {
      const params = makeSandbox()
      await run(repo.create(params))
      const updated = await run(repo.incrementForkCount(params.id, ORG_A))
      expect(updated).not.toBeNull()
      expect(updated!.forkCount).toBe(1)
    })

    test('increments multiple times', async () => {
      const params = makeSandbox()
      await run(repo.create(params))
      await run(repo.incrementForkCount(params.id, ORG_A))
      const updated = await run(repo.incrementForkCount(params.id, ORG_A))
      expect(updated!.forkCount).toBe(2)
    })

    test('returns null for unknown sandbox', async () => {
      const result = await run(repo.incrementForkCount(generateUUIDv7(), ORG_A))
      expect(result).toBeNull()
    })

    test('returns null when orgId does not match', async () => {
      const params = makeSandbox(ORG_A)
      await run(repo.create(params))
      const result = await run(repo.incrementForkCount(params.id, ORG_B))
      expect(result).toBeNull()
    })
  })

  // -- getForkTree ------------------------------------------------------------

  describe('getForkTree', () => {
    test('returns single node for sandbox with no forks', async () => {
      const params = makeSandbox()
      await run(repo.create(params))
      const tree = await run(repo.getForkTree(params.id, ORG_A))
      expect(tree.length).toBe(1)
    })

    test('returns parent and children in tree', async () => {
      const parent = makeSandbox()
      await run(repo.create(parent))
      await run(repo.assignNode(parent.id, ORG_A, generateUUIDv7()))
      const parentRow = (await run(repo.findById(parent.id, ORG_A)))!

      const f1Id = generateUUIDv7()
      await run(
        repo.createFork({ id: f1Id, orgId: ORG_A, source: parentRow, env: null, ttlSeconds: 3600 }),
      )

      const f2Id = generateUUIDv7()
      await run(
        repo.createFork({ id: f2Id, orgId: ORG_A, source: parentRow, env: null, ttlSeconds: 3600 }),
      )

      const tree = await run(repo.getForkTree(parent.id, ORG_A))
      expect(tree.length).toBe(3)
    })

    test('traverses up to root from child', async () => {
      const parent = makeSandbox()
      await run(repo.create(parent))
      await run(repo.assignNode(parent.id, ORG_A, generateUUIDv7()))
      const parentRow = (await run(repo.findById(parent.id, ORG_A)))!

      const childId = generateUUIDv7()
      await run(
        repo.createFork({
          id: childId,
          orgId: ORG_A,
          source: parentRow,
          env: null,
          ttlSeconds: 3600,
        }),
      )

      const tree = await run(repo.getForkTree(childId, ORG_A))
      expect(tree.length).toBe(2)
      const ids = tree.map((r) => bytesToId(SANDBOX_PREFIX, r.id))
      expect(ids).toContain(bytesToId(SANDBOX_PREFIX, parent.id))
      expect(ids).toContain(bytesToId(SANDBOX_PREFIX, childId))
    })

    test('returns empty array for unknown sandbox', async () => {
      const tree = await run(repo.getForkTree(generateUUIDv7(), ORG_A))
      expect(tree).toEqual([])
    })

    test('returns empty array when orgId does not match', async () => {
      const params = makeSandbox(ORG_A)
      await run(repo.create(params))
      const tree = await run(repo.getForkTree(params.id, ORG_B))
      expect(tree).toEqual([])
    })
  })

  // -- replayPublic -----------------------------------------------------------

  describe('replayPublic', () => {
    test('new sandboxes have replayPublic=false by default', async () => {
      const params = makeSandbox()
      const row = await run(repo.create(params))
      expect(row.replayPublic).toBe(false)
    })

    test('setReplayPublic toggles visibility', async () => {
      const params = makeSandbox()
      await run(repo.create(params))

      const updated = await run(repo.setReplayPublic(params.id, ORG_A, true))
      expect(updated).not.toBeNull()
      expect(updated!.replayPublic).toBe(true)

      const reverted = await run(repo.setReplayPublic(params.id, ORG_A, false))
      expect(reverted).not.toBeNull()
      expect(reverted!.replayPublic).toBe(false)
    })

    test('setReplayPublic returns null for wrong org', async () => {
      const params = makeSandbox(ORG_A)
      await run(repo.create(params))
      const result = await run(repo.setReplayPublic(params.id, ORG_B, true))
      expect(result).toBeNull()
    })

    test('setReplayPublic returns null for unknown sandbox', async () => {
      const result = await run(repo.setReplayPublic(generateUUIDv7(), ORG_A, true))
      expect(result).toBeNull()
    })
  })

  // -- findByIdPublic ---------------------------------------------------------

  describe('findByIdPublic', () => {
    test('returns null for private sandboxes', async () => {
      const params = makeSandbox()
      await run(repo.create(params))
      const result = await run(repo.findByIdPublic(params.id))
      expect(result).toBeNull()
    })

    test('returns row for public sandboxes', async () => {
      const params = makeSandbox()
      await run(repo.create(params))
      await run(repo.setReplayPublic(params.id, ORG_A, true))
      const result = await run(repo.findByIdPublic(params.id))
      expect(result).not.toBeNull()
      expect(result!.replayPublic).toBe(true)
    })

    test('returns null after setting back to private', async () => {
      const params = makeSandbox()
      await run(repo.create(params))
      await run(repo.setReplayPublic(params.id, ORG_A, true))
      await run(repo.setReplayPublic(params.id, ORG_A, false))
      const result = await run(repo.findByIdPublic(params.id))
      expect(result).toBeNull()
    })

    test('returns null for unknown id', async () => {
      const result = await run(repo.findByIdPublic(generateUUIDv7()))
      expect(result).toBeNull()
    })
  })

  // -- touchLastActivity ------------------------------------------------------

  describe('touchLastActivity', () => {
    test('updates lastActivityAt on a running sandbox', async () => {
      const params = makeSandbox()
      await run(repo.create(params))
      await run(repo.assignNode(params.id, ORG_A, generateUUIDv7()))

      await run(repo.touchLastActivity(params.id, ORG_A))

      const after = await run(repo.findById(params.id, ORG_A))
      expect(after!.lastActivityAt).toBeInstanceOf(Date)
    })

    test('does not update non-running sandboxes', async () => {
      const params = makeSandbox()
      await run(repo.create(params))
      // status is 'queued'

      await run(repo.touchLastActivity(params.id, ORG_A))

      const row = await run(repo.findById(params.id, ORG_A))
      expect(row!.lastActivityAt).toBeNull()
    })

    test('does not update when orgId does not match', async () => {
      const params = makeSandbox(ORG_A)
      await run(repo.create(params))
      await run(repo.assignNode(params.id, ORG_A, generateUUIDv7()))

      await run(repo.touchLastActivity(params.id, ORG_B))

      const row = await run(repo.findById(params.id, ORG_A))
      // lastActivityAt was set by assignNode, so check it didn't change from ORG_B touch
      const before = row!.lastActivityAt
      await run(repo.touchLastActivity(params.id, ORG_B))
      const after = await run(repo.findById(params.id, ORG_A))
      expect(after!.lastActivityAt!.getTime()).toBe(before!.getTime())
    })

    test('does nothing for unknown sandbox', async () => {
      // Should not throw
      await run(repo.touchLastActivity(generateUUIDv7(), ORG_A))
    })
  })

  // -- countActive ------------------------------------------------------------

  describe('countActive', () => {
    test('counts queued, provisioning, and running sandboxes', async () => {
      const p1 = makeSandbox()
      const p2 = makeSandbox()
      const p3 = makeSandbox()
      await run(repo.create(p1))
      await run(repo.create(p2))
      await run(repo.create(p3))
      await run(repo.updateStatus(p2.id, ORG_A, 'running'))
      await run(repo.updateStatus(p3.id, ORG_A, 'stopped'))

      const count = await run(repo.countActive(ORG_A))
      // p1 = queued, p2 = running, p3 = stopped
      expect(count).toBe(2)
    })

    test('does not count other org sandboxes', async () => {
      await run(repo.create(makeSandbox(ORG_A)))
      await run(repo.create(makeSandbox(ORG_B)))

      const countA = await run(repo.countActive(ORG_A))
      const countB = await run(repo.countActive(ORG_B))
      expect(countA).toBe(1)
      expect(countB).toBe(1)
    })
  })

  // -- deleteByOrgId ----------------------------------------------------------

  describe('deleteByOrgId', () => {
    test('hard-deletes all sandboxes for an org', async () => {
      await run(repo.create(makeSandbox(ORG_A)))
      await run(repo.create(makeSandbox(ORG_A)))
      await run(repo.create(makeSandbox(ORG_B)))

      const deleted = await run(repo.deleteByOrgId(ORG_A))
      expect(deleted).toBe(2)

      const remaining = await run(repo.list(ORG_B, {}))
      expect(remaining.rows.length).toBe(1)
    })

    test('returns 0 when org has no sandboxes', async () => {
      const deleted = await run(repo.deleteByOrgId(ORG_A))
      expect(deleted).toBe(0)
    })
  })

  // -- assignNode -------------------------------------------------------------

  describe('assignNode', () => {
    test('assigns node and sets running status', async () => {
      const params = makeSandbox()
      await run(repo.create(params))
      const nodeId = generateUUIDv7()
      const updated = await run(repo.assignNode(params.id, ORG_A, nodeId))
      expect(updated).not.toBeNull()
      expect(updated!.status).toBe('running')
      expect(updated!.startedAt).toBeInstanceOf(Date)
      expect(updated!.lastActivityAt).toBeInstanceOf(Date)
    })

    test('returns null for unknown sandbox', async () => {
      const result = await run(repo.assignNode(generateUUIDv7(), ORG_A, generateUUIDv7()))
      expect(result).toBeNull()
    })

    test('returns null when orgId does not match', async () => {
      const params = makeSandbox(ORG_A)
      await run(repo.create(params))
      const result = await run(repo.assignNode(params.id, ORG_B, generateUUIDv7()))
      expect(result).toBeNull()
    })
  })

  // -- setReplayExpiresAt -----------------------------------------------------

  describe('setReplayExpiresAt', () => {
    test('sets replay expiry date', async () => {
      const params = makeSandbox()
      await run(repo.create(params))
      const expiresAt = new Date('2025-06-01T00:00:00Z')
      await run(repo.setReplayExpiresAt(params.id, expiresAt))
      const row = await run(repo.findById(params.id, ORG_A))
      expect(row!.replayExpiresAt).toBeInstanceOf(Date)
    })
  })
})
