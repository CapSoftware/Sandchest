import { Effect, Layer } from 'effect'
import {
  eq,
  and,
  ne,
  lt,
  lte,
  gt,
  inArray,
  isNull,
  isNotNull,
  desc,
  sql,
} from 'drizzle-orm'
import type { Database } from '@sandchest/db/client'
import { sandboxes } from '@sandchest/db/schema'
import { images } from '@sandchest/db/schema'
import { profiles } from '@sandchest/db/schema'
import {
  parseImageRef,
  buildImageUri,
  bytesToId,
  idToBytes,
  SANDBOX_PREFIX,
} from '@sandchest/contract'
import type {
  ProfileName,
  SandboxStatus,
  FailureReason,
} from '@sandchest/contract'
import { SandboxRepo, type SandboxRow, type SandboxRepoApi } from './sandbox-repo.js'

/** Map a raw Drizzle row from the sandboxes table to a SandboxRow. */
function toSandboxRow(row: typeof sandboxes.$inferSelect): SandboxRow {
  return {
    id: row.id,
    orgId: row.orgId,
    nodeId: row.nodeId,
    imageId: row.imageId,
    profileId: row.profileId,
    profileName: row.profileName as ProfileName,
    status: row.status as SandboxStatus,
    env: typeof row.env === 'string' ? JSON.parse(row.env) as Record<string, string> : (row.env as Record<string, string> | null),
    forkedFrom: row.forkedFrom,
    forkDepth: row.forkDepth,
    forkCount: row.forkCount,
    ttlSeconds: row.ttlSeconds,
    failureReason: (row.failureReason as FailureReason) ?? null,
    replayPublic: row.replayPublic,
    replayExpiresAt: row.replayExpiresAt ?? null,
    lastActivityAt: row.lastActivityAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt ?? null,
    endedAt: row.endedAt ?? null,
    imageRef: row.imageRef,
  }
}

