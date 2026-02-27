import { index, json, mysqlEnum, mysqlTable, smallint, varchar } from 'drizzle-orm/mysql-core'
import { createdAt, timestampMicro, updatedAt, uuidv7Binary } from '../columns.js'

export const nodes = mysqlTable(
  'nodes',
  {
    id: uuidv7Binary('id').primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    hostname: varchar('hostname', { length: 255 }).notNull(),
    slotsTotal: smallint('slots_total').notNull().default(4),
    status: mysqlEnum('status', ['online', 'offline', 'draining', 'disabled'])
      .notNull()
      .default('offline'),
    version: varchar('version', { length: 64 }),
    firecrackerVersion: varchar('firecracker_version', { length: 64 }),
    capabilities: json('capabilities'),
    lastSeenAt: timestampMicro('last_seen_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('idx_status').on(t.status)],
)
