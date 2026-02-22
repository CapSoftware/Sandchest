import { Effect, Layer } from 'effect'
import { generateUUIDv7 } from '@sandchest/contract'
import { AuditLog, type AuditLogApi, type AuditLogEntry } from './audit-log.js'

export function createInMemoryAuditLog(): AuditLogApi {
  const store: AuditLogEntry[] = []

  return {
    append: (params) =>
      Effect.sync(() => {
        const entry: AuditLogEntry = {
          id: generateUUIDv7(),
          orgId: params.orgId,
          actorId: params.actorId,
          action: params.action,
          resourceType: params.resourceType,
          resourceId: params.resourceId,
          metadata: params.metadata ?? null,
          createdAt: new Date(),
        }
        store.push(entry)
      }),

    list: (orgId, params) =>
      Effect.sync(() => {
        const limit = params?.limit ?? 50
        let entries = store
          .filter((e) => e.orgId === orgId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

        if (params?.action) {
          entries = entries.filter((e) => e.action === params.action)
        }

        return entries.slice(0, limit)
      }),
  }
}

export const AuditLogMemory = Layer.sync(AuditLog, createInMemoryAuditLog)
