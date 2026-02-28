import { Effect, Layer } from 'effect'
import { eq, sql } from 'drizzle-orm'
import type { Database } from '@sandchest/db/client'
import { orgQuotas } from '@sandchest/db/schema'
import { orgUsage } from '@sandchest/db/schema'
import { OrgRepo, type OrgRepoApi, type OrgRow } from './org-repo.js'

export function createDrizzleOrgRepo(db: Database): OrgRepoApi {
  return {
    findSoftDeletedBefore: (cutoff) =>
      Effect.promise(async () => {
        const rows = await db.execute(
          sql`SELECT id, deletedAt FROM organization WHERE deletedAt IS NOT NULL AND deletedAt < ${cutoff}`,
        )
        return (rows as unknown as [Array<{ id: string; deletedAt: Date }>])[0].map(
          (row) => ({
            id: row.id,
            deletedAt: row.deletedAt instanceof Date ? row.deletedAt : new Date(row.deletedAt),
          } satisfies OrgRow),
        )
      }),

    deleteQuota: (orgId) =>
      Effect.promise(async () => {
        const result = await db
          .delete(orgQuotas)
          .where(eq(orgQuotas.orgId, orgId))
        return (result as unknown as [{ affectedRows: number }])[0].affectedRows
      }),

    deleteUsage: (orgId) =>
      Effect.promise(async () => {
        const result = await db
          .delete(orgUsage)
          .where(eq(orgUsage.orgId, orgId))
        return (result as unknown as [{ affectedRows: number }])[0].affectedRows
      }),

    deleteOrg: (orgId) =>
      Effect.promise(async () => {
        await db.execute(
          sql`DELETE FROM organization WHERE id = ${orgId}`,
        )
      }),
  }
}

export const makeOrgRepoDrizzle = (db: Database) =>
  Layer.sync(OrgRepo, () => createDrizzleOrgRepo(db))
