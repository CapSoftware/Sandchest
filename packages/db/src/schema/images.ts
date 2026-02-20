import { bigint, char, mysqlTable, uniqueIndex, varchar } from 'drizzle-orm/mysql-core'
import { createdAt, timestampMicro, updatedAt, uuidv7Binary } from '../columns'

export const images = mysqlTable(
  'images',
  {
    id: uuidv7Binary('id').primaryKey(),
    osVersion: varchar('os_version', { length: 64 }).notNull(),
    toolchain: varchar('toolchain', { length: 64 }).notNull(),
    kernelRef: varchar('kernel_ref', { length: 1024 }).notNull(),
    rootfsRef: varchar('rootfs_ref', { length: 1024 }).notNull(),
    snapshotRef: varchar('snapshot_ref', { length: 1024 }),
    digest: char('digest', { length: 64 }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deprecatedAt: timestampMicro('deprecated_at'),
  },
  (t) => [uniqueIndex('uk_image').on(t.osVersion, t.toolchain)],
)
