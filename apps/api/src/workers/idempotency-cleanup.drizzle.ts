import { Effect, Layer } from 'effect'
import { eq, lt } from 'drizzle-orm'
import type { Database } from '@sandchest/db/client'
import { idempotencyKeys } from '@sandchest/db/schema'
import { IdempotencyRepo, type IdempotencyRepoApi } from './idempotency-cleanup.js'

export function createDrizzleIdempotencyRepo(db: Database): IdempotencyRepoApi {
  return {
    deleteOlderThan: (cutoff) =>
      Effect.promise(async () => {
        const result = await db
          .delete(idempotencyKeys)
          .where(lt(idempotencyKeys.createdAt, cutoff))
        return (result as unknown as [{ affectedRows: number }])[0].affectedRows
      }),

    deleteByOrgId: (orgId) =>
      Effect.promise(async () => {
        const result = await db
          .delete(idempotencyKeys)
          .where(eq(idempotencyKeys.orgId, orgId))
        return (result as unknown as [{ affectedRows: number }])[0].affectedRows
      }),
  }
}

export const makeIdempotencyRepoDrizzle = (db: Database) =>
  Layer.sync(IdempotencyRepo, () => createDrizzleIdempotencyRepo(db))
