import { describe, test, expect } from 'bun:test'
import { Effect, Layer, Scope, Exit } from 'effect'
import { createDatabase, type Database } from '@sandchest/db/client'
import { makeSandboxRepoDrizzle } from './services/sandbox-repo.drizzle.js'
import { makeExecRepoDrizzle } from './services/exec-repo.drizzle.js'
import { makeSessionRepoDrizzle } from './services/session-repo.drizzle.js'
import { makeArtifactRepoDrizzle } from './services/artifact-repo.drizzle.js'
import { makeOrgRepoDrizzle } from './services/org-repo.drizzle.js'
import { makeNodeRepoDrizzle } from './services/node-repo.drizzle.js'
import { makeAuditLogDrizzle } from './services/audit-log.drizzle.js'
import { makeQuotaDrizzle } from './services/quota.drizzle.js'
import { makeUsageDrizzle } from './services/usage.drizzle.js'
import { makeMetricsRepoDrizzle } from './services/metrics-repo.drizzle.js'
import { makeIdempotencyRepoDrizzle } from './workers/idempotency-cleanup.drizzle.js'
import { SandboxRepo } from './services/sandbox-repo.js'
import { ExecRepo } from './services/exec-repo.js'
import { SessionRepo } from './services/session-repo.js'
import { ArtifactRepo } from './services/artifact-repo.js'
import { OrgRepo } from './services/org-repo.js'
import { NodeRepo } from './services/node-repo.js'
import { AuditLog } from './services/audit-log.js'
import { QuotaService } from './services/quota.js'
import { UsageService } from './services/usage.js'
import { MetricsRepo } from './services/metrics-repo.js'
import { IdempotencyRepo } from './workers/idempotency-cleanup.js'

// ---------------------------------------------------------------------------
// Module exports: all make*Drizzle factories exist and are callable
// ---------------------------------------------------------------------------

describe('Drizzle layer factories', () => {
  const factories = [
    ['makeSandboxRepoDrizzle', makeSandboxRepoDrizzle],
    ['makeExecRepoDrizzle', makeExecRepoDrizzle],
    ['makeSessionRepoDrizzle', makeSessionRepoDrizzle],
    ['makeArtifactRepoDrizzle', makeArtifactRepoDrizzle],
    ['makeOrgRepoDrizzle', makeOrgRepoDrizzle],
    ['makeNodeRepoDrizzle', makeNodeRepoDrizzle],
    ['makeAuditLogDrizzle', makeAuditLogDrizzle],
    ['makeQuotaDrizzle', makeQuotaDrizzle],
    ['makeUsageDrizzle', makeUsageDrizzle],
    ['makeMetricsRepoDrizzle', makeMetricsRepoDrizzle],
    ['makeIdempotencyRepoDrizzle', makeIdempotencyRepoDrizzle],
  ] as const

  for (const [name, factory] of factories) {
    test(`${name} is a function`, () => {
      expect(typeof factory).toBe('function')
    })
  }
})

// ---------------------------------------------------------------------------
// Integration: compose all Drizzle layers and resolve services
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL

describe.skipIf(!DATABASE_URL)('Drizzle layer composition (integration)', () => {
  let db: Database

  function run<A>(effect: Effect.Effect<A, never, never>): Promise<A> {
    return Effect.runPromise(effect)
  }

  test('all Drizzle layers compose into a single layer providing all repo services', async () => {
    db = createDatabase(DATABASE_URL!)

    const composed = Layer.mergeAll(
      makeSandboxRepoDrizzle(db),
      makeExecRepoDrizzle(db),
      makeSessionRepoDrizzle(db),
      makeArtifactRepoDrizzle(db),
      makeOrgRepoDrizzle(db),
      makeNodeRepoDrizzle(db),
      makeAuditLogDrizzle(db),
      makeQuotaDrizzle(db),
      makeUsageDrizzle(db),
      makeMetricsRepoDrizzle(db),
      makeIdempotencyRepoDrizzle(db),
    )

    const scope = Effect.runSync(Scope.make())

    try {
      const context = await Effect.runPromise(
        Layer.buildWithScope(composed, scope),
      )

      // Verify all services are present in the built context
      expect(context.pipe(Effect.provideService as never)).toBeDefined()

      // Resolve each service from the context to confirm the layer provided it
      const sandbox = await run(
        SandboxRepo.pipe(Effect.provide(Layer.succeedContext(context))),
      )
      expect(sandbox).toBeDefined()
      expect(typeof sandbox.create).toBe('function')
      expect(typeof sandbox.findById).toBe('function')
      expect(typeof sandbox.list).toBe('function')

      const exec = await run(
        ExecRepo.pipe(Effect.provide(Layer.succeedContext(context))),
      )
      expect(exec).toBeDefined()
      expect(typeof exec.create).toBe('function')

      const session = await run(
        SessionRepo.pipe(Effect.provide(Layer.succeedContext(context))),
      )
      expect(session).toBeDefined()
      expect(typeof session.create).toBe('function')

      const artifact = await run(
        ArtifactRepo.pipe(Effect.provide(Layer.succeedContext(context))),
      )
      expect(artifact).toBeDefined()
      expect(typeof artifact.create).toBe('function')

      const org = await run(
        OrgRepo.pipe(Effect.provide(Layer.succeedContext(context))),
      )
      expect(org).toBeDefined()
      expect(typeof org.findSoftDeletedBefore).toBe('function')

      const node = await run(
        NodeRepo.pipe(Effect.provide(Layer.succeedContext(context))),
      )
      expect(node).toBeDefined()
      expect(typeof node.list).toBe('function')

      const audit = await run(
        AuditLog.pipe(Effect.provide(Layer.succeedContext(context))),
      )
      expect(audit).toBeDefined()
      expect(typeof audit.append).toBe('function')

      const quota = await run(
        QuotaService.pipe(Effect.provide(Layer.succeedContext(context))),
      )
      expect(quota).toBeDefined()
      expect(typeof quota.getOrgQuota).toBe('function')

      const usage = await run(
        UsageService.pipe(Effect.provide(Layer.succeedContext(context))),
      )
      expect(usage).toBeDefined()
      expect(typeof usage.recordExec).toBe('function')

      const metrics = await run(
        MetricsRepo.pipe(Effect.provide(Layer.succeedContext(context))),
      )
      expect(metrics).toBeDefined()
      expect(typeof metrics.insert).toBe('function')

      const idempotency = await run(
        IdempotencyRepo.pipe(Effect.provide(Layer.succeedContext(context))),
      )
      expect(idempotency).toBeDefined()
      expect(typeof idempotency.deleteOlderThan).toBe('function')
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      // @ts-expect-error accessing pool for cleanup
      await db?._.pool?.end?.()
    }
  })
})
