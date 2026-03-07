import { Effect } from 'effect'
import { describe, expect, test } from 'bun:test'
import { generateUUIDv7 } from '@sandchest/contract'
import { createInMemorySessionRepo } from './session-repo.memory.js'
import type { SessionRepoApi } from './session-repo.js'

function run<A>(effect: Effect.Effect<A, never, never>): Promise<A> {
  return Effect.runPromise(effect)
}

function makeRepo(): SessionRepoApi {
  return createInMemorySessionRepo()
}

const ORG = 'org_session_test'
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

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe('create', () => {
  test('creates a session with status running', async () => {
    const repo = makeRepo()
    const params = makeSession()
    const row = await run(repo.create(params))
    expect(row.status).toBe('running')
    expect(row.shell).toBe('/bin/bash')
    expect(row.destroyedAt).toBeNull()
    expect(row.createdAt).toBeInstanceOf(Date)
    expect(row.updatedAt).toBeInstanceOf(Date)
  })

  test('stores custom shell', async () => {
    const repo = makeRepo()
    const params = makeSession(SANDBOX_A, '/bin/sh')
    const row = await run(repo.create(params))
    expect(row.shell).toBe('/bin/sh')
  })
})

// ---------------------------------------------------------------------------
// findById
// ---------------------------------------------------------------------------

describe('findById', () => {
  test('returns created session', async () => {
    const repo = makeRepo()
    const params = makeSession()
    await run(repo.create(params))
    const row = await run(repo.findById(params.id, SANDBOX_A, ORG))
    expect(row).not.toBeNull()
    expect(row!.status).toBe('running')
  })

  test('returns null for unknown id', async () => {
    const repo = makeRepo()
    const row = await run(repo.findById(generateUUIDv7(), SANDBOX_A, ORG))
    expect(row).toBeNull()
  })

  test('returns null when sandboxId does not match', async () => {
    const repo = makeRepo()
    const params = makeSession(SANDBOX_A)
    await run(repo.create(params))
    const row = await run(repo.findById(params.id, SANDBOX_B, ORG))
    expect(row).toBeNull()
  })

  test('returns null when orgId does not match', async () => {
    const repo = makeRepo()
    const params = makeSession()
    await run(repo.create(params))
    const row = await run(repo.findById(params.id, SANDBOX_A, 'org_wrong'))
    expect(row).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('list', () => {
  test('returns empty list initially', async () => {
    const repo = makeRepo()
    const rows = await run(repo.list(SANDBOX_A, ORG))
    expect(rows).toEqual([])
  })

  test('returns sessions for the correct sandbox', async () => {
    const repo = makeRepo()
    await run(repo.create(makeSession(SANDBOX_A)))
    await run(repo.create(makeSession(SANDBOX_B)))

    const rowsA = await run(repo.list(SANDBOX_A, ORG))
    const rowsB = await run(repo.list(SANDBOX_B, ORG))
    expect(rowsA.length).toBe(1)
    expect(rowsB.length).toBe(1)
  })

  test('includes destroyed sessions', async () => {
    const repo = makeRepo()
    const params = makeSession()
    await run(repo.create(params))
    await run(repo.destroy(params.id, SANDBOX_A, ORG))

    const rows = await run(repo.list(SANDBOX_A, ORG))
    expect(rows.length).toBe(1)
    expect(rows[0].status).toBe('destroyed')
  })

  test('respects orgId scoping', async () => {
    const repo = makeRepo()
    await run(repo.create(makeSession()))
    const rows = await run(repo.list(SANDBOX_A, 'org_wrong'))
    expect(rows).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// countActive
// ---------------------------------------------------------------------------

describe('countActive', () => {
  test('returns 0 initially', async () => {
    const repo = makeRepo()
    const count = await run(repo.countActive(SANDBOX_A))
    expect(count).toBe(0)
  })

  test('counts only running sessions', async () => {
    const repo = makeRepo()
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
    const repo = makeRepo()
    await run(repo.create(makeSession(SANDBOX_A)))
    await run(repo.create(makeSession(SANDBOX_B)))

    const countA = await run(repo.countActive(SANDBOX_A))
    const countB = await run(repo.countActive(SANDBOX_B))
    expect(countA).toBe(1)
    expect(countB).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// destroy
// ---------------------------------------------------------------------------

describe('destroy', () => {
  test('marks session as destroyed', async () => {
    const repo = makeRepo()
    const params = makeSession()
    await run(repo.create(params))
    const destroyed = await run(repo.destroy(params.id, SANDBOX_A, ORG))
    expect(destroyed).not.toBeNull()
    expect(destroyed!.status).toBe('destroyed')
    expect(destroyed!.destroyedAt).toBeInstanceOf(Date)
  })

  test('updates updatedAt', async () => {
    const repo = makeRepo()
    const params = makeSession()
    const created = await run(repo.create(params))
    await new Promise((r) => setTimeout(r, 10))
    const destroyed = await run(repo.destroy(params.id, SANDBOX_A, ORG))
    expect(destroyed!.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime())
  })

  test('returns null for unknown session', async () => {
    const repo = makeRepo()
    const result = await run(repo.destroy(generateUUIDv7(), SANDBOX_A, ORG))
    expect(result).toBeNull()
  })

  test('returns null when sandboxId does not match', async () => {
    const repo = makeRepo()
    const params = makeSession(SANDBOX_A)
    await run(repo.create(params))
    const result = await run(repo.destroy(params.id, SANDBOX_B, ORG))
    expect(result).toBeNull()
  })

  test('returns null when orgId does not match', async () => {
    const repo = makeRepo()
    const params = makeSession()
    await run(repo.create(params))
    const result = await run(repo.destroy(params.id, SANDBOX_A, 'org_wrong'))
    expect(result).toBeNull()
  })

  test('destroyed session decrements countActive', async () => {
    const repo = makeRepo()
    const p1 = makeSession()
    const p2 = makeSession()
    await run(repo.create(p1))
    await run(repo.create(p2))
    expect(await run(repo.countActive(SANDBOX_A))).toBe(2)

    await run(repo.destroy(p1.id, SANDBOX_A, ORG))
    expect(await run(repo.countActive(SANDBOX_A))).toBe(1)
  })

  test('destroyed session is still findable', async () => {
    const repo = makeRepo()
    const params = makeSession()
    await run(repo.create(params))
    await run(repo.destroy(params.id, SANDBOX_A, ORG))

    const row = await run(repo.findById(params.id, SANDBOX_A, ORG))
    expect(row).not.toBeNull()
    expect(row!.status).toBe('destroyed')
  })
})