export function createDrizzleSandboxRepo(db: Database): SandboxRepoApi {
  /** Select a single sandbox by id (no org check). */
  async function selectById(id: Uint8Array): Promise<SandboxRow | null> {
    const [row] = await db
      .select()
      .from(sandboxes)
      .where(eq(sandboxes.id, id))
      .limit(1)
    return row ? toSandboxRow(row) : null
  }

  /** Select a single sandbox by id and orgId. */
  async function selectByIdAndOrg(
    id: Uint8Array,
    orgId: string,
  ): Promise<SandboxRow | null> {
    const [row] = await db
      .select()
      .from(sandboxes)
      .where(and(eq(sandboxes.id, id), eq(sandboxes.orgId, orgId)))
      .limit(1)
    return row ? toSandboxRow(row) : null
  }

  return {
    resolveImage: (imageStr) =>
      Effect.promise(async () => {
        const parsed = parseImageRef(imageStr)
        if (!parsed) return null
        const [row] = await db
          .select({
            id: images.id,
            osVersion: images.osVersion,
            toolchain: images.toolchain,
            kernelRef: images.kernelRef,
            rootfsRef: images.rootfsRef,
          })
          .from(images)
          .where(
            and(
              eq(images.osVersion, parsed.osVersion),
              eq(images.toolchain, parsed.toolchain),
            ),
          )
          .limit(1)
        if (!row) return null
        return {
          id: row.id,
          ref: buildImageUri(row.osVersion, row.toolchain),
          kernelRef: row.kernelRef,
          rootfsRef: row.rootfsRef,
        }
      }),

    resolveProfile: (name) =>
      Effect.promise(async () => {
        const [row] = await db
          .select({
            id: profiles.id,
            cpuCores: profiles.cpuCores,
            memoryMb: profiles.memoryMb,
            diskGb: profiles.diskGb,
          })
          .from(profiles)
          .where(eq(profiles.name, name))
          .limit(1)
        return row ?? null
      }),

    create: (params) =>
      Effect.promise(async () => {
        const now = new Date()
        await db.insert(sandboxes).values({
          id: params.id,
          orgId: params.orgId,
          imageId: params.imageId,
          profileId: params.profileId,
          profileName: params.profileName,
          status: 'queued',
          env: params.env,
          ttlSeconds: params.ttlSeconds,
          imageRef: params.imageRef,
          createdAt: now,
          updatedAt: now,
        })
        return (await selectById(params.id))!
      }),

    findById: (id, orgId) =>
      Effect.promise(() => selectByIdAndOrg(id, orgId)),

    list: (orgId, params) =>
      Effect.promise(async () => {
        const limit = Math.min(params.limit ?? 50, 200)

        const conditions = [
          eq(sandboxes.orgId, orgId),
          ne(sandboxes.status, 'deleted'),
        ]

        if (params.status) {
          conditions.push(eq(sandboxes.status, params.status))
        }

        if (params.forked_from) {
          const parentBytes = idToBytes(params.forked_from)
          conditions.push(eq(sandboxes.forkedFrom, parentBytes))
        }

        // Cursor: UUIDv7 IDs are time-sorted, so id DESC == createdAt DESC
        if (params.cursor) {
          const cursorBytes = idToBytes(params.cursor)
          conditions.push(lt(sandboxes.id, cursorBytes))
        }

        // Fetch limit + 1 to determine if there's a next page
        const rows = await db
          .select()
          .from(sandboxes)
          .where(and(...conditions))
          .orderBy(desc(sandboxes.id))
          .limit(limit + 1)

        const hasMore = rows.length > limit
        const page = hasMore ? rows.slice(0, limit) : rows
        const nextCursor =
          hasMore && page.length > 0
            ? bytesToId(SANDBOX_PREFIX, page[page.length - 1].id)
            : null

        return { rows: page.map(toSandboxRow), nextCursor }
      }),

    updateStatus: (id, orgId, status, extra) =>
      Effect.promise(async () => {
        const now = new Date()
        const setClause: Record<string, unknown> = {
          status,
          updatedAt: now,
        }
        if (extra?.endedAt != null) setClause.endedAt = extra.endedAt
        if (extra?.failureReason != null) setClause.failureReason = extra.failureReason

        await db
          .update(sandboxes)
          .set(setClause)
          .where(and(eq(sandboxes.id, id), eq(sandboxes.orgId, orgId)))

        return selectByIdAndOrg(id, orgId)
      }),

    softDelete: (id, orgId) =>
      Effect.promise(async () => {
        const existing = await selectByIdAndOrg(id, orgId)
        if (!existing) return null

        const now = new Date()
        await db
          .update(sandboxes)
          .set({
            status: 'deleted',
            updatedAt: now,
            endedAt: existing.endedAt ?? now,
            failureReason: existing.failureReason ?? 'sandbox_deleted',
          })
          .where(and(eq(sandboxes.id, id), eq(sandboxes.orgId, orgId)))

        return selectByIdAndOrg(id, orgId)
      }),

    createFork: (params) =>
      Effect.promise(async () => {
        const now = new Date()
        await db.insert(sandboxes).values({
          id: params.id,
          orgId: params.orgId,
          nodeId: params.source.nodeId,
          imageId: params.source.imageId,
          profileId: params.source.profileId,
          profileName: params.source.profileName,
          status: 'running',
          env: params.env,
          forkedFrom: params.source.id,
          forkDepth: params.source.forkDepth + 1,
          forkCount: 0,
          ttlSeconds: params.ttlSeconds,
          imageRef: params.source.imageRef,
          lastActivityAt: now,
          createdAt: now,
          updatedAt: now,
          startedAt: now,
        })
        return (await selectById(params.id))!
      }),

    incrementForkCount: (id, orgId) =>
      Effect.promise(async () => {
        await db
          .update(sandboxes)
          .set({
            forkCount: sql`${sandboxes.forkCount} + 1`,
            updatedAt: new Date(),
          })
          .where(and(eq(sandboxes.id, id), eq(sandboxes.orgId, orgId)))

        return selectByIdAndOrg(id, orgId)
      }),

    getForkTree: (id, orgId) =>
      Effect.promise(async () => {
        const start = await selectByIdAndOrg(id, orgId)
        if (!start) return []

        // Walk up to find root
        let root = start
        while (root.forkedFrom) {
          const parent = await selectByIdAndOrg(root.forkedFrom, orgId)
          if (!parent) break
          root = parent
        }

        // BFS down from root
        const result: SandboxRow[] = [root]
        const queue = [root]
        while (queue.length > 0) {
          const current = queue.shift()!
          const children = await db
            .select()
            .from(sandboxes)
            .where(
              and(
                eq(sandboxes.forkedFrom, current.id),
                eq(sandboxes.orgId, orgId),
              ),
            )
          for (const child of children) {
            const mapped = toSandboxRow(child)
            result.push(mapped)
            queue.push(mapped)
          }
        }

        return result
      }),

    findByIdPublic: (id) =>
      Effect.promise(async () => {
        const [row] = await db
          .select()
          .from(sandboxes)
          .where(and(eq(sandboxes.id, id), eq(sandboxes.replayPublic, true)))
          .limit(1)
        return row ? toSandboxRow(row) : null
      }),

    setReplayPublic: (id, orgId, isPublic) =>
      Effect.promise(async () => {
        await db
          .update(sandboxes)
          .set({ replayPublic: isPublic, updatedAt: new Date() })
          .where(and(eq(sandboxes.id, id), eq(sandboxes.orgId, orgId)))

        return selectByIdAndOrg(id, orgId)
      }),

    findExpiredTtl: () =>
      Effect.promise(async () => {
        const rows = await db
          .select()
          .from(sandboxes)
          .where(
            and(
              eq(sandboxes.status, 'running'),
              isNotNull(sandboxes.startedAt),
              sql`DATE_ADD(${sandboxes.startedAt}, INTERVAL ${sandboxes.ttlSeconds} SECOND) < NOW(6)`,
            ),
          )
        return rows.map(toSandboxRow)
      }),

    findNearTtlExpiry: (warningThresholdSeconds) =>
      Effect.promise(async () => {
        const rows = await db
          .select()
          .from(sandboxes)
          .where(
            and(
              eq(sandboxes.status, 'running'),
              isNotNull(sandboxes.startedAt),
              // Warning threshold reached: started_at + (ttl - warning) <= NOW()
              sql`DATE_ADD(${sandboxes.startedAt}, INTERVAL (${sandboxes.ttlSeconds} - ${warningThresholdSeconds}) SECOND) <= NOW(6)`,
              // Not yet expired: started_at + ttl > NOW()
              sql`DATE_ADD(${sandboxes.startedAt}, INTERVAL ${sandboxes.ttlSeconds} SECOND) > NOW(6)`,
            ),
          )
        return rows.map(toSandboxRow)
      }),

    findIdleSince: (cutoff) =>
      Effect.promise(async () => {
        const rows = await db
          .select()
          .from(sandboxes)
          .where(
            and(
              eq(sandboxes.status, 'running'),
              sql`COALESCE(${sandboxes.lastActivityAt}, ${sandboxes.startedAt}, ${sandboxes.createdAt}) < ${cutoff}`,
            ),
          )
        return rows.map(toSandboxRow)
      }),

    findQueuedBefore: (cutoff) =>
      Effect.promise(async () => {
        const rows = await db
          .select()
          .from(sandboxes)
          .where(
            and(
              eq(sandboxes.status, 'queued'),
              lt(sandboxes.createdAt, cutoff),
            ),
          )
        return rows.map(toSandboxRow)
      }),

    getActiveNodeIds: () =>
      Effect.promise(async () => {
        const rows = await db
          .selectDistinct({ nodeId: sandboxes.nodeId })
          .from(sandboxes)
          .where(
            and(
              eq(sandboxes.status, 'running'),
              isNotNull(sandboxes.nodeId),
            ),
          )
        return rows
          .filter((r): r is { nodeId: Uint8Array } => r.nodeId !== null)
          .map((r) => r.nodeId)
      }),

    findRunningOnNodes: (nodeIds) =>
      Effect.promise(async () => {
        if (nodeIds.length === 0) return []
        const rows = await db
          .select()
          .from(sandboxes)
          .where(
            and(
              eq(sandboxes.status, 'running'),
              inArray(sandboxes.nodeId, nodeIds),
            ),
          )
        return rows.map(toSandboxRow)
      }),

    assignNode: (id, orgId, nodeId) =>
      Effect.promise(async () => {
        const now = new Date()
        await db
          .update(sandboxes)
          .set({
            nodeId,
            status: 'running',
            startedAt: now,
            lastActivityAt: now,
            updatedAt: now,
          })
          .where(and(eq(sandboxes.id, id), eq(sandboxes.orgId, orgId)))

        return selectByIdAndOrg(id, orgId)
      }),

    countActive: (orgId) =>
      Effect.promise(async () => {
        const active: SandboxStatus[] = ['queued', 'provisioning', 'running']
        const [result] = await db
          .select({ count: sql<number>`COUNT(*)` })
          .from(sandboxes)
          .where(
            and(
              eq(sandboxes.orgId, orgId),
              inArray(sandboxes.status, active),
            ),
          )
        return result?.count ?? 0
      }),

    findMissingReplayExpiry: () =>
      Effect.promise(async () => {
        const terminal: SandboxStatus[] = ['stopped', 'failed']
        const rows = await db
          .select()
          .from(sandboxes)
          .where(
            and(
              inArray(sandboxes.status, terminal),
              isNotNull(sandboxes.endedAt),
              isNull(sandboxes.replayExpiresAt),
            ),
          )
        return rows.map(toSandboxRow)
      }),

    setReplayExpiresAt: (id, expiresAt) =>
      Effect.promise(async () => {
        await db
          .update(sandboxes)
          .set({ replayExpiresAt: expiresAt, updatedAt: new Date() })
          .where(eq(sandboxes.id, id))
      }),

    findPurgableReplays: (cutoff, minDate) =>
      Effect.promise(async () => {
        const rows = await db
          .select()
          .from(sandboxes)
          .where(
            and(
              isNotNull(sandboxes.replayExpiresAt),
              gt(sandboxes.replayExpiresAt, minDate),
              lte(sandboxes.replayExpiresAt, cutoff),
            ),
          )
        return rows.map(toSandboxRow)
      }),

    deleteByOrgId: (orgId) =>
      Effect.promise(async () => {
        const result = await db
          .delete(sandboxes)
          .where(eq(sandboxes.orgId, orgId))
        // mysql2 returns [ResultSetHeader, ...] where ResultSetHeader has affectedRows
        return (result as unknown as [{ affectedRows: number }])[0]
          .affectedRows
      }),

    touchLastActivity: (id, orgId) =>
      Effect.promise(async () => {
        const now = new Date()
        await db
          .update(sandboxes)
          .set({ lastActivityAt: now, updatedAt: now })
          .where(
            and(
              eq(sandboxes.id, id),
              eq(sandboxes.orgId, orgId),
              eq(sandboxes.status, 'running'),
            ),
          )
      }),
  }
}

export const makeSandboxRepoDrizzle = (db: Database) =>
  Layer.sync(SandboxRepo, () => createDrizzleSandboxRepo(db))
