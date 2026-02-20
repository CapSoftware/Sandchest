import { bigint, char, index, mysqlTable, varchar } from 'drizzle-orm/mysql-core'
import { createdAt, timestampMicro, uuidv7Binary } from '../columns'

export const artifacts = mysqlTable(
  'artifacts',
  {
    id: uuidv7Binary('id').primaryKey(),
    sandboxId: uuidv7Binary('sandbox_id').notNull(),
    orgId: varchar('org_id', { length: 36 }).notNull(),
    execId: uuidv7Binary('exec_id'),
    name: varchar('name', { length: 512 }).notNull(),
    mime: varchar('mime', { length: 255 }).notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    sha256: char('sha256', { length: 64 }).notNull(),
    ref: varchar('ref', { length: 1024 }).notNull(),
    createdAt: createdAt(),
    retentionUntil: timestampMicro('retention_until'),
  },
  (t) => [
    index('idx_sandbox_created').on(t.sandboxId, t.createdAt),
    index('idx_sandbox_name').on(t.sandboxId, t.name),
    index('idx_org_retention').on(t.orgId, t.retentionUntil),
  ],
)
