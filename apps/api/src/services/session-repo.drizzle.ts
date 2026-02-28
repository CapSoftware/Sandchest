import { Effect, Layer } from 'effect'
import { eq, and, sql } from 'drizzle-orm'
import type { Database } from '@sandchest/db/client'
import { sandboxSessions } from '@sandchest/db/schema'
import type { SessionStatus } from '@sandchest/contract'
import { SessionRepo, type SessionRow, type SessionRepoApi } from './session-repo.js'

/**
 * Map a raw Drizzle row from the sandbox_sessions table to a SessionRow.
 * Note: the DB schema lacks an `updated_at` column — synthesize from
 * `destroyed_at` (if set) or fall back to `created_at`.
 */
function toSessionRow(row: typeof sandboxSessions.$inferSelect): SessionRow {
  return {
    id: row.id,
    sandboxId: row.sandboxId,
    orgId: row.orgId,
    shell: row.shell,
    status: row.status as SessionStatus,
    createdAt: row.createdAt,
    updatedAt: row.destroyedAt ?? row.createdAt,
    destroyedAt: row.destroyedAt ?? null,
  }
}

export function createDrizzleSessionRepo(db: Database): SessionRepoApi {
  async function selectByIdAndSandboxAndOrg(
    id: Uint8Array,
    sandboxId: Uint8Array,
    orgId: string,
  ): Promise<SessionRow | null> {
    const [row] = await db
      .select()
      .from(sandboxSessions)
      .where(
        and(
          eq(sandboxSessions.id, id),
          eq(sandboxSessions.sandboxId, sandboxId),
          eq(sandboxSessions.orgId, orgId),
        ),
      )
      .limit(1)
    return row ? toSessionRow(row) : null
  }

  return {
    create: (params) =>
      Effect.promise(async () => {
        const now = new Date()
        await db.insert(sandboxSessions).values({
          id: params.id,
          sandboxId: params.sandboxId,
          orgId: params.orgId,
          shell: params.shell,
          status: 'running',
          createdAt: now,
        })
        return (await selectByIdAndSandboxAndOrg(params.id, params.sandboxId, params.orgId))!
      }),

    findById: (id, sandboxId, orgId) =>
      Effect.promise(() => selectByIdAndSandboxAndOrg(id, sandboxId, orgId)),

    list: (sandboxId, orgId) =>
      Effect.promise(async () => {
        const rows = await db
          .select()
          .from(sandboxSessions)
          .where(
            and(
              eq(sandboxSessions.sandboxId, sandboxId),
              eq(sandboxSessions.orgId, orgId),
            ),
          )
        return rows.map(toSessionRow)
      }),

    countActive: (sandboxId) =>
      Effect.promise(async () => {
        const [result] = await db
          .select({ count: sql<number>`COUNT(*)` })
          .from(sandboxSessions)
          .where(
            and(
              eq(sandboxSessions.sandboxId, sandboxId),
              eq(sandboxSessions.status, 'running'),
            ),
          )
        return result?.count ?? 0
      }),

    destroy: (id, sandboxId, orgId) =>
      Effect.promise(async () => {
        const existing = await selectByIdAndSandboxAndOrg(id, sandboxId, orgId)
        if (!existing) return null

        const now = new Date()
        await db
          .update(sandboxSessions)
          .set({
            status: 'destroyed',
            destroyedAt: now,
          })
          .where(
            and(
              eq(sandboxSessions.id, id),
              eq(sandboxSessions.sandboxId, sandboxId),
              eq(sandboxSessions.orgId, orgId),
            ),
          )

        return selectByIdAndSandboxAndOrg(id, sandboxId, orgId)
      }),

    deleteByOrgId: (orgId) =>
      Effect.promise(async () => {
        const result = await db
          .delete(sandboxSessions)
          .where(eq(sandboxSessions.orgId, orgId))
        return (result as unknown as [{ affectedRows: number }])[0]
          .affectedRows
      }),
  }
}

export const makeSessionRepoDrizzle = (db: Database) =>
  Layer.sync(SessionRepo, () => createDrizzleSessionRepo(db))
