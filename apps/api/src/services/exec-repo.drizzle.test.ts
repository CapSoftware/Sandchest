import { Effect } from 'effect'
import { describe, expect, test, beforeEach, afterAll } from 'bun:test'
import { generateUUIDv7, bytesToId, EXEC_PREFIX } from '@sandchest/contract'
import { createDrizzleExecRepo, makeExecRepoDrizzle } from './exec-repo.drizzle.js'
import type { ExecRepoApi } from './exec-repo.js'
import { createDatabase, type Database } from '@sandchest/db/client'
import { sql } from 'drizzle-orm'

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

describe('module exports', () => {
  test('createDrizzleExecRepo is a function', () => {
    expect(typeof createDrizzleExecRepo).toBe('function')
  })

  test('makeExecRepoDrizzle is a function', () => {
    expect(typeof makeExecRepoDrizzle).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// Integration tests — requires DATABASE_URL
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL

describe.skipIf(!DATABASE_URL)('exec-repo.drizzle (integration)', () => {
  let db: Database
  let repo: ExecRepoApi

  function run<A>(effect: Effect.Effect<A, never, never>): Promise<A> {
    return Effect.runPromise(effect)
  }

  const ORG = 'org_exec_drizzle_test'
  const SANDBOX_A = generateUUIDv7()
  const SANDBOX_B = generateUUIDv7()

  function makeExec(
    sandboxId: Uint8Array = SANDBOX_A,
    opts: { sessionId?: Uint8Array; cmd?: string; cmdFormat?: 'array' | 'shell' } = {},
  ) {
    return {
      id: generateUUIDv7(),
      sandboxId,
      orgId: ORG,
      sessionId: opts.sessionId,
      seq: 0,
      cmd: opts.cmd ?? '["echo","hello"]',
      cmdFormat: opts.cmdFormat ?? ('array' as const),
    }
  }

  beforeEach(async () => {
    db = createDatabase(DATABASE_URL!)
    repo = createDrizzleExecRepo(db)
    await db.execute(sql`DELETE FROM execs`)
  })

  afterAll(async () => {
    // @ts-expect-error accessing pool for cleanup
    await db?._.pool?.end?.()
  })

  // -- create ---------------------------------------------------------------

  describe('create', () => {
    test('creates an exec with status queued', async () => {
      const params = { ...makeExec(), seq: 1 }
      const row = await run(repo.create(params))
      expect(row.status).toBe('queued')
      expect(row.exitCode).toBeNull()
      expect(row.cpuMs).toBeNull()
      expect(row.peakMemoryBytes).toBeNull()
      expect(row.durationMs).toBeNull()
      expect(row.logRef).toBeNull()
      expect(row.startedAt).toBeNull()
      expect(row.endedAt).toBeNull()
      expect(row.createdAt).toBeInstanceOf(Date)
      expect(row.updatedAt).toBeInstanceOf(Date)
    })

    test('stores cmd and cmdFormat', async () => {
      const params = { ...makeExec(), seq: 1, cmd: 'ls -la', cmdFormat: 'shell' as const }
      const row = await run(repo.create(params))
      expect(row.cmd).toBe('ls -la')
      expect(row.cmdFormat).toBe('shell')
    })

    test('stores optional env and cwd', async () => {
      const params = {
        ...makeExec(),
        seq: 1,
        cwd: '/work',
        env: { PATH: '/usr/bin' },
      }
      const row = await run(repo.create(params))
      expect(row.cwd).toBe('/work')
      expect(row.env).toEqual({ PATH: '/usr/bin' })
    })

    test('defaults cwd and env to null', async () => {
      const params = { ...makeExec(), seq: 1 }
      const row = await run(repo.create(params))
      expect(row.cwd).toBeNull()
      expect(row.env).toBeNull()
    })

    test('stores sessionId when provided', async () => {
      const sessionId = generateUUIDv7()
      const params = { ...makeExec(SANDBOX_A, { sessionId }), seq: 1 }
      const row = await run(repo.create(params))
      expect(row.sessionId).toBeInstanceOf(Uint8Array)
    })
  })

  // -- findById -------------------------------------------------------------

  describe('findById', () => {
    test('returns created exec', async () => {
      const params = { ...makeExec(), seq: 1 }
      await run(repo.create(params))
      const row = await run(repo.findById(params.id, SANDBOX_A, ORG))
      expect(row).not.toBeNull()
      expect(row!.seq).toBe(1)
    })

    test('returns null for unknown id', async () => {
      const row = await run(repo.findById(generateUUIDv7(), SANDBOX_A, ORG))
      expect(row).toBeNull()
    })

    test('returns null when sandboxId does not match', async () => {
      const params = { ...makeExec(SANDBOX_A), seq: 1 }
      await run(repo.create(params))
      const row = await run(repo.findById(params.id, SANDBOX_B, ORG))
      expect(row).toBeNull()
    })

    test('returns null when orgId does not match', async () => {
      const params = { ...makeExec(), seq: 1 }
      await run(repo.create(params))
      const row = await run(repo.findById(params.id, SANDBOX_A, 'org_wrong'))
      expect(row).toBeNull()
    })
  })

  // -- nextSeq --------------------------------------------------------------

  describe('nextSeq', () => {
    test('returns 1 when no execs exist', async () => {
      const seq = await run(repo.nextSeq(SANDBOX_A))
      expect(seq).toBe(1)
    })

    test('returns max(seq) + 1', async () => {
      await run(repo.create({ ...makeExec(), seq: 3 }))
      await run(repo.create({ ...makeExec(), seq: 1 }))
      const seq = await run(repo.nextSeq(SANDBOX_A))
      expect(seq).toBe(4)
    })

    test('different sandboxes have independent sequences', async () => {
      await run(repo.create({ ...makeExec(SANDBOX_A), seq: 5 }))
      await run(repo.create({ ...makeExec(SANDBOX_B), seq: 2 }))

      const seqA = await run(repo.nextSeq(SANDBOX_A))
      const seqB = await run(repo.nextSeq(SANDBOX_B))
      expect(seqA).toBe(6)
      expect(seqB).toBe(3)
    })
  })

  // -- updateStatus ---------------------------------------------------------

  describe('updateStatus', () => {
    test('updates status field', async () => {
      const params = { ...makeExec(), seq: 1 }
      await run(repo.create(params))
      const updated = await run(repo.updateStatus(params.id, 'running'))
      expect(updated).not.toBeNull()
      expect(updated!.status).toBe('running')
    })

    test('applies extra fields', async () => {
      const params = { ...makeExec(), seq: 1 }
      await run(repo.create(params))
      const startedAt = new Date()
      const endedAt = new Date()
      const updated = await run(
        repo.updateStatus(params.id, 'done', {
          exitCode: 0,
          cpuMs: 100,
          peakMemoryBytes: 4096,
          durationMs: 250,
          startedAt,
          endedAt,
        }),
      )
      expect(updated!.exitCode).toBe(0)
      expect(updated!.cpuMs).toBe(100)
      expect(updated!.peakMemoryBytes).toBe(4096)
      expect(updated!.durationMs).toBe(250)
      expect(updated!.startedAt).toBeInstanceOf(Date)
      expect(updated!.endedAt).toBeInstanceOf(Date)
    })

    test('returns null for unknown exec', async () => {
      const result = await run(repo.updateStatus(generateUUIDv7(), 'running'))
      expect(result).toBeNull()
    })

    test('preserves existing fields when extra not provided', async () => {
      const params = { ...makeExec(), seq: 1 }
      await run(repo.create(params))
      await run(repo.updateStatus(params.id, 'running', { startedAt: new Date() }))
      const updated = await run(repo.updateStatus(params.id, 'done', { exitCode: 0 }))
      expect(updated!.startedAt).toBeInstanceOf(Date)
      expect(updated!.exitCode).toBe(0)
    })

    test('persists updated status on subsequent findById', async () => {
      const params = { ...makeExec(), seq: 1 }
      await run(repo.create(params))
      await run(repo.updateStatus(params.id, 'running'))
      const row = await run(repo.findById(params.id, SANDBOX_A, ORG))
      expect(row!.status).toBe('running')
    })
  })

  // -- list -----------------------------------------------------------------

  describe('list', () => {
    test('returns empty list initially', async () => {
      const result = await run(repo.list(SANDBOX_A, ORG, {}))
      expect(result.rows).toEqual([])
      expect(result.nextCursor).toBeNull()
    })

    test('returns execs for the correct sandbox', async () => {
      await run(repo.create({ ...makeExec(SANDBOX_A), seq: 1 }))
      await run(repo.create({ ...makeExec(SANDBOX_B), seq: 1 }))

      const result = await run(repo.list(SANDBOX_A, ORG, {}))
      expect(result.rows.length).toBe(1)
    })

    test('filters by status', async () => {
      const p1 = { ...makeExec(), seq: 1 }
      const p2 = { ...makeExec(), seq: 2 }
      await run(repo.create(p1))
      await run(repo.create(p2))
      await run(repo.updateStatus(p1.id, 'done', { exitCode: 0 }))

      const done = await run(repo.list(SANDBOX_A, ORG, { status: 'done' }))
      const queued = await run(repo.list(SANDBOX_A, ORG, { status: 'queued' }))
      expect(done.rows.length).toBe(1)
      expect(queued.rows.length).toBe(1)
    })

    test('filters by sessionId', async () => {
      const sessionId = generateUUIDv7()
      const p1 = { ...makeExec(SANDBOX_A, { sessionId }), seq: 1 }
      const p2 = { ...makeExec(), seq: 2 }
      await run(repo.create(p1))
      await run(repo.create(p2))

      const result = await run(repo.list(SANDBOX_A, ORG, { sessionId }))
      expect(result.rows.length).toBe(1)
    })

    test('sorts by seq ascending', async () => {
      await run(repo.create({ ...makeExec(), seq: 3 }))
      await run(repo.create({ ...makeExec(), seq: 1 }))
      await run(repo.create({ ...makeExec(), seq: 2 }))

      const result = await run(repo.list(SANDBOX_A, ORG, {}))
      expect(result.rows.length).toBe(3)
      expect(result.rows[0].seq).toBe(1)
      expect(result.rows[1].seq).toBe(2)
      expect(result.rows[2].seq).toBe(3)
    })

    test('cursor pagination', async () => {
      for (let i = 1; i <= 5; i++) {
        await run(repo.create({ ...makeExec(), seq: i }))
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
        bytesToId(EXEC_PREFIX, r.id),
      )
      expect(new Set(allIds).size).toBe(5)
    })

    test('respects orgId scoping', async () => {
      await run(repo.create({ ...makeExec(), seq: 1 }))
      const result = await run(repo.list(SANDBOX_A, 'org_wrong', {}))
      expect(result.rows).toEqual([])
    })

    test('limit capped at 200', async () => {
      const result = await run(repo.list(SANDBOX_A, ORG, { limit: 999 }))
      expect(result.rows).toEqual([])
    })
  })

  // -- deleteByOrgId --------------------------------------------------------

  describe('deleteByOrgId', () => {
    test('hard-deletes all execs for an org', async () => {
      await run(repo.create({ ...makeExec(), seq: 1 }))
      await run(repo.create({ ...makeExec(), seq: 2 }))

      const deleted = await run(repo.deleteByOrgId(ORG))
      expect(deleted).toBe(2)
    })

    test('returns 0 when org has no execs', async () => {
      const deleted = await run(repo.deleteByOrgId(ORG))
      expect(deleted).toBe(0)
    })

    test('does not delete execs from other orgs', async () => {
      await run(repo.create({ ...makeExec(), seq: 1 }))
      const otherExec = { ...makeExec(), seq: 1, orgId: 'org_other' }
      await run(repo.create(otherExec))

      await run(repo.deleteByOrgId(ORG))

      // The other org's exec should still exist by trying to find it
      const rows = await db.execute(sql`SELECT COUNT(*) as cnt FROM execs WHERE org_id = 'org_other'`)
      expect((rows[0] as { cnt: number }[])[0].cnt).toBe(1)
    })
  })
})
