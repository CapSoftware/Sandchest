import { int, mysqlTable, smallint, varchar } from 'drizzle-orm/mysql-core'
import { createdAt, updatedAt, uuidv7Binary } from '../columns'

export const profiles = mysqlTable('profiles', {
  id: uuidv7Binary('id').primaryKey(),
  name: varchar('name', { length: 32 }).notNull().unique(),
  cpuCores: smallint('cpu_cores').notNull(),
  memoryMb: int('memory_mb').notNull(),
  diskGb: int('disk_gb').notNull(),
  description: varchar('description', { length: 255 }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})
