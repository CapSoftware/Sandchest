import { int, json, mysqlEnum, mysqlTable, text, varchar } from 'drizzle-orm/mysql-core'
import { createdAt, updatedAt, uuidv7Binary } from '../columns'

export const adminServers = mysqlTable('admin_servers', {
  id: uuidv7Binary('id').primaryKey(),
  nodeId: uuidv7Binary('node_id'),
  name: varchar('name', { length: 255 }).notNull(),
  ip: varchar('ip', { length: 45 }).notNull(),
  sshPort: int('ssh_port').notNull().default(22),
  sshUser: varchar('ssh_user', { length: 64 }).notNull().default('root'),
  sshKeyEncrypted: text('ssh_key_encrypted').notNull(),
  sshKeyIv: varchar('ssh_key_iv', { length: 32 }).notNull(),
  sshKeyTag: varchar('ssh_key_tag', { length: 32 }).notNull(),
  provisionStatus: mysqlEnum('provision_status', [
    'pending',
    'provisioning',
    'completed',
    'failed',
  ])
    .notNull()
    .default('pending'),
  provisionStep: varchar('provision_step', { length: 64 }),
  provisionError: text('provision_error'),
  provisionSteps: json('provision_steps').$type<
    Array<{ id: string; status: string; output?: string | undefined }>
  >(),
  slotsTotal: int('slots_total').notNull().default(4),
  systemInfo: json('system_info').$type<{
    cpu?: string | undefined
    ram?: string | undefined
    disk?: string | undefined
    os?: string | undefined
  }>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})
