import { Effect, Layer } from 'effect'
import { eq, and, desc } from 'drizzle-orm'
import type { Database } from '@sandchest/db/client'
import { auditLogs } from '@sandchest/db/schema'
import { generateUUIDv7 } from '@sandchest/contract'
import { AuditLog, type AuditLogApi, type AuditLogEntry, type AuditAction } from './audit-log.js'

function toAuditLogEntry(row: typeof auditLogs.$inferSelect): AuditLogEntry {
  return {
    id: row.id,
    orgId: row.orgId,
    actorId: row.actorId,
    action: row.action as AuditAction,
    resourceType: row.resourceType as AuditLogEntry['resourceType'],
    resourceId: row.resourceId,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    createdAt: row.createdAt,
  }
}

export function createDrizzleAuditLog(db: Database): AuditLogApi {
  return {
    append: (params) =>
      Effect.promise(async () => {
        await db.insert(auditLogs).values({
          id: generateUUIDv7(),
          orgId: params.orgId,
          actorId: params.actorId,
          action: params.action,
          resourceType: params.resourceType,
          resourceId: params.resourceId,
          metadata: params.metadata ? JSON.stringify(params.metadata) : null,
        })
      }),

    list: (orgId, params) =>
      Effect.promise(async () => {
        const limit = params?.limit ?? 50
        const conditions = [eq(auditLogs.orgId, orgId)]

        if (params?.action) {
          conditions.push(eq(auditLogs.action, params.action))
        }

        const rows = await db
          .select()
          .from(auditLogs)
          .where(and(...conditions))
          .orderBy(desc(auditLogs.createdAt))
          .limit(limit)

        return rows.map(toAuditLogEntry)
      }),
  }
}

export const makeAuditLogDrizzle = (db: Database) =>
  Layer.sync(AuditLog, () => createDrizzleAuditLog(db))
