import { index, json, mysqlEnum, mysqlTable, varchar } from 'drizzle-orm/mysql-core'
import { createdAt, timestampMicro, uuidv7Binary } from '../columns.js'

export const sandboxSessions = mysqlTable(
  'sandbox_sessions',
  {
    id: uuidv7Binary('id').primaryKey(),
    sandboxId: uuidv7Binary('sandbox_id').notNull(),
    orgId: varchar('org_id', { length: 36 }).notNull(),
    shell: varchar('shell', { length: 255 }).notNull().default('/bin/bash'),
    status: mysqlEnum('status', ['running', 'destroyed']).notNull().default('running'),
    env: json('env'),
    createdAt: createdAt(),
    destroyedAt: timestampMicro('destroyed_at'),
  },
  (t) => [index('idx_sandbox_status').on(t.sandboxId, t.status)],
)
