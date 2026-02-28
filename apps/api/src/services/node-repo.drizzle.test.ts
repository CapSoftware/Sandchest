import { Effect } from 'effect'
import { describe, expect, test, beforeEach, afterAll } from 'bun:test'
import { generateUUIDv7 } from '@sandchest/contract'
import { createDrizzleNodeRepo, makeNodeRepoDrizzle } from './node-repo.drizzle.js'
import type { NodeRepoApi } from './node-repo.js'
import { createDatabase, type Database } from '@sandchest/db/client'
import { sql } from 'drizzle-orm'

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

describe('module exports', () => {
  test('createDrizzleNodeRepo is a function', () => {
    expect(typeof createDrizzleNodeRepo).toBe('function')
  })

  test('makeNodeRepoDrizzle is a function', () => {
    expect(typeof makeNodeRepoDrizzle).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// Integration tests — requires DATABASE_URL
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL

describe.skipIf(!DATABASE_URL)('node-repo.drizzle (integration)', () => {
  let db: Database
  let repo: NodeRepoApi

  function run<A>(effect: Effect.Effect<A, never, never>): Promise<A> {
    return Effect.runPromise(effect)
  }

  function makeNode(opts: { name?: string; hostname?: string; status?: 'online' | 'offline' | 'draining' | 'disabled' } = {}) {
    return {
      id: generateUUIDv7(),
      name: opts.name ?? 'node-1',
      hostname: opts.hostname ?? 'node-1.example.com',
      slotsTotal: 4,
      status: opts.status ?? ('online' as const),
      version: '0.1.0' as string | null,
      firecrackerVersion: '1.6.0' as string | null,
    }
  }

  beforeEach(async () => {
    db = createDatabase(DATABASE_URL!)
    repo = createDrizzleNodeRepo(db)
    await db.execute(sql`DELETE FROM nodes`)
  })

  afterAll(async () => {
    // @ts-expect-error accessing pool for cleanup
    await db?._.pool?.end?.()
  })

  // -- create ---------------------------------------------------------------

  describe('create', () => {
    test('creates a node', async () => {
      const params = makeNode()
      await run(repo.create(params))
      const row = await run(repo.findById(params.id))
      expect(row).not.toBeNull()
      expect(row!.name).toBe('node-1')
      expect(row!.hostname).toBe('node-1.example.com')
      expect(row!.slotsTotal).toBe(4)
      expect(row!.status).toBe('online')
      expect(row!.version).toBe('0.1.0')
      expect(row!.firecrackerVersion).toBe('1.6.0')
      expect(row!.createdAt).toBeInstanceOf(Date)
      expect(row!.updatedAt).toBeInstanceOf(Date)
    })

    test('stores null version fields', async () => {
      const params = { ...makeNode(), version: null, firecrackerVersion: null }
      await run(repo.create(params))
      const row = await run(repo.findById(params.id))
      expect(row!.version).toBeNull()
      expect(row!.firecrackerVersion).toBeNull()
    })
  })

  // -- findById -------------------------------------------------------------

  describe('findById', () => {
    test('returns null for unknown id', async () => {
      const row = await run(repo.findById(generateUUIDv7()))
      expect(row).toBeNull()
    })
  })

  // -- list -----------------------------------------------------------------

  describe('list', () => {
    test('returns empty list initially', async () => {
      const rows = await run(repo.list())
      expect(rows).toEqual([])
    })

    test('returns all nodes', async () => {
      await run(repo.create(makeNode({ name: 'node-a' })))
      await run(repo.create(makeNode({ name: 'node-b' })))

      const rows = await run(repo.list())
      expect(rows.length).toBe(2)
    })
  })

  // -- update ---------------------------------------------------------------

  describe('update', () => {
    test('updates status', async () => {
      const params = makeNode()
      await run(repo.create(params))
      await run(repo.update(params.id, { status: 'draining' }))

      const row = await run(repo.findById(params.id))
      expect(row!.status).toBe('draining')
    })

    test('updates slotsTotal', async () => {
      const params = makeNode()
      await run(repo.create(params))
      await run(repo.update(params.id, { slotsTotal: 8 }))

      const row = await run(repo.findById(params.id))
      expect(row!.slotsTotal).toBe(8)
    })

    test('updates version fields', async () => {
      const params = makeNode()
      await run(repo.create(params))
      await run(repo.update(params.id, { version: '0.2.0', firecrackerVersion: '1.7.0' }))

      const row = await run(repo.findById(params.id))
      expect(row!.version).toBe('0.2.0')
      expect(row!.firecrackerVersion).toBe('1.7.0')
    })

    test('preserves unchanged fields', async () => {
      const params = makeNode()
      await run(repo.create(params))
      await run(repo.update(params.id, { status: 'draining' }))

      const row = await run(repo.findById(params.id))
      expect(row!.name).toBe('node-1')
      expect(row!.hostname).toBe('node-1.example.com')
      expect(row!.slotsTotal).toBe(4)
      expect(row!.version).toBe('0.1.0')
    })

    test('updates updatedAt timestamp', async () => {
      const params = makeNode()
      await run(repo.create(params))
      const before = await run(repo.findById(params.id))

      // Small delay to ensure timestamp difference
      await new Promise((r) => setTimeout(r, 10))
      await run(repo.update(params.id, { status: 'offline' }))
      const after = await run(repo.findById(params.id))

      expect(after!.updatedAt.getTime()).toBeGreaterThanOrEqual(before!.updatedAt.getTime())
    })
  })

  // -- remove ---------------------------------------------------------------

  describe('remove', () => {
    test('deletes a node', async () => {
      const params = makeNode()
      await run(repo.create(params))
      await run(repo.remove(params.id))

      const row = await run(repo.findById(params.id))
      expect(row).toBeNull()
    })

    test('no-ops for unknown id', async () => {
      // Should not throw
      await run(repo.remove(generateUUIDv7()))
    })
  })

  // -- countActiveSandboxes -------------------------------------------------

  describe('countActiveSandboxes', () => {
    test('returns 0 when no running sandboxes', async () => {
      const params = makeNode()
      await run(repo.create(params))
      const count = await run(repo.countActiveSandboxes(params.id))
      expect(count).toBe(0)
    })
  })
})
