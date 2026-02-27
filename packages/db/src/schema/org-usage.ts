import { bigint, mysqlTable, primaryKey, varchar } from 'drizzle-orm/mysql-core'
import { createdAt, timestampMicro, updatedAt } from '../columns.js'

/**
 * Daily usage rollup per org. Composite PK of (org_id, period_start) gives
 * one row per org per UTC day. Counters are incremented atomically via
 * INSERT ... ON DUPLICATE KEY UPDATE.
 */
export const orgUsage = mysqlTable(
  'org_usage',
  {
    orgId: varchar('org_id', { length: 36 }).notNull(),
    periodStart: timestampMicro('period_start').notNull(),
    sandboxMinutes: bigint('sandbox_minutes', { mode: 'number' }).notNull().default(0),
    execCount: bigint('exec_count', { mode: 'number' }).notNull().default(0),
    storageBytes: bigint('storage_bytes', { mode: 'number' }).notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.periodStart] })],
)
