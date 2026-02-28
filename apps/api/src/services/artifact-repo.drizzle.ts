import { Effect, Layer } from 'effect'
import { eq, and, gt, lt, asc, sql } from 'drizzle-orm'
import type { Database } from '@sandchest/db/client'
import { artifacts } from '@sandchest/db/schema'
import { bytesToId, idToBytes, ARTIFACT_PREFIX } from '@sandchest/contract'
import { ArtifactRepo, type ArtifactRow, type ArtifactRepoApi } from './artifact-repo.js'

/** Map a raw Drizzle row from the artifacts table to an ArtifactRow. */
function toArtifactRow(row: typeof artifacts.$inferSelect): ArtifactRow {
  return {
    id: row.id,
    sandboxId: row.sandboxId,
    orgId: row.orgId,
    execId: row.execId ?? null,
    name: row.name,
    mime: row.mime,
    bytes: row.bytes,
    sha256: row.sha256,
    ref: row.ref,
    createdAt: row.createdAt,
    retentionUntil: row.retentionUntil ?? null,
  }
}

export function createDrizzleArtifactRepo(db: Database): ArtifactRepoApi {
  async function selectByIdAndSandboxAndOrg(
    id: Uint8Array,
    sandboxId: Uint8Array,
    orgId: string,
  ): Promise<ArtifactRow | null> {
    const [row] = await db
      .select()
      .from(artifacts)
      .where(
        and(
          eq(artifacts.id, id),
          eq(artifacts.sandboxId, sandboxId),
          eq(artifacts.orgId, orgId),
        ),
      )
      .limit(1)
    return row ? toArtifactRow(row) : null
  }

  return {
    create: (params) =>
      Effect.promise(async () => {
        const now = new Date()
        await db.insert(artifacts).values({
          id: params.id,
          sandboxId: params.sandboxId,
          orgId: params.orgId,
          execId: params.execId ?? null,
          name: params.name,
          mime: params.mime,
          bytes: params.bytes,
          sha256: params.sha256,
          ref: params.ref,
          createdAt: now,
          retentionUntil: params.retentionUntil ?? null,
        })
        return (await selectByIdAndSandboxAndOrg(params.id, params.sandboxId, params.orgId))!
      }),

    findById: (id, sandboxId, orgId) =>
      Effect.promise(() => selectByIdAndSandboxAndOrg(id, sandboxId, orgId)),

    list: (sandboxId, orgId, params) =>
      Effect.promise(async () => {
        const limit = Math.min(params.limit ?? 50, 200)

        const conditions = [
          eq(artifacts.sandboxId, sandboxId),
          eq(artifacts.orgId, orgId),
        ]

        if (params.cursor) {
          const cursorBytes = idToBytes(params.cursor)
          conditions.push(gt(artifacts.id, cursorBytes))
        }

        const rows = await db
          .select()
          .from(artifacts)
          .where(and(...conditions))
          .orderBy(asc(artifacts.createdAt))
          .limit(limit + 1)

        const hasMore = rows.length > limit
        const page = hasMore ? rows.slice(0, limit) : rows
        const nextCursor =
          hasMore && page.length > 0
            ? bytesToId(ARTIFACT_PREFIX, page[page.length - 1].id)
            : null

        return { rows: page.map(toArtifactRow), nextCursor }
      }),

    count: (sandboxId, orgId) =>
      Effect.promise(async () => {
        const [result] = await db
          .select({ count: sql<number>`COUNT(*)` })
          .from(artifacts)
          .where(
            and(
              eq(artifacts.sandboxId, sandboxId),
              eq(artifacts.orgId, orgId),
            ),
          )
        return result?.count ?? 0
      }),

    findExpiredRetention: (before) =>
      Effect.promise(async () => {
        const rows = await db
          .select()
          .from(artifacts)
          .where(lt(artifacts.retentionUntil, before))
        return rows.map(toArtifactRow)
      }),

    deleteByIds: (ids) =>
      Effect.promise(async () => {
        if (ids.length === 0) return 0
        let deleted = 0
        for (const id of ids) {
          const result = await db
            .delete(artifacts)
            .where(eq(artifacts.id, id))
          deleted += (result as unknown as [{ affectedRows: number }])[0].affectedRows
        }
        return deleted
      }),

    findByOrgId: (orgId) =>
      Effect.promise(async () => {
        const rows = await db
          .select()
          .from(artifacts)
          .where(eq(artifacts.orgId, orgId))
        return rows.map(toArtifactRow)
      }),

    deleteByOrgId: (orgId) =>
      Effect.promise(async () => {
        const result = await db
          .delete(artifacts)
          .where(eq(artifacts.orgId, orgId))
        return (result as unknown as [{ affectedRows: number }])[0].affectedRows
      }),
  }
}

export const makeArtifactRepoDrizzle = (db: Database) =>
  Layer.sync(ArtifactRepo, () => createDrizzleArtifactRepo(db))
