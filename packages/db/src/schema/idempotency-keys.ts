import { index, int, mediumtext, mysqlEnum, mysqlTable, varchar } from 'drizzle-orm/mysql-core'
import { createdAt } from '../columns.js'

export const idempotencyKeys = mysqlTable(
  'idempotency_keys',
  {
    idemKey: varchar('idem_key', { length: 64 }).primaryKey(),
    orgId: varchar('org_id', { length: 36 }).notNull(),
    status: mysqlEnum('status', ['processing', 'completed']).notNull().default('processing'),
    responseStatus: int('response_status'),
    responseBody: mediumtext('response_body'),
    createdAt: createdAt(),
  },
  (t) => [index('idx_org').on(t.orgId), index('idx_created_at').on(t.createdAt)],
)
