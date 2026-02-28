import { Effect, Layer } from 'effect'
import { eq, and, sql } from 'drizzle-orm'
import type { Database } from '@sandchest/db/client'
import { nodes } from '@sandchest/db/schema'
import { sandboxes } from '@sandchest/db/schema'
import { NodeRepo, type NodeRow, type NodeRepoApi } from './node-repo.js'

/** Map a raw Drizzle row from the nodes table to a NodeRow. */
function toNodeRow(row: typeof nodes.$inferSelect): NodeRow {
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    slotsTotal: row.slotsTotal,
    status: row.status as NodeRow['status'],
    version: row.version ?? null,
    firecrackerVersion: row.firecrackerVersion ?? null,
    capabilities: row.capabilities ?? null,
    lastSeenAt: row.lastSeenAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function createDrizzleNodeRepo(db: Database): NodeRepoApi {
  async function selectById(id: Uint8Array): Promise<NodeRow | null> {
    const [row] = await db
      .select()
      .from(nodes)
      .where(eq(nodes.id, id))
      .limit(1)
    return row ? toNodeRow(row) : null
  }

  return {
    list: () =>
      Effect.promise(async () => {
        const rows = await db.select().from(nodes)
        return rows.map(toNodeRow)
      }),

    findById: (id) =>
      Effect.promise(() => selectById(id)),

    create: (params) =>
      Effect.promise(async () => {
        const now = new Date()
        await db.insert(nodes).values({
          id: params.id,
          name: params.name,
          hostname: params.hostname,
          slotsTotal: params.slotsTotal,
          status: params.status,
          version: params.version,
          firecrackerVersion: params.firecrackerVersion,
          createdAt: now,
          updatedAt: now,
        })
      }),

    update: (id, fields) =>
      Effect.promise(async () => {
        const setClause: Record<string, unknown> = {
          updatedAt: new Date(),
        }
        if (fields.status !== undefined) setClause.status = fields.status
        if (fields.slotsTotal !== undefined) setClause.slotsTotal = fields.slotsTotal
        if (fields.version !== undefined) setClause.version = fields.version
        if (fields.firecrackerVersion !== undefined) setClause.firecrackerVersion = fields.firecrackerVersion

        await db
          .update(nodes)
          .set(setClause)
          .where(eq(nodes.id, id))
      }),

    remove: (id) =>
      Effect.promise(async () => {
        await db.delete(nodes).where(eq(nodes.id, id))
      }),

    countActiveSandboxes: (nodeId) =>
      Effect.promise(async () => {
        const [result] = await db
          .select({ count: sql<number>`COUNT(*)` })
          .from(sandboxes)
          .where(
            and(
              eq(sandboxes.nodeId, nodeId),
              eq(sandboxes.status, 'running'),
            ),
          )
        return result?.count ?? 0
      }),

    touchLastSeen: (id) =>
      Effect.promise(async () => {
        const now = new Date()
        await db
          .update(nodes)
          .set({ lastSeenAt: now, updatedAt: now })
          .where(eq(nodes.id, id))
      }),
  }
}

export const makeNodeRepoDrizzle = (db: Database) =>
  Layer.sync(NodeRepo, () => createDrizzleNodeRepo(db))
