import { Effect, Layer } from 'effect'
import { eq, and, asc, gt, sql } from 'drizzle-orm'
import type { Database } from '@sandchest/db/client'
import { execs } from '@sandchest/db/schema'
import { bytesToId, idToBytes, EXEC_PREFIX } from '@sandchest/contract'
import type { ExecStatus } from '@sandchest/contract'
import { ExecRepo, type ExecRow, type ExecRepoApi } from './exec-repo.js'

/** Map a raw Drizzle row from the execs table to an ExecRow. */
function toExecRow(row: typeof execs.$inferSelect): ExecRow {
  return {
    id: row.id,
    sandboxId: row.sandboxId,
    orgId: row.orgId,
    sessionId: row.sessionId ?? null,
    seq: row.seq,
    cmd: row.cmd,
    cmdFormat: row.cmdFormat as 'array' | 'shell',
    cwd: row.cwd ?? null,
    env:
      typeof row.env === 'string'
        ? (JSON.parse(row.env) as Record<string, string>)
        : (row.env as Record<string, string> | null),
    status: row.status as ExecStatus,
    exitCode: row.exitCode ?? null,
    cpuMs: row.cpuMs ?? null,
    peakMemoryBytes: row.peakMemoryBytes ?? null,
    durationMs: row.durationMs ?? null,
    logRef: row.logRef ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt ?? null,
    endedAt: row.endedAt ?? null,
  }
}

export function createDrizzleExecRepo(db: Database): ExecRepoApi {
  async function selectById(id: Uint8Array): Promise<ExecRow | null> {
    const [row] = await db
      .select()
      .from(execs)
      .where(eq(execs.id, id))
      .limit(1)
    return row ? toExecRow(row) : null
  }

  async function selectByIdAndSandboxAndOrg(
    id: Uint8Array,
    sandboxId: Uint8Array,
    orgId: string,
  ): Promise<ExecRow | null> {
    const [row] = await db
      .select()
      .from(execs)
      .where(
        and(eq(execs.id, id), eq(execs.sandboxId, sandboxId), eq(execs.orgId, orgId)),
      )
      .limit(1)
    return row ? toExecRow(row) : null
  }

  return {
    create: (params) =>
      Effect.promise(async () => {
        const now = new Date()
        await db.insert(execs).values({
          id: params.id,
          sandboxId: params.sandboxId,
          orgId: params.orgId,
          sessionId: params.sessionId ?? null,
          seq: params.seq,
          cmd: params.cmd,
          cmdFormat: params.cmdFormat,
          cwd: params.cwd ?? null,
          env: params.env ?? null,
          status: 'queued',
          createdAt: now,
          updatedAt: now,
        })
        return (await selectById(params.id))!
      }),

    findById: (id, sandboxId, orgId) =>
      Effect.promise(() => selectByIdAndSandboxAndOrg(id, sandboxId, orgId)),

    list: (sandboxId, orgId, params) =>
      Effect.promise(async () => {
        const limit = Math.min(params.limit ?? 50, 200)

        const conditions = [
          eq(execs.sandboxId, sandboxId),
          eq(execs.orgId, orgId),
        ]

        if (params.status) {
          conditions.push(eq(execs.status, params.status))
        }

        if (params.sessionId) {
          conditions.push(eq(execs.sessionId, params.sessionId))
        }

        // Cursor: find the seq of the cursor exec, then filter seq > cursorSeq
        if (params.cursor) {
          const cursorBytes = idToBytes(params.cursor)
          const [cursorRow] = await db
            .select({ seq: execs.seq })
            .from(execs)
            .where(eq(execs.id, cursorBytes))
            .limit(1)
          if (cursorRow) {
            conditions.push(gt(execs.seq, cursorRow.seq))
          }
        }

        const rows = await db
          .select()
          .from(execs)
          .where(and(...conditions))
          .orderBy(asc(execs.seq))
          .limit(limit + 1)

        const hasMore = rows.length > limit
        const page = hasMore ? rows.slice(0, limit) : rows
        const nextCursor =
          hasMore && page.length > 0
            ? bytesToId(EXEC_PREFIX, page[page.length - 1].id)
            : null

        return { rows: page.map(toExecRow), nextCursor }
      }),

    updateStatus: (id, status, extra) =>
      Effect.promise(async () => {
        const now = new Date()
        const setClause: Record<string, unknown> = {
          status,
          updatedAt: now,
        }
        if (extra?.exitCode != null) setClause.exitCode = extra.exitCode
        if (extra?.cpuMs != null) setClause.cpuMs = extra.cpuMs
        if (extra?.peakMemoryBytes != null) setClause.peakMemoryBytes = extra.peakMemoryBytes
        if (extra?.durationMs != null) setClause.durationMs = extra.durationMs
        if (extra?.startedAt != null) setClause.startedAt = extra.startedAt
        if (extra?.endedAt != null) setClause.endedAt = extra.endedAt

        await db
          .update(execs)
          .set(setClause)
          .where(eq(execs.id, id))

        return selectById(id)
      }),

    nextSeq: (sandboxId) =>
      Effect.promise(async () => {
        const [result] = await db
          .select({ maxSeq: sql<number>`COALESCE(MAX(${execs.seq}), 0)` })
          .from(execs)
          .where(eq(execs.sandboxId, sandboxId))
        return (result?.maxSeq ?? 0) + 1
      }),

    deleteByOrgId: (orgId) =>
      Effect.promise(async () => {
        const result = await db
          .delete(execs)
          .where(eq(execs.orgId, orgId))
        return (result as unknown as [{ affectedRows: number }])[0]
          .affectedRows
      }),
  }
}

export const makeExecRepoDrizzle = (db: Database) =>
  Layer.sync(ExecRepo, () => createDrizzleExecRepo(db))
