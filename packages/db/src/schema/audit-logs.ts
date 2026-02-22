import { index, mysqlTable, text, varchar } from 'drizzle-orm/mysql-core'
import { createdAt, uuidv7Binary } from '../columns'

export const auditLogs = mysqlTable(
  'audit_logs',
  {
    id: uuidv7Binary('id').primaryKey(),
    orgId: varchar('org_id', { length: 36 }).notNull(),
    actorId: varchar('actor_id', { length: 36 }).notNull(),
    action: varchar('action', { length: 64 }).notNull(),
    resourceType: varchar('resource_type', { length: 32 }).notNull(),
    resourceId: varchar('resource_id', { length: 64 }).notNull(),
    metadata: text('metadata'),
    createdAt: createdAt(),
  },
  (t) => [
    index('idx_org_created').on(t.orgId, t.createdAt),
    index('idx_org_action').on(t.orgId, t.action, t.createdAt),
    index('idx_org_resource').on(t.orgId, t.resourceType, t.resourceId),
  ],
)
